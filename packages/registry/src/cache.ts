import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normalizeCandidate, type NormalizedCandidate } from "./normalize.js";
import type { RawCandidate } from "./probe.js";
import { classifyTrust, detectDrift, isOfficialPublisher } from "./trust.js";
import { GithubProbeError, probeGithub } from "./probe-github.js";
import {
  PackageProbeError,
  probePackage,
  type PackageProbeResult,
} from "./probe-package.js";
import { probeSkillsSh, SkillsShProbeError } from "./probe-skills-sh.js";
import {
  buildSnapshot,
  parseSnapshot,
  type RegistrySnapshot,
  type SnapshotEntry,
} from "./snapshot.js";
import { httpGetText, NotModified, SourceHttpError, type SourceFetch } from "./sources/http.js";
import {
  DEFAULT_SKILL_QUERIES,
  fetchSkillsSh,
  SKILLS_SH_ID,
  SKILLS_SH_URL,
} from "./sources/skills-sh.js";
import {
  fetchMcpRegistry,
  MCP_REGISTRY_ID,
  MCP_REGISTRY_URL,
} from "./sources/mcp-registry.js";
import {
  fetchGithub,
  GITHUB_ID,
  GITHUB_TOPIC_QUERIES,
  GITHUB_URL,
} from "./sources/github.js";
import {
  fetchAwesomeLists,
  AWESOME_LISTS_ID,
  AWESOME_LISTS_URL,
} from "./sources/awesome-lists.js";

export const CACHE_DIR_ENV = "PLUGIN_DETECTOR_CACHE_DIR";
export const SNAPSHOT_FILENAME = "registry-snapshot.json";
export const MANIFEST_FILENAME = "registry-manifest.json";
// Profile-derived terms are a discovery aid, never an evidence source. Cap
// them so one profile cannot blow up the source query plan.
export const MAX_EXTRA_QUERIES = 12;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO date",
});

const ManifestSourceSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
  failures: z
    .array(z.object({ query: z.string(), error: z.string() }))
    .optional(),
});

const ManifestRecordSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  sourceUrl: z.string().url(),
  rejectedAt: isoDate,
  pinnedRef: z.string().optional(),
});

const CacheManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  sources: z.record(z.string(), ManifestSourceSchema),
  // Intake refusals are recorded, not dropped: id + reason + source + time
  // so rejected candidates surface for review instead of vanishing. Only
  // the current refresh run is listed; a later successful refresh clears
  // the entry by replacing the manifest.
  rejected: z.array(ManifestRecordSchema).optional(),
  // Successfully normalized but unprobed (listing-only) records: excluded
  // from the snapshot but kept reviewable here.
  unprobed: z
    .array(
      z.object({
        id: z.string().min(1),
        reason: z.string().min(1),
        sourceUrl: z.string().url(),
        observedAt: isoDate,
        pinnedRef: z.string().optional(),
      }),
    )
    .optional(),
});
export type CacheManifest = z.infer<typeof CacheManifestSchema>;

export interface SourceFetcher {
  id: string;
  url: string;
  fetch: () => Promise<SourceFetch>;
}

export type ProbeCandidate = (
  raw: RawCandidate,
  sourceId: string,
) => Promise<RawCandidate>;

export interface RefreshOptions {
  cacheDir?: string | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
  timeoutMs?: number | undefined;
  fetchers?: SourceFetcher[] | undefined;
  // Test seam: builds the production fetchers from the merged query plan.
  fetcherFactory?: ((extraQueries: readonly string[]) => SourceFetcher[]) | undefined;
  // Test seam: per-candidate artifact probe (defaults to probeRawCandidate).
  probe?: ProbeCandidate | undefined;
  // Profile signal terms appended to source discovery queries only.
  extraQueries?: readonly string[] | undefined;
}

export interface RefreshResult {
  ok: boolean;
  exitCode: number;
  snapshot: RegistrySnapshot | null;
  failures: Record<string, string>;
  written: boolean;
}

// Explicit override wins (tests inject a tmp dir), then env, then XDG cache.
export function resolveCacheDir(override?: string): string {
  if (override) return override;
  const env = process.env[CACHE_DIR_ENV];
  if (env) return env;
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "plugin-detector");
}

// Bundled snapshot ships with the package; resolves beside dist at runtime.
export function bundledSnapshotPath(): string {
  return fileURLToPath(
    new URL("../../data/registry-snapshot.json", import.meta.url),
  );
}

function readSnapshotFile(path: string): RegistrySnapshot | null {
  try {
    if (!existsSync(path)) return null;
    return parseSnapshot(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readManifestFile(path: string): CacheManifest | null {
  try {
    if (!existsSync(path)) return null;
    return CacheManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

// Retrieval for recorded intake refusals (finding: refusals must surface,
// not vanish). Returns null when no manifest has been written yet.
export function readCacheManifest(
  opts?: { cacheDir?: string },
): CacheManifest | null {
  return readManifestFile(
    join(resolveCacheDir(opts?.cacheDir), MANIFEST_FILENAME),
  );
}

// Review must not silently mask a corrupt cache as "no cache": a present but
// invalid snapshot fails instead of falling back to the bundled seed. A
// missing cache falls back to the bundled snapshot (which Task 11 makes a
// reviewed, non-empty seed); that path is injectable for tests.
export function loadSnapshotForReview(opts?: {
  cacheDir?: string;
  bundledPath?: string;
}): RegistrySnapshot {
  const cachedPath = join(resolveCacheDir(opts?.cacheDir), SNAPSHOT_FILENAME);
  if (existsSync(cachedPath)) {
    return parseSnapshot(readFileSync(cachedPath, "utf8"));
  }
  const bundledPath = opts?.bundledPath ?? bundledSnapshotPath();
  if (!existsSync(bundledPath)) {
    throw new Error(
      "no registry snapshot found: run `plugin-detector registry refresh`",
    );
  }
  // A bundled snapshot that exists but does not parse is a packaging error,
  // not an absent snapshot; surface the parse failure.
  return parseSnapshot(readFileSync(bundledPath, "utf8"));
}

// A corrupt manifest is a review failure, not an empty ledger: dropping it
// would hide rejected and unprobed records from the report.
export function readCacheManifestStrict(opts?: {
  cacheDir?: string;
}): CacheManifest | null {
  const path = join(resolveCacheDir(opts?.cacheDir), MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  return CacheManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// A valid user cache always wins; the bundled snapshot is strictly the
// offline fallback. Timestamp comparison is deliberately avoided: a newly
// shipped bundled snapshot (newer generatedAt, possibly empty) must never
// shadow an older populated user cache.
export function loadSnapshot(opts?: { cacheDir?: string }): RegistrySnapshot {
  const dir = resolveCacheDir(opts?.cacheDir);
  const cached = readSnapshotFile(join(dir, SNAPSHOT_FILENAME));
  if (cached) return cached;
  const bundled = readSnapshotFile(bundledSnapshotPath());
  if (bundled) return bundled;
  throw new Error(
    "no registry snapshot found: run `plugin-detector registry refresh`",
  );
}

function normalizeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of queries) {
    const query = value.trim();
    const key = query.toLowerCase();
    if (query === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

// Discovery-only query plan: profile terms extend skills.sh and GitHub search
// terms (capped); they never become capabilities or evidence.
export function extendedQueries(
  extraQueries: readonly string[] = [],
): { skillsSh: string[]; github: string[] } {
  const extras = normalizeQueries(extraQueries).slice(0, MAX_EXTRA_QUERIES);
  return {
    skillsSh: normalizeQueries([...DEFAULT_SKILL_QUERIES, ...extras]),
    github: normalizeQueries([...GITHUB_TOPIC_QUERIES, ...extras]),
  };
}

export type ProbeDispatchCode =
  | "ARTIFACT_MISSING"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_UNAVAILABLE";

// Typed dispatch refusal: the candidate id and reason survive into the refresh
// manifest so unprobeable listings remain reviewable.
export class CandidateProbeError extends Error {
  constructor(
    readonly candidateId: string,
    readonly code: ProbeDispatchCode,
    readonly reason: string,
  ) {
    super(`probe: candidate "${candidateId}" ${reason}`);
    this.name = "CandidateProbeError";
  }
}

function probeErrorCode(error: unknown): string | undefined {
  if (
    error instanceof GithubProbeError ||
    error instanceof SkillsShProbeError ||
    error instanceof PackageProbeError ||
    error instanceof CandidateProbeError
  ) {
    return error.code;
  }
  return undefined;
}

// Only a source that could not answer may preserve prior evidence. A hard
// rejection (missing/mismatch/invalid/too large) is evidence about the
// artifact itself and must drop the old record.
export function isTransientProbeError(error: unknown): boolean {
  const code = probeErrorCode(error);
  if (code !== undefined) return code === "ARTIFACT_UNAVAILABLE";
  if (error instanceof SourceHttpError) {
    return (
      error.retryable ||
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  if (error instanceof Error) {
    const networkCode = (error as Error & { code?: unknown }).code;
    if (
      typeof networkCode === "string" &&
      /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(networkCode)
    ) {
      return true;
    }
    return /timeout|timed out|network|fetch failed|socket hang up/i.test(
      error.message,
    );
  }
  return false;
}

export interface ProbeRawOptions {
  probeSkillsSh?: typeof probeSkillsSh | undefined;
  probeGithub?: typeof probeGithub | undefined;
  probePackage?: typeof probePackage | undefined;
}

function candidateIdOf(raw: RawCandidate): string {
  return raw.id ?? raw.packageName ?? raw.artifact?.artifactId ?? "unknown";
}

const MUTABLE_PINS = new Set(["main", "master", "latest", "stable", "head"]);

function declaredPackageVersion(raw: RawCandidate): string | undefined {
  const declared = raw.pinnedRef?.trim();
  if (declared === undefined || declared === "" || declared === "0.0.0") {
    return undefined;
  }
  if (MUTABLE_PINS.has(declared.toLowerCase())) return undefined;
  return declared;
}

function withPackageProbe(
  raw: RawCandidate,
  result: PackageProbeResult,
): RawCandidate {
  const { evidence, metadata } = result;
  return {
    ...raw,
    artifactProbe: evidence,
    artifactProbed: true,
    packageName: metadata.name,
    packageRegistry: metadata.registry,
    // The registry version is the immutable pin; listing versions may be
    // "0.0.0" placeholders or dist-tags.
    pinnedRef: metadata.version,
    // Registry metadata is the fetched license truth; an unlisted license
    // stays unknown rather than inheriting a listing's claim.
    license: metadata.license,
    ...(raw.repositoryUrl === undefined && metadata.repositoryUrl !== undefined
      ? { repositoryUrl: metadata.repositoryUrl }
      : {}),
    ...(metadata.maintainers.length > 0
      ? { maintainers: metadata.maintainers }
      : {}),
    ...(metadata.deprecated === undefined
      ? {}
      : { deprecated: metadata.deprecated }),
  };
}

function withoutListingPackage(raw: RawCandidate): RawCandidate {
  const { packageName: _listingPackage, ...rest } = raw;
  return rest;
}

// One proof step per source shape: skills.sh download, GitHub/awesome-list
// repository manifest, or MCP registry package/github probe. Callers inject
// the probe functions in tests; production uses the bounded, rate-limited
// real probes.
export async function probeRawCandidate(
  raw: RawCandidate,
  sourceId: string,
  options: ProbeRawOptions = {},
): Promise<RawCandidate> {
  // Already-probed records are idempotent (snapshot reuse, tests).
  if (raw.artifactProbe !== undefined) return raw;
  const id = candidateIdOf(raw);
  switch (sourceId) {
    case SKILLS_SH_ID:
      // A listing-supplied package name is not the skill artifact's package;
      // only evidence fetched by the probe may set one.
      return (options.probeSkillsSh ?? probeSkillsSh)(
        withoutListingPackage(raw),
      );
    case GITHUB_ID:
    case AWESOME_LISTS_ID:
      return (options.probeGithub ?? probeGithub)(withoutListingPackage(raw));
    case MCP_REGISTRY_ID: {
      // A package name without its registry type cannot be probed safely and
      // must not become an install source by falling through to the repo.
      if (raw.packageName !== undefined && raw.packageRegistry === undefined) {
        throw new CandidateProbeError(
          id,
          "ARTIFACT_INVALID",
          "mcp-registry listing has a package name without a registry type",
        );
      }
      // Prefer package metadata when the listing names a registry package;
      // otherwise fall back to the repository manifest. No identity means no
      // probe: a bare registry URL is a listing, not an artifact.
      if (raw.packageName !== undefined && raw.packageRegistry !== undefined) {
        const result = await (options.probePackage ?? probePackage)(
          raw.packageName,
          declaredPackageVersion(raw),
          {
            registry: raw.packageRegistry,
            artifactType: "mcp-server",
            ...(raw.repositoryUrl === undefined
              ? {}
              : { expectedRepository: raw.repositoryUrl }),
          },
        );
        return withPackageProbe(raw, result);
      }
      if (raw.repositoryUrl !== undefined && raw.repositoryUrl.trim() !== "") {
        return (options.probeGithub ?? probeGithub)(raw);
      }
      throw new CandidateProbeError(
        id,
        "ARTIFACT_MISSING",
        "mcp-registry listing has no package or repository identity to probe",
      );
    }
    default:
      throw new CandidateProbeError(
        id,
        "ARTIFACT_INVALID",
        `source "${sourceId}" has no artifact probe`,
      );
  }
}

// Bounded worker pool: stable result order, at most `limit` probes in flight.
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await task(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function defaultFetchers(
  validators: Record<string, { etag?: string; lastModified?: string }>,
  timeoutMs: number,
  extraQueries: readonly string[] = [],
): SourceFetcher[] {
  // Each source keeps its own HTTP shape; the wrapper only adds timeout plus
  // conditional-request validators from the previous manifest.
  const bound = (
    id: string,
    extraHeaders: Record<string, string> = {},
  ) => {
    const v = validators[id];
    return (u: string) =>
      httpGetText(u, {
        timeoutMs,
        headers: extraHeaders,
        ...(v?.etag ? { etag: v.etag } : {}),
        ...(v?.lastModified ? { lastModified: v.lastModified } : {}),
      });
  };
  // Production token path: this bound getter owns the Authorization header.
  // fetchGithub's `token` option serves its default/library transport only.
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  const queries = extendedQueries(extraQueries);
  return [
    {
      id: SKILLS_SH_ID,
      url: SKILLS_SH_URL,
      fetch: () =>
        fetchSkillsSh({
          queries: queries.skillsSh,
          get: bound(SKILLS_SH_ID),
        }),
    },
    {
      id: MCP_REGISTRY_ID,
      url: MCP_REGISTRY_URL,
      fetch: () => fetchMcpRegistry(bound(MCP_REGISTRY_ID)),
    },
    {
      id: GITHUB_ID,
      url: GITHUB_URL,
      fetch: () =>
        fetchGithub({
          queries: queries.github,
          get: bound(GITHUB_ID, {
            accept: "application/vnd.github+json",
            ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
          }),
        }),
    },
    {
      id: AWESOME_LISTS_ID,
      url: AWESOME_LISTS_URL,
      fetch: () => fetchAwesomeLists(bound(AWESOME_LISTS_ID)),
    },
  ];
}

// Refresh with per-source failure isolation: total network failure returns
// exit 2 and mutates nothing; partial failure writes the refreshed subset,
// keeps stale entries at their old lastVerified age, and records failures in
// the manifest. Stale entries are never silently re-stamped as fresh.
export async function refreshSnapshot(
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const dir = resolveCacheDir(opts.cacheDir);
  const nowIso = (opts.now ?? new Date()).toISOString();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const extraQueries = opts.extraQueries ?? [];
  const prev = readSnapshotFile(join(dir, SNAPSHOT_FILENAME));
  const prevManifest = readManifestFile(join(dir, MANIFEST_FILENAME));
  const validators: Record<string, { etag?: string; lastModified?: string }> = {};
  for (const [id, entry] of Object.entries(prevManifest?.sources ?? {})) {
    const v: { etag?: string; lastModified?: string } = {};
    if (entry.etag) v.etag = entry.etag;
    if (entry.lastModified) v.lastModified = entry.lastModified;
    validators[id] = v;
  }
  const fetchers =
    opts.fetchers ??
    opts.fetcherFactory?.(extraQueries) ??
    defaultFetchers(validators, timeoutMs, extraQueries);
  // Apply the requested cap before probing: a probe is an HTTP fetch and can
  // be expensive. Split the total budget evenly so one source cannot consume
  // every slot before the others are queried.
  const perSourceLimit =
    opts.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(opts.limit / Math.max(1, fetchers.length)));

  const prevById = new Map(prev?.candidates.map((c) => [c.id, c]) ?? []);
  const prevProvenanceById = new Map(
    (prev?.provenance ?? []).map((p) => [p.id, p]),
  );
  const priorEntry = (id: string): SnapshotEntry | undefined => {
    const candidate = prevById.get(id);
    // Only probed prior records are snapshot material; a prior listing-only
    // record has nothing to preserve.
    if (candidate === undefined || candidate.artifactEvidence === undefined) {
      return undefined;
    }
    const provenance = prevProvenanceById.get(id);
    if (provenance === undefined) return undefined;
    return {
      candidate,
      sourceUrl: provenance.sourceUrl,
      retrievedAt: provenance.retrievedAt,
      trust: provenance.trust,
    };
  };

  // Memoize probes for this run so a duplicate listing within one source
  // (same repo/package + ref + branch) is not fetched twice.
  // shortcut: dispatch differs per source, so the same artifact reached
  // through two sources still probes once per source; upgrade if live refresh
  // shows duplicate fetch volume.
  const probe = opts.probe ?? probeRawCandidate;
  const probeCache = new Map<string, Promise<RawCandidate>>();
  const probeOnce = (raw: RawCandidate, sourceId: string): Promise<RawCandidate> => {
    const key = [
      sourceId,
      raw.id ?? "",
      raw.repositoryUrl ?? "",
      raw.packageName ?? "",
      raw.pinnedRef ?? "",
      raw.defaultBranch ?? "",
    ].join("|");
    const cached = probeCache.get(key);
    if (cached !== undefined) return cached;
    const pending = probe(raw, sourceId);
    probeCache.set(key, pending);
    return pending;
  };

  const entries: SnapshotEntry[] = [];
  // Preserved prior records must never beat a fresh probe for the same id.
  const preservedEntries = new Set<SnapshotEntry>();
  const freshProbedIds = new Set<string>();
  // Run-level hard rejections: no preservation path may resurrect these ids.
  // A fresh probe from another source is the only way back in this run.
  const hardRejectedIds = new Set<string>();
  const failures: Record<string, string> = {};
  const manifestSources: CacheManifest["sources"] = {};
  const rejected: NonNullable<CacheManifest["rejected"]> = [];
  const unprobed: NonNullable<CacheManifest["unprobed"]> = [];
  let succeeded = 0;

  for (const fetcher of fetchers) {
    let fetched: SourceFetch;
    try {
      fetched = await fetcher.fetch();
    } catch (err) {
      if (err instanceof NotModified) {
        // Source unchanged: keep its previous candidates at their old age.
        const kept = (prev?.provenance ?? []).filter(
          (p) => p.sourceUrl === fetcher.url,
        );
        for (const p of kept) {
          if (hardRejectedIds.has(p.id)) continue;
          const candidate = prevById.get(p.id);
          if (candidate) {
            const entry: SnapshotEntry = {
              candidate,
              sourceUrl: p.sourceUrl,
              retrievedAt: p.retrievedAt,
              trust: p.trust,
            };
            preservedEntries.add(entry);
            entries.push(entry);
          }
        }
        succeeded += 1;
        // Carry the conditional-request validators forward, otherwise the
        // next refresh would ask unconditionally and lose the 304 path.
        const previous = prevManifest?.sources[fetcher.id];
        manifestSources[fetcher.id] = {
          ok: true,
          count: kept.length,
          ...(previous?.etag ? { etag: previous.etag } : {}),
          ...(previous?.lastModified
            ? { lastModified: previous.lastModified }
            : {}),
        };
        continue;
      }
      failures[fetcher.url] =
        err instanceof Error ? err.message : String(err);
      manifestSources[fetcher.id] = {
        ok: false,
        error: failures[fetcher.url],
      };
      continue;
    }
    succeeded += 1;
    const handledIds = new Set<string>();
    const rawsToProbe =
      perSourceLimit === undefined
        ? fetched.raws
        : [...fetched.raws]
            .sort((a, b) => {
              const ax = candidateIdOf(a);
              const bx = candidateIdOf(b);
              return ax < bx ? -1 : ax > bx ? 1 : 0;
            })
            .slice(0, perSourceLimit);
    const outcomes = await mapLimit(rawsToProbe, 4, async (raw) => {
      const stamped: RawCandidate = {
        ...raw,
        lastVerified: raw.lastVerified ?? nowIso,
      };
      const id = candidateIdOf(stamped);
      handledIds.add(id);
      const keepPrior = (): {
        entry?: SnapshotEntry;
        probed: boolean;
      } => {
        const prior = priorEntry(id);
        if (prior === undefined || hardRejectedIds.has(id)) {
          return { probed: false };
        }
        preservedEntries.add(prior);
        return { entry: prior, probed: false };
      };

      let probed: RawCandidate;
      try {
        probed = await probeOnce(stamped, fetcher.id);
      } catch (err) {
        // Probe refusal is recorded. Only a source that could not answer
        // (network/timeout/5xx/unavailable) preserves prior evidence; a hard
        // artifact rejection removes the old record.
        rejected.push({
          id,
          reason: err instanceof Error ? err.message : String(err),
          sourceUrl: fetcher.url,
          rejectedAt: nowIso,
          ...(stamped.pinnedRef === undefined
            ? {}
            : { pinnedRef: stamped.pinnedRef }),
        });
        if (isTransientProbeError(err)) {
          return keepPrior();
        }
        hardRejectedIds.add(id);
        return { probed: false };
      }

      let candidate: NormalizedCandidate;
      try {
        candidate = normalizeCandidate(probed);
      } catch (err) {
        // Normalize failures are hard rejections (archived, install hooks,
        // prompt injection, namespace squatting): the fresh listing is the
        // authority, so the prior record is dropped.
        rejected.push({
          id,
          reason: err instanceof Error ? err.message : String(err),
          sourceUrl: fetcher.url,
          rejectedAt: nowIso,
          ...(stamped.pinnedRef === undefined
            ? {}
            : { pinnedRef: stamped.pinnedRef }),
        });
        hardRejectedIds.add(id);
        return { probed: false };
      }

      if (candidate.artifactEvidence === undefined) {
        // Listing-only record: visible in the manifest, never in the snapshot.
        // A fresh listing without evidence also supersedes the prior record
        // and blocks preservation from other sources this run.
        unprobed.push({
          id: candidate.id,
          reason:
            "no artifact evidence: listing-only record excluded from snapshot",
          sourceUrl: fetcher.url,
          observedAt: nowIso,
          ...(candidate.pinnedRef === undefined
            ? {}
            : { pinnedRef: candidate.pinnedRef }),
        });
        hardRejectedIds.add(candidate.id);
        return { probed: false };
      }

      const prevCandidate = prevById.get(candidate.id);
      const drift =
        prevCandidate === undefined
          ? null
          : detectDrift(prevCandidate, candidate);
      return {
        entry: {
          candidate,
          sourceUrl: fetcher.url,
          retrievedAt: nowIso,
          trust: classifyTrust(candidate, {
            // Publisher identity is policy evidence; actual trust still
            // requires classifyTrust's independent artifactProbed and
            // repository/evidence binding checks.
            maintainerVerified:
              candidate.provenance === "official" ||
              isOfficialPublisher(candidate),
            activity: candidate.maintenance,
            reviewEvidence: false,
            ...(drift !== null && drift.drifted
              ? { drifted: true as const }
              : {}),
            ...(candidate.untrustedCopyRisk
              ? { untrustedCopyRisk: true as const }
              : {}),
          }),
        },
        probed: true,
      };
    });

    let count = 0;
    const freshIdsHere = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.entry !== undefined) entries.push(outcome.entry);
      if (outcome.probed && outcome.entry !== undefined) {
        count += 1;
        freshIdsHere.add(outcome.entry.candidate.id);
        freshProbedIds.add(outcome.entry.candidate.id);
      }
    }

    const partial =
      fetched.partial === true || (fetched.failures?.length ?? 0) > 0;
    if (partial) {
      // A partial harvest only mentions the queries that succeeded. Keep
      // prior candidates this source did not mention instead of dropping them.
      for (const provenance of prev?.provenance ?? []) {
        if (
          provenance.sourceUrl !== fetcher.url ||
          handledIds.has(provenance.id) ||
          freshIdsHere.has(provenance.id) ||
          hardRejectedIds.has(provenance.id)
        ) {
          continue;
        }
        const prior = priorEntry(provenance.id);
        if (prior !== undefined) {
          preservedEntries.add(prior);
          entries.push(prior);
        }
      }
    }

    const manifestEntry: CacheManifest["sources"][string] = {
      ok: true,
      count,
      ...(partial ? { partial: true as const } : {}),
      ...(fetched.failures === undefined
        ? {}
        : { failures: fetched.failures }),
    };
    if (fetched.etag) manifestEntry.etag = fetched.etag;
    if (fetched.lastModified) manifestEntry.lastModified = fetched.lastModified;
    manifestSources[fetcher.id] = manifestEntry;
  }

  if (succeeded === 0) {
    return { ok: false, exitCode: 2, snapshot: null, failures, written: false };
  }

  const refreshedUrls = new Set(
    fetchers
      .filter((f) => !failures[f.url])
      .map((f) => f.url),
  );
  const freshIds = new Set(entries.map((e) => e.candidate.id));
  // Stale merge: candidates whose source did not refresh keep their stored
  // candidate (and its lastVerified age) untouched.
  for (const p of prev?.provenance ?? []) {
    if (
      refreshedUrls.has(p.sourceUrl) ||
      freshIds.has(p.id) ||
      hardRejectedIds.has(p.id)
    ) {
      continue;
    }
    const candidate = prevById.get(p.id);
    if (!candidate) continue;
    const entry: SnapshotEntry = {
      candidate,
      sourceUrl: p.sourceUrl,
      retrievedAt: p.retrievedAt,
      trust: p.trust,
    };
    preservedEntries.add(entry);
    entries.push(entry);
  }

  // A fresh probe is the current truth: any older preserved record for the
  // same id is removed before dedupe so stale trust cannot win. A run-level
  // hard rejection removes every non-fresh entry for that id, regardless of
  // which source supplied or preserved it.
  const currentEntries = entries.filter((entry) => {
    const id = entry.candidate.id;
    if (preservedEntries.has(entry) && freshProbedIds.has(id)) return false;
    if (hardRejectedIds.has(id) && !freshProbedIds.has(id)) return false;
    return true;
  });

  // Snapshot and limit apply to probed records only; unprobed candidates are
  // manifest evidence, not snapshot entries.
  const probedEntries = currentEntries.filter(
    (entry) => entry.candidate.artifactEvidence !== undefined,
  );
  // Limit is applied after preservation and dedupe filtering, so preserved
  // entries can consume limit slots alongside fresh probes.
  const limited =
    opts.limit === undefined
      ? probedEntries
      : probedEntries
          .slice()
          .sort((a, b) =>
            a.candidate.id < b.candidate.id
              ? -1
              : a.candidate.id > b.candidate.id
                ? 1
                : 0,
          )
          .slice(0, Math.max(0, opts.limit));
  const snapshot = buildSnapshot(limited, new Date(nowIso));
  mkdirSync(dir, { recursive: true });
  // An empty result must not shadow a populated bundled snapshot on a first
  // refresh. If a prior local snapshot existed, write the empty result so
  // hard-rejected candidates cannot survive.
  const writeSnapshotFile = snapshot.candidates.length > 0 || prev !== null;
  if (writeSnapshotFile) {
    writeFileSync(join(dir, SNAPSHOT_FILENAME), JSON.stringify(snapshot, null, 2));
  }
  const manifest: CacheManifest = {
    schemaVersion: 1,
    generatedAt: nowIso,
    sources: manifestSources,
    rejected,
    ...(unprobed.length > 0 ? { unprobed } : {}),
  };
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  return {
    ok: true,
    exitCode: 0,
    snapshot,
    failures,
    written: writeSnapshotFile,
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Candidate } from "@plugin-detector/core";
import { normalizeCandidate, type NormalizedCandidate } from "./normalize.js";
import type { RawCandidate } from "./probe.js";
import { classifyTrust, detectDrift } from "./trust.js";
import {
  buildSnapshot,
  parseSnapshot,
  type RegistrySnapshot,
  type SnapshotEntry,
} from "./snapshot.js";
import { httpGetText, NotModified, type SourceFetch } from "./sources/http.js";
import { fetchSkillsSh, SKILLS_SH_ID, SKILLS_SH_URL } from "./sources/skills-sh.js";
import {
  fetchMcpRegistry,
  MCP_REGISTRY_ID,
  MCP_REGISTRY_URL,
} from "./sources/mcp-registry.js";
import { fetchGithub, GITHUB_ID, GITHUB_URL } from "./sources/github.js";
import {
  fetchAwesomeLists,
  AWESOME_LISTS_ID,
  AWESOME_LISTS_URL,
} from "./sources/awesome-lists.js";

export const CACHE_DIR_ENV = "PLUGIN_DETECTOR_CACHE_DIR";
export const SNAPSHOT_FILENAME = "registry-snapshot.json";
export const MANIFEST_FILENAME = "registry-manifest.json";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO date",
});

const ManifestSourceSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
});

const CacheManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  sources: z.record(z.string(), ManifestSourceSchema),
  // Intake refusals are recorded, not dropped: id + reason + source + time
  // so rejected candidates surface for review instead of vanishing. Only
  // the current refresh run is listed; a later successful refresh clears
  // the entry by replacing the manifest.
  rejected: z.array(
    z.object({
      id: z.string().min(1),
      reason: z.string().min(1),
      sourceUrl: z.string().url(),
      rejectedAt: isoDate,
      pinnedRef: z.string().optional(),
    }),
  ).optional(),
});
export type CacheManifest = z.infer<typeof CacheManifestSchema>;

export interface SourceFetcher {
  id: string;
  url: string;
  fetch: () => Promise<SourceFetch>;
}

export interface RefreshOptions {
  cacheDir?: string | undefined;
  limit?: number | undefined;
  now?: Date | undefined;
  timeoutMs?: number | undefined;
  fetchers?: SourceFetcher[] | undefined;
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

function defaultFetchers(
  validators: Record<string, { etag?: string; lastModified?: string }>,
  timeoutMs: number,
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
  return [
    {
      id: SKILLS_SH_ID,
      url: SKILLS_SH_URL,
      fetch: () => fetchSkillsSh(bound(SKILLS_SH_ID)),
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
        fetchGithub(bound(GITHUB_ID, { accept: "application/vnd.github+json" })),
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
  const prev = readSnapshotFile(join(dir, SNAPSHOT_FILENAME));
  const prevManifest = readManifestFile(join(dir, MANIFEST_FILENAME));
  const validators: Record<string, { etag?: string; lastModified?: string }> = {};
  for (const [id, entry] of Object.entries(prevManifest?.sources ?? {})) {
    const v: { etag?: string; lastModified?: string } = {};
    if (entry.etag) v.etag = entry.etag;
    if (entry.lastModified) v.lastModified = entry.lastModified;
    validators[id] = v;
  }
  const fetchers = opts.fetchers ?? defaultFetchers(validators, timeoutMs);

  const prevById = new Map(prev?.candidates.map((c) => [c.id, c]) ?? []);
  const entries: SnapshotEntry[] = [];
  const failures: Record<string, string> = {};
  const manifestSources: CacheManifest["sources"] = {};
  const rejected: NonNullable<CacheManifest["rejected"]> = [];
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
          const candidate = prevById.get(p.id);
          if (candidate) {
            entries.push({
              candidate,
              sourceUrl: p.sourceUrl,
              retrievedAt: p.retrievedAt,
              trust: p.trust,
            });
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
    let count = 0;
    for (const raw of fetched.raws) {
      const stamped: RawCandidate = {
        ...raw,
        lastVerified: raw.lastVerified ?? nowIso,
      };
      let candidate: NormalizedCandidate;
      try {
        candidate = normalizeCandidate(stamped);
      } catch (err) {
        // Recorded, not dropped: the hard gate holds, but the refusal
        // surfaces in the manifest for review instead of vanishing.
        rejected.push({
          id:
            stamped.id ??
            stamped.packageName ??
            stamped.artifact?.artifactId ??
            "unknown",
          reason: err instanceof Error ? err.message : String(err),
          sourceUrl: fetcher.url,
          rejectedAt: nowIso,
          ...(stamped.pinnedRef === undefined
            ? {}
            : { pinnedRef: stamped.pinnedRef }),
        });
        continue; // Per-candidate isolation: bad records never sink a source.
      }
      const prevCandidate = prevById.get(candidate.id);
      const drift =
        prevCandidate === undefined
          ? null
          : detectDrift(prevCandidate, candidate);
      entries.push({
        candidate,
        sourceUrl: fetcher.url,
        retrievedAt: nowIso,
        trust: classifyTrust(candidate, {
          maintainerVerified: candidate.provenance === "official",
          activity: candidate.maintenance,
          reviewEvidence: false,
          ...(drift !== null && drift.drifted ? { drifted: true as const } : {}),
          ...(candidate.untrustedCopyRisk
            ? { untrustedCopyRisk: true as const }
            : {}),
        }),
      });
      count += 1;
    }
    const manifestEntry: CacheManifest["sources"][string] = {
      ok: true,
      count,
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
    if (refreshedUrls.has(p.sourceUrl) || freshIds.has(p.id)) continue;
    const candidate = prevById.get(p.id);
    if (!candidate) continue;
    entries.push({
      candidate,
      sourceUrl: p.sourceUrl,
      retrievedAt: p.retrievedAt,
      trust: p.trust,
    });
  }

  const limited =
    opts.limit === undefined
      ? entries
      : entries
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
  writeFileSync(join(dir, SNAPSHOT_FILENAME), JSON.stringify(snapshot, null, 2));
  const manifest: CacheManifest = {
    schemaVersion: 1,
    generatedAt: nowIso,
    sources: manifestSources,
    rejected,
  };
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
  return { ok: true, exitCode: 0, snapshot, failures, written: true };
}

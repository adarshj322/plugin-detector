import { createHash } from "node:crypto";
import type { ArtifactType } from "@plugin-detector/core";
import type { ArtifactEvidence, RawCandidate } from "./probe.js";
import {
  MAX_EVIDENCE_SNIPPET_LENGTH,
  parseSkillFrontmatter,
} from "./probe-skills-sh.js";
import {
  httpGetText,
  RateLimiter,
  RAW_REQUESTS_PER_MINUTE,
  SourceHttpError,
  type HttpGetter,
  type HttpResult,
} from "./sources/http.js";

export const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";
// A raw manifest is data, never a payload to install: cap it well below the
// shared 5 MiB listing body limit.
export const MAX_MANIFEST_BYTES = 256 * 1024;

type ProbedArtifactType = Extract<
  ArtifactType,
  "skill" | "plugin" | "mcp-server" | "tool"
>;

// Single source for probe order and artifact type; first valid artifact wins.
const ARTIFACT_KINDS = {
  "SKILL.md": "skill",
  ".claude-plugin/plugin.json": "plugin",
  "plugin.json": "plugin",
  "package.json": "tool",
  "server.json": "mcp-server",
} as const satisfies Record<string, ProbedArtifactType>;

export const GITHUB_ARTIFACT_PATHS = Object.keys(
  ARTIFACT_KINDS,
) as ReadonlyArray<keyof typeof ARTIFACT_KINDS>;

// raw.githubusercontent.com allows 60 requests/min unauthenticated.
export const GITHUB_RAW_LIMITER = new RateLimiter({
  requestsPerMinute: RAW_REQUESTS_PER_MINUTE,
});

export type GithubProbeCode =
  | "ARTIFACT_MISSING"
  | "ARTIFACT_MISMATCH"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_UNAVAILABLE";

// Typed probe refusal: the candidate id and reason survive into the refresh
// manifest so rejected GitHub candidates remain reviewable.
export class GithubProbeError extends Error {
  constructor(
    readonly candidateId: string,
    readonly code: GithubProbeCode,
    readonly reason: string,
  ) {
    super(`github: candidate ${quoted(candidateId)} ${reason}`);
    this.name = "GithubProbeError";
  }
}

export interface ProbeGithubOptions {
  // Test seam; production callers use the shared 60/min raw limiter.
  limiter?: RateLimiter | undefined;
}

interface ArtifactSpec {
  path: keyof typeof ARTIFACT_KINDS;
  kind: ProbedArtifactType;
}

const ARTIFACTS: readonly ArtifactSpec[] = GITHUB_ARTIFACT_PATHS.map(
  (path) => ({ path, kind: ARTIFACT_KINDS[path] }),
);

interface ManifestData {
  kind: ProbedArtifactType;
  name: string;
  version?: string | undefined;
  license?: string | undefined;
  description?: string | undefined;
  packageName?: string | undefined;
  installHooks?: string[] | undefined;
}

interface RepoParts {
  owner: string;
  repo: string;
}

// Unpaced default transport: probeGithub applies the shared limiter around
// every request, including injected getters, so cache's timeout-bound getter
// cannot bypass it. Do not wrap this getter again.
export function githubRawGet(url: string): Promise<HttpResult> {
  return httpGetText(url, {
    maxBytes: MAX_MANIFEST_BYTES,
    // Raw content must come from the fixed host; a redirect is an error.
    redirect: "error",
  });
}

// shortcut: raw.githubusercontent serves repository blobs, not symlink
// entries, so a symlinked manifest cannot be distinguished from a missing
// one; redirects are refused and the host is fixed.

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function candidateId(raw: RawCandidate): string {
  return (
    raw.id ??
    raw.artifact?.artifactId ??
    raw.name ??
    raw.repositoryUrl ??
    "unknown"
  );
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// npm scopes (@acme/tool) and MCP reverse-DNS names (io.github.acme/tool)
// carry the useful artifact name in their final segment.
function nameVariants(value: string): string[] {
  const out = [value];
  const slash = value.lastIndexOf("/");
  if (slash >= 0 && slash < value.length - 1) {
    out.push(value.slice(slash + 1));
  }
  return out;
}

function matchesListing(
  raw: RawCandidate,
  repo: string,
  manifestName: string,
): boolean {
  // An exact listing id is the strongest link when normalization would differ.
  const id = raw.id?.trim().toLowerCase();
  if (id !== undefined && manifestName.trim().toLowerCase() === id) return true;
  const manifestKeys = new Set(
    nameVariants(manifestName)
      .map(normalizeName)
      .filter((name) => name.length > 0),
  );
  const listingKeys: string[] = [];
  for (const value of [
    raw.id,
    raw.name,
    raw.packageName,
    raw.artifact?.artifactId,
    repo,
  ]) {
    if (value === undefined) continue;
    for (const variant of nameVariants(value)) {
      const key = normalizeName(variant);
      if (key.length > 0) listingKeys.push(key);
    }
  }
  return listingKeys.some((key) => manifestKeys.has(key));
}

function licenseOf(v: unknown): string | undefined {
  const direct = str(v);
  if (direct !== undefined) return direct;
  return str(record(v)?.["type"]);
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"] as const;

function installHooksOf(scripts: unknown): string[] {
  const fields = record(scripts);
  if (fields === undefined) return [];
  return INSTALL_HOOKS.filter(
    (name) => str(fields[name]) !== undefined,
  );
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

function boundedSnippet(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= MAX_EVIDENCE_SNIPPET_LENGTH
    ? singleLine
    : singleLine.slice(0, MAX_EVIDENCE_SNIPPET_LENGTH);
}

// Untrusted names/refs end up in review reasons: quote-escape control
// characters and cap the length so a manifest cannot forge log lines.
function quoted(value: string): string {
  const bounded =
    value.length <= 120 ? value : `${value.slice(0, 120)}...`;
  return JSON.stringify(bounded);
}

function boundedReason(value: string): string {
  return value.length <= 300 ? value : `${value.slice(0, 300)}...`;
}

function parseManifest(
  id: string,
  path: string,
  text: string,
): ManifestData {
  if (path === "SKILL.md") {
    const frontmatter = parseSkillFrontmatter(text);
    if (frontmatter === null) {
      throw new GithubProbeError(
        id,
        "ARTIFACT_INVALID",
        `${path} has no name/description frontmatter`,
      );
    }
    const out: ManifestData = {
      kind: "skill",
      name: frontmatter.name,
      description: frontmatter.description,
    };
    if (frontmatter.version !== undefined) out.version = frontmatter.version;
    if (frontmatter.license !== undefined) out.license = frontmatter.license;
    return out;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    // Never echo the body: V8 quotes it in parse errors.
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `${path} is not valid JSON`,
    );
  }
  const root = record(payload);
  if (root === undefined) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `${path} is not a JSON object`,
    );
  }
  const name = str(root["name"]);
  if (name === undefined) {
    throw new GithubProbeError(id, "ARTIFACT_INVALID", `${path} has no name`);
  }
  const version = str(root["version"]);
  if (version === undefined) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `${path} has no version`,
    );
  }
  const kind: ProbedArtifactType =
    path === "server.json"
      ? "mcp-server"
      : path === "package.json"
        ? "tool"
        : "plugin";
  const out: ManifestData = { kind, name, version };
  const license = licenseOf(root["license"]);
  if (license !== undefined) out.license = license;
  if (path === "package.json") {
    // The package identity must reach normalize's reserved-namespace gate.
    out.packageName = name;
    const hooks = installHooksOf(root["scripts"]);
    if (hooks.length > 0) out.installHooks = hooks;
  }
  if (path === "server.json") {
    if (!nonEmptyArray(root["remotes"]) && !nonEmptyArray(root["packages"])) {
      throw new GithubProbeError(
        id,
        "ARTIFACT_INVALID",
        `${path} has neither remotes nor packages`,
      );
    }
    const packages = root["packages"];
    const firstPackage = Array.isArray(packages)
      ? record(packages[0])
      : undefined;
    const identifier = str(firstPackage?.["identifier"]);
    if (identifier !== undefined) out.packageName = identifier;
  }
  return out;
}

function validRepoSegment(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

function unsafePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value
      .replace(/\\/g, "/")
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  );
}

function repositoryParts(raw: RawCandidate, id: string): RepoParts {
  const repositoryUrl = raw.repositoryUrl;
  if (repositoryUrl === undefined || repositoryUrl.trim() === "") {
    throw new GithubProbeError(id, "ARTIFACT_INVALID", "listing has no repositoryUrl");
  }
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      "repositoryUrl is not a valid URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `repositoryUrl scheme ${quoted(url.protocol)} is not http(s)`,
    );
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `repositoryUrl host ${quoted(url.hostname)} is not github.com`,
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      "repositoryUrl has no owner/repo path",
    );
  }
  const owner = segments[0] as string;
  const repo = (segments[1] as string).replace(/\.git$/i, "");
  if (!validRepoSegment(owner) || !validRepoSegment(repo)) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      "repositoryUrl contains an unsafe owner/repo segment",
    );
  }
  return { owner, repo };
}

function probeRefs(raw: RawCandidate, id: string): string[] {
  const branch = raw.defaultBranch?.trim();
  const refs: string[] = [];
  if (branch !== undefined && branch !== "") refs.push(branch);
  if (!refs.includes("HEAD")) refs.push("HEAD");
  for (const ref of refs) {
    const safe = ref
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !/[\u0000-\u001f\u007f\s\\]/.test(segment),
      );
    if (!safe) {
      throw new GithubProbeError(
        id,
        "ARTIFACT_INVALID",
        `default branch ${quoted(ref)} contains a traversal or unsafe path segment`,
      );
    }
  }
  return refs;
}

function rawUrl(owner: string, repo: string, ref: string, path: string): string {
  const segments = [owner, repo, ...ref.split("/"), ...path.split("/")];
  return `${GITHUB_RAW_BASE}/${segments.map(encodeURIComponent).join("/")}`;
}

async function fetchArtifact(
  id: string,
  path: string,
  url: string,
  get: HttpGetter,
  limiter: RateLimiter,
): Promise<string | undefined> {
  let res: HttpResult;
  try {
    res = await limiter.run(() => get(url));
  } catch (error) {
    // A missing file, branch, or repository is the normal "keep looking" path.
    if (
      error instanceof SourceHttpError &&
      (error.status === 404 || error.status === 410)
    ) {
      return undefined;
    }
    throw error;
  }
  const bytes = Buffer.byteLength(res.text, "utf8");
  if (bytes > MAX_MANIFEST_BYTES) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_TOO_LARGE",
      `${path} is ${bytes} bytes, over the ${MAX_MANIFEST_BYTES}-byte manifest limit`,
    );
  }
  // TextDecoder replaces malformed bytes with U+FFFD, so a replacement
  // character means the served file was not UTF-8.
  if (res.text.includes("\uFFFD")) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `${path} is not valid UTF-8`,
    );
  }
  if (res.text.trim() === "") {
    throw new GithubProbeError(id, "ARTIFACT_INVALID", `${path} is empty`);
  }
  return res.text;
}

function buildResult(
  raw: RawCandidate,
  spec: ArtifactSpec,
  url: string,
  ref: string,
  text: string,
  manifest: ManifestData,
): RawCandidate {
  const license = manifest.license ?? str(raw.license) ?? "unknown";
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");
  const snippets: string[] = [boundedSnippet(`name: ${manifest.name}`)];
  if (manifest.kind === "skill" && manifest.description !== undefined) {
    snippets.push(boundedSnippet(`description: ${manifest.description}`));
  } else if (manifest.version !== undefined) {
    snippets.push(boundedSnippet(`version: ${manifest.version}`));
  }
  const evidence: ArtifactEvidence = {
    kind: spec.kind,
    sourceUrl: url,
    resolvedRef: ref,
    contentHash,
    license,
    name: manifest.name,
    ...(manifest.packageName === undefined
      ? {}
      : { packageName: manifest.packageName }),
    // Task 7 owns capability inference; the probe records none of its own.
    capabilities: [],
    evidenceSnippets: snippets.slice(0, 2),
    retrievedAt: new Date().toISOString(),
  };
  if (manifest.version !== undefined) evidence.version = manifest.version;
  const out: RawCandidate = {
    ...raw,
    license,
    // Core rejects bare branch names as pins; the content digest is immutable
    // and the branch survives in artifactProbe.resolvedRef.
    pinnedRef: `github:${contentHash}`,
    artifactProbed: true,
    artifactProbe: evidence,
    artifact: { ...raw.artifact, kind: spec.kind, file: spec.path },
  };
  // Only the skill's frontmatter description is display copy. JSON manifests
  // carry no description/readme: the body itself is never stored.
  if (manifest.kind === "skill" && manifest.description !== undefined) {
    out.description = boundedSnippet(manifest.description);
  }
  if (manifest.packageName !== undefined) {
    out.packageName = manifest.packageName;
  }
  if (manifest.installHooks !== undefined && manifest.installHooks.length > 0) {
    out.installHooks = manifest.installHooks;
  }
  return out;
}

export async function probeGithub(
  raw: RawCandidate,
  get: HttpGetter = githubRawGet,
  opts: ProbeGithubOptions = {},
): Promise<RawCandidate> {
  const id = candidateId(raw);
  if (raw.maintenance === "archived") {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      "repository is archived; archived artifacts are not probed",
    );
  }
  const declared = raw.artifact?.file;
  if (declared !== undefined && unsafePath(declared)) {
    throw new GithubProbeError(
      id,
      "ARTIFACT_INVALID",
      `declared artifact path ${quoted(declared)} contains a traversal or unsafe path segment`,
    );
  }
  const { owner, repo } = repositoryParts(raw, id);
  const refs = probeRefs(raw, id);
  const limiter = opts.limiter ?? GITHUB_RAW_LIMITER;
  const failures: GithubProbeError[] = [];

  for (const ref of refs) {
    for (const spec of ARTIFACTS) {
      const url = rawUrl(owner, repo, ref, spec.path);
      let text: string | undefined;
      try {
        text = await fetchArtifact(id, spec.path, url, get, limiter);
      } catch (error) {
        if (error instanceof GithubProbeError) {
          failures.push(error);
          continue;
        }
        // The default getter caps bodies before decoding; keep that typed.
        if (
          error instanceof SourceHttpError &&
          error.status === 0 &&
          /response exceeded \d+ bytes/.test(error.message)
        ) {
          failures.push(
            new GithubProbeError(
              id,
              "ARTIFACT_TOO_LARGE",
              `${spec.path} exceeds the ${MAX_MANIFEST_BYTES}-byte manifest limit`,
            ),
          );
          continue;
        }
        // The raw host is fixed; a redirect could move content elsewhere. The
        // transport already discarded the target, so the reason stays fixed.
        if (
          error instanceof SourceHttpError &&
          error.status === 0 &&
          /redirect/i.test(error.message)
        ) {
          throw new GithubProbeError(
            id,
            "ARTIFACT_INVALID",
            `${spec.path} fetch was redirected; raw content must come from ${GITHUB_RAW_BASE}`,
          );
        }
        // A transport/throttle failure is not a missing artifact: stop instead
        // of hammering the remaining paths and refs. The transient code lets
        // refresh keep a prior probed record instead of dropping it.
        throw new GithubProbeError(
          id,
          "ARTIFACT_UNAVAILABLE",
          `fetching ${spec.path} failed: ${boundedReason(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
      if (text === undefined) continue;
      let manifest: ManifestData;
      try {
        manifest = parseManifest(id, spec.path, text);
      } catch (error) {
        if (error instanceof GithubProbeError) {
          failures.push(error);
          continue;
        }
        throw error;
      }
      if (!matchesListing(raw, repo, manifest.name)) {
        failures.push(
          new GithubProbeError(
            id,
            "ARTIFACT_MISMATCH",
            `${spec.path} name ${quoted(manifest.name)} does not match listing repo ${quoted(repo)}`,
          ),
        );
        continue;
      }
      return buildResult(raw, spec, url, ref, text, manifest);
    }
  }

  // Report the first found-but-rejected artifact in probe order; only when
  // every path was absent does this fall through to ARTIFACT_MISSING.
  const firstFailure = failures[0];
  if (firstFailure !== undefined) throw firstFailure;
  throw new GithubProbeError(
    id,
    "ARTIFACT_MISSING",
    `no supported artifact (${GITHUB_ARTIFACT_PATHS.join(", ")}) found on "${refs.join('" or "')}"`,
  );
}

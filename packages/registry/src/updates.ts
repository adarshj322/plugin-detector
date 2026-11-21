import type { CapabilityRecord } from "@plugin-detector/core";
import {
  DEFAULT_TIMEOUT_MS,
  httpGetJson,
  RateLimiter,
  SourceHttpError,
} from "./sources/http.js";
import { MAX_PACKAGE_METADATA_BYTES } from "./sources/package-registries.js";
import {
  GITHUB_API,
  githubLatestReleaseUrl,
  githubLatestTagUrl,
  parseGithubRelease,
  parseGithubRepo,
  parseGithubTag,
  type GithubRepo,
} from "./sources/updates-github.js";
import { npmLatestUrl, parseNpmLatest } from "./sources/updates-npm.js";
import { parsePypiLatest, pypiLatestUrl } from "./sources/updates-pypi.js";

// Public registries and the GitHub API are unauthenticated for these reads.
// One shared budget keeps a --check-updates run from hammering any of them.
export const UPDATE_REQUESTS_PER_MINUTE = 60;
export const UPDATE_LIMITER = new RateLimiter({
  requestsPerMinute: UPDATE_REQUESTS_PER_MINUTE,
});

export interface ResolveLatestVersionInput {
  kind?: string | undefined;
  sourceRef?: string | undefined;
  name?: string | undefined;
  packageName?: string | undefined;
  // Optional explicit evidence for candidate-backed lookups; sourceRef also
  // accepts a repository URL, so both spellings resolve identically.
  repositoryUrl?: string | undefined;
  packageRegistry?: "npm" | "pypi" | undefined;
}

export interface LatestVersion {
  version: string;
  sourceUrl: string;
  publishedAt?: string | undefined;
}

export interface UpdateResolverOptions {
  // Injected in tests; production uses the bounded JSON transport below.
  get?: ((url: string) => Promise<unknown>) | undefined;
  limiter?: RateLimiter | undefined;
  timeoutMs?: number | undefined;
  // Share a map across one run so a record checked twice costs one request.
  cache?: Map<string, Promise<LatestVersion | null>> | undefined;
}

export type LatestVersionResolver = (
  input: ResolveLatestVersionInput,
) => Promise<LatestVersion | null>;

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const SEMVERISH = /^v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;
// Installed specs are exact pins in practice; ranges still name the package.
const SEMVER_RANGE = /^[\^~<>=]*v?\d/;
const NPM_DIST_TAGS = new Set([
  "latest",
  "next",
  "beta",
  "alpha",
  "canary",
  "rc",
]);

type UpdateTarget =
  | { source: "npm" | "pypi"; name: string }
  | { source: "github"; repo: GithubRepo };

function isVersionLike(value: string): boolean {
  return (
    SEMVERISH.test(value) ||
    SEMVER_RANGE.test(value) ||
    NPM_DIST_TAGS.has(value.toLowerCase())
  );
}

// npm specs are `name`, `name@version`, or the same with a scope. Anything
// else (a path, a marketplace key like `name@official`) is not a package.
function npmNameOf(value: string): string | undefined {
  let text = value.trim();
  if (/^npm:/i.test(text)) text = text.slice(4);
  const at = text.lastIndexOf("@");
  if (at > 0 && isVersionLike(text.slice(at + 1))) {
    text = text.slice(0, at);
  }
  return NPM_NAME.test(text) ? text : undefined;
}

function packageTarget(
  source: "npm" | "pypi",
  value: string,
): UpdateTarget | null {
  if (source === "npm") {
    const name = npmNameOf(value);
    return name === undefined ? null : { source, name };
  }
  const name = value.trim();
  return PYPI_NAME.test(name) ? { source, name } : null;
}

function explicitTarget(value: string): UpdateTarget | null {
  const text = value.trim();
  if (text === "") return null;
  const pypi = /^pypi:(.*)$/i.exec(text);
  if (pypi !== null) return packageTarget("pypi", pypi[1] ?? "");
  const npm = /^npm:(.*)$/i.exec(text);
  if (npm !== null) return packageTarget("npm", npm[1] ?? "");
  const repo = parseGithubRepo(text);
  return repo === null ? null : { source: "github", repo };
}

// packageName is an explicit package source and wins over a display name.
// sourceRef carries the installed spec: a GitHub URL/git spec, an npm spec,
// or a local path that deliberately resolves to null. A bare `name` is never
// treated as a package because local skills and plugins carry display names.
function latestTarget(input: ResolveLatestVersionInput): UpdateTarget | null {
  const packageName = input.packageName?.trim() ?? "";
  if (packageName !== "") {
    const explicit = explicitTarget(packageName);
    if (explicit !== null) return explicit;
    const sourceRef = input.sourceRef?.trim() ?? "";
    const registry =
      input.packageRegistry ??
      (/^pypi:/i.test(sourceRef) ? "pypi" : "npm");
    return packageTarget(registry, packageName);
  }
  const sourceRef = input.sourceRef?.trim() ?? "";
  if (sourceRef !== "") {
    const target = explicitTarget(sourceRef) ?? packageTarget("npm", sourceRef);
    if (target !== null) return target;
  }
  const repositoryUrl = input.repositoryUrl?.trim() ?? "";
  if (repositoryUrl !== "") {
    const target = explicitTarget(repositoryUrl);
    if (target !== null) return target;
  }
  const name = input.name?.trim() ?? "";
  return name === "" ? null : explicitTarget(name);
}

function targetKey(target: UpdateTarget): string {
  return target.source === "github"
    ? `github:${target.repo.owner}/${target.repo.repo}`.toLowerCase()
    : `${target.source}:${target.name}`;
}

function latest(
  version: string,
  sourceUrl: string,
  publishedAt?: string | undefined,
): LatestVersion {
  return publishedAt === undefined
    ? { version, sourceUrl }
    : { version, sourceUrl, publishedAt };
}

interface ResolverIo {
  get: (url: string) => Promise<unknown>;
  limiter: RateLimiter;
}

async function githubLookup(
  repo: GithubRepo,
  io: ResolverIo,
): Promise<LatestVersion | null> {
  const releaseUrl = githubLatestReleaseUrl(repo);
  try {
    const parsed = parseGithubRelease(
      await io.limiter.run(() => io.get(releaseUrl)),
      repo,
    );
    if (parsed !== null) {
      return latest(parsed.version, parsed.sourceUrl, parsed.publishedAt);
    }
  } catch (error) {
    // A repository without releases is normal; fall back to its newest tag.
    if (!(error instanceof SourceHttpError && error.status === 404)) {
      throw error;
    }
  }
  const tagUrl = githubLatestTagUrl(repo);
  const parsed = parseGithubTag(
    await io.limiter.run(() => io.get(tagUrl)),
    repo,
  );
  return parsed === null
    ? null
    : latest(parsed.version, parsed.sourceUrl, parsed.publishedAt);
}

async function lookup(
  target: UpdateTarget,
  io: ResolverIo,
): Promise<LatestVersion | null> {
  if (target.source === "github") return githubLookup(target.repo, io);
  const url =
    target.source === "npm"
      ? npmLatestUrl(target.name)
      : pypiLatestUrl(target.name);
  const payload = await io.limiter.run(() => io.get(url));
  const parsed =
    target.source === "npm"
      ? parseNpmLatest(payload)
      : parsePypiLatest(payload);
  return parsed === null
    ? null
    : latest(parsed.version, url, parsed.publishedAt);
}

function defaultGet(
  url: string,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const headers = url.startsWith(GITHUB_API)
    ? {
        accept: "application/vnd.github+json",
        "user-agent": "plugin-detector",
      }
    : { accept: "application/json" };
  return httpGetJson<unknown>(url, {
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: MAX_PACKAGE_METADATA_BYTES,
    redirect: "error",
    headers,
  }).then((result) => result.data);
}

export function createLatestVersionResolver(
  opts: UpdateResolverOptions = {},
): LatestVersionResolver {
  const get =
    opts.get ?? ((url: string) => defaultGet(url, opts.timeoutMs));
  const limiter = opts.limiter ?? UPDATE_LIMITER;
  const cache =
    opts.cache ?? new Map<string, Promise<LatestVersion | null>>();
  return async (input: ResolveLatestVersionInput) => {
    const target = latestTarget(input);
    if (target === null) return null;
    const key = targetKey(target);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    // Offline, throttled, and malformed sources are all "unknown": a version
    // check must never fail the inventory or invent a comparison.
    const pending = lookup(target, { get, limiter }).catch(() => null);
    cache.set(key, pending);
    return pending;
  };
}

// One-shot convenience. Callers checking many records should keep one
// resolver from createLatestVersionResolver() so the per-run cache is shared.
export function resolveLatestVersion(
  input: ResolveLatestVersionInput,
  opts: UpdateResolverOptions = {},
): Promise<LatestVersion | null> {
  return createLatestVersionResolver(opts)(input);
}

// Attach upstream evidence only. updateStatus stays whatever inventory
// established; this step never decides current/outdated.
export async function applyLatestVersions(
  records: readonly CapabilityRecord[],
  resolve: LatestVersionResolver,
): Promise<CapabilityRecord[]> {
  return Promise.all(
    records.map(async (record) => {
      const resolved = await resolve({
        kind: record.kind,
        name: record.name,
        ...(record.sourceRef === undefined
          ? {}
          : { sourceRef: record.sourceRef }),
      });
      if (resolved === null) return record;
      return {
        ...record,
        latestVersion: resolved.version,
        latestSource: resolved.sourceUrl,
      };
    }),
  );
}

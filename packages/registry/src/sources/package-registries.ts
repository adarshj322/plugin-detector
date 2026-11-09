import { httpGetJson, RateLimiter } from "./http.js";

// npm and PyPI both answer unauthenticated metadata requests well above this
// rate; the shared budget keeps a refresh from hammering either registry.
export const PACKAGE_REGISTRY_REQUESTS_PER_MINUTE = 60;
export const PACKAGE_REGISTRY_LIMITER = new RateLimiter({
  requestsPerMinute: PACKAGE_REGISTRY_REQUESTS_PER_MINUTE,
});

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const PYPI_REGISTRY_URL = "https://pypi.org/pypi";

// Packuments for long-lived packages are large: @types/node is ~11 MB. Keep
// the metadata body bounded but above the shared 5 MiB listing default.
export const MAX_PACKAGE_METADATA_BYTES = 16 * 1024 * 1024;

export type PackageRegistry = "npm" | "pypi";
export type PackageProbeCode =
  | "ARTIFACT_MISSING"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_MISMATCH";

// Parsed registry metadata is the evidence source: the tarball URL is carried
// for provenance only and is never fetched or executed.
export interface PackageMetadata {
  registry: PackageRegistry;
  name: string;
  version: string;
  license: string;
  maintainers: string[];
  repositoryUrl?: string | undefined;
  homepage?: string | undefined;
  description?: string | undefined;
  deprecated?: string | undefined;
  tarball?: string | undefined;
  projectUrls?: Record<string, string> | undefined;
}

// Injected in tests as parsed JSON; production uses httpGetJson below.
export type PackageJsonGetter = (url: string) => Promise<unknown>;

// Unpaced transport only: probePackage applies the shared limiter around every
// request, including injected getters, so a caller's getter cannot bypass it.
export function packageRegistryGet(url: string): Promise<unknown> {
  return httpGetJson<unknown>(url, {
    maxBytes: MAX_PACKAGE_METADATA_BYTES,
  }).then((res) => res.data);
}

export function npmPackageUrl(name: string): string {
  // encodeURIComponent turns @scope/name into %40scope%2Fname, keeping the
  // whole package name one path segment.
  return `${NPM_REGISTRY_URL}/${encodeURIComponent(name)}`;
}

export function pypiPackageUrl(name: string): string {
  return `${PYPI_REGISTRY_URL}/${encodeURIComponent(name)}/json`;
}

export class PackageProbeError extends Error {
  constructor(
    readonly packageName: string,
    readonly code: PackageProbeCode,
    readonly reason: string,
  ) {
    super(`package ${quoted(packageName)} ${reason}`);
    this.name = "PackageProbeError";
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// Untrusted names end up in review reasons: quote-escape and cap them so a
// registry payload cannot forge log lines.
function quoted(value: string): string {
  const bounded = value.length <= 120 ? value : `${value.slice(0, 120)}...`;
  return JSON.stringify(bounded);
}

function bounded(value: string, max: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : line.slice(0, max);
}

function missing(packageName: string, reason: string): never {
  throw new PackageProbeError(packageName, "ARTIFACT_MISSING", reason);
}

function invalid(packageName: string, reason: string): never {
  throw new PackageProbeError(packageName, "ARTIFACT_INVALID", reason);
}

function mismatch(packageName: string, reason: string): never {
  throw new PackageProbeError(packageName, "ARTIFACT_MISMATCH", reason);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// npm license is a string or a { type } object; "UNKNOWN" is not a license.
function licenseOf(value: unknown): string | undefined {
  const direct = str(value) ?? str(record(value)?.["type"]);
  if (direct === undefined) return undefined;
  const firstLine = direct.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine === "" || /^unknown$/i.test(firstLine)) return undefined;
  return bounded(firstLine, 100);
}

function personName(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const name = text.split("<")[0]?.trim() ?? "";
  return name.length > 0 ? bounded(name, 100) : undefined;
}

function maintainerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const name =
      typeof entry === "string"
        ? personName(entry)
        : personName(record(entry)?.["name"]);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

// npm repository fields are strings or { url }, and often use git+ / ssh /
// github: shorthands. Normalize to a plain http(s) URL for evidence display.
function repositoryUrlOf(value: unknown): string | undefined {
  const raw =
    typeof value === "string" ? str(value) : str(record(value)?.["url"]);
  if (raw === undefined) return undefined;
  let url = raw;
  const shortcut = /^(github|gitlab|bitbucket):(.+)$/i.exec(url);
  if (shortcut !== null) {
    url = `https://${shortcut[1]!.toLowerCase()}.com/${shortcut[2]!}`;
  }
  url = url.replace(/^git\+/, "");
  const scp = /^git@([^:/\s]+):(.+)$/.exec(url);
  if (scp !== null) url = `https://${scp[1]}/${scp[2]}`;
  if (url.startsWith("git://")) url = `https://${url.slice("git://".length)}`;
  if (url.startsWith("ssh://")) {
    try {
      const parsed = new URL(url);
      url = `https://${parsed.hostname}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  }
  url = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function normalizePypiName(value: string): string {
  // PEP 503: -, _, and . are interchangeable in project names.
  return value.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function projectUrlsOf(value: unknown): Record<string, string> | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(fields)) {
    const url = str(entry);
    if (url !== undefined && key.trim() !== "") out[key.trim()] = url;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const CODE_HOST = /^https?:\/\/(?:www\.)?(?:github|gitlab|bitbucket)\./i;

function projectRepositoryUrl(
  urls: Record<string, string> | undefined,
): string | undefined {
  if (urls === undefined) return undefined;
  const entries = Object.entries(urls);
  const preferred = entries.find(([key]) =>
    /^(?:source|source code|repository|code|github)$/i.test(key),
  );
  const codeHost = entries.find(([, url]) => CODE_HOST.test(url));
  return repositoryUrlOf(preferred?.[1] ?? codeHost?.[1]);
}

function pypiHomepage(
  info: Record<string, unknown>,
  urls: Record<string, string> | undefined,
): string | undefined {
  const direct = str(info["home_page"]);
  if (direct !== undefined) return direct;
  for (const [key, url] of Object.entries(urls ?? {})) {
    if (/^(?:homepage|home)$/i.test(key)) return url;
  }
  return undefined;
}

export function parseNpmRegistry(
  payload: unknown,
  packageName: string,
  version?: string,
): PackageMetadata {
  const root = record(payload);
  if (root === undefined) {
    invalid(packageName, "npm registry response is not a JSON object");
  }
  const versions = record(root["versions"]);
  if (versions === undefined) {
    invalid(packageName, "npm registry response has no versions object");
  }
  const requested = str(version);
  const distTags = record(root["dist-tags"]);
  const resolved = requested ?? str(distTags?.["latest"]);
  if (resolved === undefined) {
    missing(packageName, "npm registry response has no latest dist-tag");
  }
  const entry = record(versions[resolved]);
  if (entry === undefined) {
    if (requested !== undefined) {
      missing(packageName, `version ${quoted(requested)} is not published`);
    }
    invalid(packageName, `latest version ${quoted(resolved)} is not published`);
  }

  const responseName = str(root["name"]) ?? str(entry["name"]) ?? packageName;
  if (responseName.toLowerCase() !== packageName.toLowerCase()) {
    mismatch(
      packageName,
      `registry returned package ${quoted(responseName)} instead`,
    );
  }
  const entryName = str(entry["name"]);
  if (
    entryName !== undefined &&
    entryName.toLowerCase() !== packageName.toLowerCase()
  ) {
    mismatch(
      packageName,
      `version metadata names package ${quoted(entryName)} instead`,
    );
  }
  const entryVersion = str(entry["version"]);
  if (entryVersion !== undefined && entryVersion !== resolved) {
    invalid(
      packageName,
      `version metadata ${quoted(entryVersion)} does not match ${quoted(resolved)}`,
    );
  }

  const license =
    licenseOf(entry["license"]) ?? licenseOf(root["license"]) ?? "unknown";
  const maintainers = maintainerNames(entry["maintainers"]);
  const metadata: PackageMetadata = {
    registry: "npm",
    name: responseName,
    version: resolved,
    license,
    maintainers:
      maintainers.length > 0 ? maintainers : maintainerNames(root["maintainers"]),
  };
  const repositoryUrl =
    repositoryUrlOf(entry["repository"]) ??
    repositoryUrlOf(root["repository"]);
  if (repositoryUrl !== undefined) metadata.repositoryUrl = repositoryUrl;
  const homepage = str(entry["homepage"]) ?? str(root["homepage"]);
  if (homepage !== undefined) metadata.homepage = homepage;
  const description = str(entry["description"]) ?? str(root["description"]);
  if (description !== undefined) {
    metadata.description = bounded(description, 300);
  }
  const deprecated = str(entry["deprecated"]) ?? str(root["deprecated"]);
  if (deprecated !== undefined) metadata.deprecated = deprecated;
  const tarball = str(record(entry["dist"])?.["tarball"]);
  if (tarball !== undefined) metadata.tarball = tarball;
  return metadata;
}

export function parsePypiRegistry(
  payload: unknown,
  packageName: string,
  version?: string,
): PackageMetadata {
  const root = record(payload);
  if (root === undefined) {
    invalid(packageName, "pypi response is not a JSON object");
  }
  const info = record(root["info"]);
  if (info === undefined) {
    invalid(packageName, "pypi response has no info object");
  }
  const responseName = str(info["name"]);
  if (responseName === undefined) {
    invalid(packageName, "pypi response has no package name");
  }
  if (normalizePypiName(responseName) !== normalizePypiName(packageName)) {
    mismatch(
      packageName,
      `registry returned package ${quoted(responseName)} instead`,
    );
  }
  const requested = str(version);
  const resolved = requested ?? str(info["version"]);
  if (resolved === undefined) {
    missing(packageName, "pypi response has no version");
  }
  const releases = record(root["releases"]);
  if (releases === undefined) {
    invalid(packageName, "pypi response has no releases object");
  }
  if (!hasOwn(releases, resolved)) {
    if (requested !== undefined) {
      missing(packageName, `version ${quoted(requested)} is not published`);
    }
    invalid(
      packageName,
      `latest version ${quoted(resolved)} is not in the releases list`,
    );
  }

  const projectUrls = projectUrlsOf(info["project_urls"]);
  const metadata: PackageMetadata = {
    registry: "pypi",
    name: responseName,
    version: resolved,
    license:
      licenseOf(info["license_expression"]) ??
      licenseOf(info["license"]) ??
      "unknown",
    maintainers: [
      ...new Set(
        [personName(info["author"]), personName(info["maintainer"])].filter(
          (name): name is string => name !== undefined,
        ),
      ),
    ],
  };
  const repositoryUrl = projectRepositoryUrl(projectUrls);
  if (repositoryUrl !== undefined) metadata.repositoryUrl = repositoryUrl;
  const homepage = pypiHomepage(info, projectUrls);
  if (homepage !== undefined) metadata.homepage = homepage;
  const description = str(info["summary"]) ?? str(info["description"]);
  if (description !== undefined) {
    metadata.description = bounded(description, 300);
  }
  if (projectUrls !== undefined) metadata.projectUrls = projectUrls;
  return metadata;
}

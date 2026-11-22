import type { RawCandidate } from "./probe.js";
import { GITHUB_LIMITER } from "./sources/github.js";
import { httpGetJson } from "./sources/http.js";
import { isOfficialPublisher } from "./trust.js";

// Publisher candidates discovered through community listings (skills.sh,
// awesome lists, GitHub search) often lack the repository license and activity
// evidence that trust classification needs. This enrichment reads only public
// repository metadata for the allowlisted publisher orgs; it never fetches or
// executes the artifact again.
export interface GithubRepoMetadata {
  license?: string | undefined;
  pushedAt?: string | undefined;
  stars?: number | undefined;
  archived: boolean;
}

export type PublisherMetadataGetter = (url: string) => Promise<{ data: unknown }>;

export interface EnrichPublisherOptions {
  get?: PublisherMetadataGetter;
  // Per-run cache: one request per repository, including negative results.
  cache?: Map<string, Promise<GithubRepoMetadata | null>>;
}

const defaultCache = new Map<string, Promise<GithubRepoMetadata | null>>();

function githubRepo(value: string): { owner: string; repo: string } | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, "");
  return owner === undefined || repo === undefined
    ? undefined
    : { owner, repo };
}

function defaultGet(url: string): Promise<{ data: unknown }> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return httpGetJson(url, {
    limiter: GITHUB_LIMITER,
    redirect: "error",
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseMetadata(data: unknown): GithubRepoMetadata | null {
  const body = record(data);
  if (body === undefined) return null;
  const licenseRecord = record(body["license"]);
  const spdx = licenseRecord?.["spdx_id"];
  const license =
    typeof spdx === "string" &&
    spdx.trim() !== "" &&
    spdx.trim().toUpperCase() !== "NOASSERTION"
      ? spdx.trim()
      : undefined;
  const pushedRaw = body["pushed_at"];
  const pushedAt =
    typeof pushedRaw === "string" &&
    !Number.isNaN(Date.parse(pushedRaw))
      ? pushedRaw
      : undefined;
  const starsRaw = body["stargazers_count"];
  const stars =
    typeof starsRaw === "number" &&
    Number.isFinite(starsRaw) &&
    starsRaw >= 0
      ? Math.floor(starsRaw)
      : undefined;
  return {
    ...(license === undefined ? {} : { license }),
    ...(pushedAt === undefined ? {} : { pushedAt }),
    ...(stars === undefined ? {} : { stars }),
    archived: body["archived"] === true,
  };
}

async function metadataFor(
  owner: string,
  repo: string,
  opts: EnrichPublisherOptions,
): Promise<GithubRepoMetadata | null> {
  const cache = opts.cache ?? defaultCache;
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const get = opts.get ?? defaultGet;
  const url = `https://api.github.com/repos/${encodeURIComponent(
    owner,
  )}/${encodeURIComponent(repo)}`;
  const pending = get(url)
    .then((result) => parseMetadata(result.data))
    .catch(() => null);
  cache.set(key, pending);
  return pending;
}

export async function enrichPublisherCandidate(
  raw: RawCandidate,
  opts: EnrichPublisherOptions = {},
): Promise<RawCandidate> {
  if (raw.repositoryUrl === undefined || !isOfficialPublisher(raw)) return raw;
  const repo = githubRepo(raw.repositoryUrl);
  if (repo === undefined) return raw;
  // GitHub search already supplies this; skip the extra request when both
  // trust-relevant fields are present.
  if (
    raw.pushedAt !== undefined &&
    raw.license !== undefined &&
    raw.license.trim() !== "" &&
    raw.license.trim().toLowerCase() !== "unknown"
  ) {
    return raw;
  }
  const metadata = await metadataFor(repo.owner, repo.repo, opts);
  if (metadata === null) return raw;

  const licenseMissing =
    raw.license === undefined ||
    raw.license.trim() === "" ||
    raw.license.trim().toLowerCase() === "unknown";
  const nextStars =
    raw.popularity?.stars === undefined && metadata.stars !== undefined
      ? { ...(raw.popularity ?? {}), stars: metadata.stars }
      : raw.popularity;
  return {
    ...raw,
    ...(licenseMissing && metadata.license !== undefined
      ? { license: metadata.license }
      : {}),
    ...(raw.pushedAt === undefined && metadata.pushedAt !== undefined
      ? { pushedAt: metadata.pushedAt }
      : {}),
    ...(nextStars === undefined ? {} : { popularity: nextStars }),
    ...(metadata.archived ? { maintenance: "archived" as const } : {}),
  };
}

import {
  isoOrUndefined,
  record,
  str,
  versionOf,
} from "./updates-common.js";

// GitHub API is used without a token: the release and tag endpoints are
// public and rate-limit unauthenticated callers generously enough for an
// explicit --check-updates run.
export const GITHUB_API = "https://api.github.com";

export interface GithubRepo {
  owner: string;
  repo: string;
}

const REPO_PART = /^[A-Za-z0-9_.-]+$/;

function repoParts(value: string): GithubRepo | null {
  const text = value.trim().replace(/^\/+/, "");
  const slash = text.indexOf("/");
  if (slash <= 0) return null;
  const owner = text.slice(0, slash);
  const repo = text
    .slice(slash + 1)
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo)) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    return null;
  }
  return { owner, repo };
}

// Accepts the `github:` shorthand and any repository spelling that embeds a
// github.com URL, including git+, ssh, and scp forms.
export function parseGithubRepo(value: string): GithubRepo | null {
  const text = value.trim();
  const prefixed = /^github:(.*)$/i.exec(text);
  if (prefixed !== null) return repoParts(prefixed[1] ?? "");
  const match =
    /(?:^|[/@:])(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(
      text,
    );
  return match === null ? null : repoParts(`${match[1]}/${match[2]}`);
}

export function githubLatestReleaseUrl(repo: GithubRepo): string {
  return `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases/latest`;
}

export function githubLatestTagUrl(repo: GithubRepo): string {
  return `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/tags?per_page=1`;
}

export interface GithubLatest {
  version: string;
  sourceUrl: string;
  publishedAt?: string | undefined;
}

function tagPage(repo: GithubRepo, tag: string): string {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(tag)}`;
}

function releasePage(value: unknown, repo: GithubRepo, tag: string): string {
  const url = str(value);
  if (url === undefined) return tagPage(repo, tag);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && /(^|\.)github\.com$/i.test(parsed.hostname)) {
      return parsed.toString();
    }
  } catch {
    // Fall through to the canonical tag page.
  }
  return tagPage(repo, tag);
}

export function parseGithubRelease(
  payload: unknown,
  repo: GithubRepo,
): GithubLatest | null {
  const root = record(payload);
  if (root === undefined) return null;
  const version = versionOf(root["tag_name"]);
  if (version === undefined) return null;
  const latest: GithubLatest = {
    version,
    sourceUrl: releasePage(root["html_url"], repo, version),
  };
  const publishedAt = isoOrUndefined(root["published_at"]);
  if (publishedAt !== undefined) latest.publishedAt = publishedAt;
  return latest;
}

export function parseGithubTag(
  payload: unknown,
  repo: GithubRepo,
): GithubLatest | null {
  if (!Array.isArray(payload)) return null;
  const version = versionOf(record(payload[0])?.["name"]);
  return version === undefined
    ? null
    : { version, sourceUrl: tagPage(repo, version) };
}

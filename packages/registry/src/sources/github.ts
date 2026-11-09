import type { RawCandidate } from "../probe.js";
import {
  GITHUB_SEARCH_REQUESTS_PER_MINUTE,
  httpGetText,
  RateLimiter,
  type HttpGetter,
  type SourceFetch,
  type SourceFetchFailure,
} from "./http.js";

export const GITHUB_ID = "github";
export const GITHUB_URL = "https://api.github.com/search/repositories";
export const GITHUB_PER_PAGE = 100;
export const GITHUB_MAX_PAGES = 3;
// Seven default topics keep a fair 70-repo share each (490 total, under the
// 500 global cap), so one topic can never consume the plan before the rest run.
export const GITHUB_MAX_PER_QUERY = 70;
export const GITHUB_MAX_CANDIDATES = 500;

// Discovery terms, not evidence: each topic selects listings only. Query text
// never becomes capabilities or any other scoring field.
export const GITHUB_TOPIC_QUERIES = [
  "mcp",
  "mcp-server",
  "claude-plugin",
  "claude-code-plugin",
  "opencode-plugin",
  "agent-skill",
  "llm-tools",
] as const;

// GitHub search allows 10 requests/min unauthenticated. Exported so callers
// and tests can see the production refresh path is paced.
export const GITHUB_LIMITER = new RateLimiter({
  requestsPerMinute: GITHUB_SEARCH_REQUESTS_PER_MINUTE,
});

interface GithubRepo {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  default_branch?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  archived?: unknown;
  license?: { spdx_id?: unknown } | null;
}

export interface FetchGithubOptions {
  queries?: readonly string[] | undefined;
  // Token for the default transport only. The production refresh caller owns
  // its bound getter and adds Authorization there; this module never reads
  // GITHUB_TOKEN itself.
  token?: string | undefined;
  get?: HttpGetter | undefined;
  // Test seam mirroring HttpOptions; production uses GITHUB_LIMITER.
  limiter?: RateLimiter | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// Topics are self-declared: carried never (no capabilities/topics mapping -
// the evidence gate in normalize only reads the artifact ref).
export function parseGithubSearch(payload: unknown): RawCandidate[] {
  const root = payload as { items?: unknown };
  const items = Array.isArray(root?.items) ? root.items : [];
  const out: RawCandidate[] = [];
  for (const item of items as GithubRepo[]) {
    const id = str(item.full_name);
    const url = str(item.html_url);
    if (!id || !url) continue;
    const spdx =
      item.license && typeof item.license.spdx_id === "string"
        ? item.license.spdx_id
        : undefined;
    const branch = str(item.default_branch);
    const stars = count(item.stargazers_count);
    const pushedAt = str(item.pushed_at);
    const archived = item.archived === true;
    out.push({
      id,
      name: id,
      artifact: { kind: "plugin", file: "plugin.json" },
      artifactProbed: false,
      sourceKind: "community",
      pinnedRef: "0.0.0",
      license: spdx && spdx !== "NOASSERTION" ? spdx : "unknown",
      repositoryUrl: url,
      description: str(item.description),
      // HEAD is assumed when the API omits the branch; the flag lets the
      // artifact prober skip an identical second attempt.
      defaultBranch: branch ?? "HEAD",
      ...(branch === undefined ? { defaultBranchFallback: true } : {}),
      ...(stars === undefined ? {} : { popularity: { stars } }),
      ...(pushedAt === undefined ? {} : { pushedAt }),
      ...(archived ? { maintenance: "archived" as const } : {}),
    });
  }
  return out;
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

function searchUrl(query: string, page: number): string {
  const params = new URLSearchParams({
    // is:public keeps authenticated searches from ingesting private repos.
    q: `topic:${query} is:public`,
    per_page: String(GITHUB_PER_PAGE),
    page: String(page),
  });
  return `${GITHUB_URL}?${params.toString()}`;
}

function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Never echo the body: V8 quotes it in parse errors.
    throw new Error(`github: GET ${url} returned invalid JSON`);
  }
}

function itemsOf(payload: unknown, query: string): unknown[] {
  const root = payload as { items?: unknown };
  if (!Array.isArray(root?.items)) {
    throw new Error(`github: search for "${query}" returned no items array`);
  }
  return root.items;
}

// GitHub marks a search response incomplete when its own backend timed out.
// The records are usable but the page cannot be treated as a clean success.
function incompleteResults(payload: unknown): boolean {
  const root = payload as { incomplete_results?: unknown };
  return root?.incomplete_results === true;
}

// Unpaced default transport only: fetchGithub wraps every request, including
// an injected getter, so the cache's timeout-bound getter cannot skip pacing.
function githubGet(token: string | undefined): HttpGetter {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  return (url) => httpGetText(url, { headers });
}

export async function fetchGithub(
  opts: FetchGithubOptions = {},
): Promise<SourceFetch> {
  const get = opts.get ?? githubGet(opts.token);
  const limiter = opts.limiter ?? GITHUB_LIMITER;
  const queries = normalizeQueries(opts.queries ?? GITHUB_TOPIC_QUERIES);
  const byId = new Map<string, RawCandidate>();
  const failures: SourceFetchFailure[] = [];
  let succeeded = 0;
  let firstError: unknown;
  for (const query of queries) {
    const found = new Map<string, RawCandidate>();
    let incomplete = false;
    try {
      for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
        const url = searchUrl(query, page);
        const res = await limiter.run(() => get(url));
        const payload = parseJson(res.text, url);
        const items = itemsOf(payload, query);
        const parsed = parseGithubSearch(payload);
        // A non-empty page mapping to zero records is a schema failure; other
        // queries still contribute when they succeed.
        if (items.length > 0 && parsed.length === 0) {
          throw new Error(
            `github: search for "${query}" listed ${items.length} repositories but none matched the expected schema`,
          );
        }
        if (incompleteResults(payload)) incomplete = true;
        for (const raw of parsed) {
          if (raw.id !== undefined && !found.has(raw.id)) found.set(raw.id, raw);
        }
        let newUnique = 0;
        for (const id of found.keys()) {
          if (!byId.has(id)) newUnique += 1;
        }
        if (newUnique >= GITHUB_MAX_PER_QUERY) break;
        if (items.length < GITHUB_PER_PAGE) break;
      }
      let added = 0;
      for (const [id, raw] of found) {
        if (byId.size >= GITHUB_MAX_CANDIDATES || added >= GITHUB_MAX_PER_QUERY) {
          break;
        }
        if (byId.has(id)) continue;
        byId.set(id, raw);
        added += 1;
      }
      succeeded += 1;
      if (incomplete) failures.push({ query, error: "incomplete results" });
    } catch (error) {
      // One failed query must not discard the others; the failure is carried
      // so the refresh caller can preserve that query's prior entries.
      if (firstError === undefined) firstError = error;
      failures.push({
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (byId.size >= GITHUB_MAX_CANDIDATES) break;
  }
  // Nothing succeeded: surface the first failure instead of an empty harvest.
  if (succeeded === 0 && firstError !== undefined) throw firstError;
  const fetch: SourceFetch = { raws: [...byId.values()] };
  if (failures.length > 0) {
    fetch.partial = true;
    fetch.failures = failures;
  }
  return fetch;
}

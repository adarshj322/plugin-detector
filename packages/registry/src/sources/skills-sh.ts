import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  RateLimiter,
  type HttpGetter,
  type HttpResult,
  type SourceFetch,
} from "./http.js";

export const SKILLS_SH_ID = "skills-sh";
export const SKILLS_SH_URL = "https://skills.sh/api/search";
export const SKILLS_SH_REQUESTS_PER_MINUTE = 60;
export const SKILLS_SH_MAX_CANDIDATES = 400;

// Discovery terms, not evidence: query text only selects listings.
export const DEFAULT_SKILL_QUERIES = [
  "agent",
  "mcp",
  "claude",
  "testing",
  "review",
  "video",
  "design",
  "data",
  "docs",
] as const;

// skills.sh rate limit: search and download share one 60/min budget.
const skillsShLimiter = new RateLimiter({
  requestsPerMinute: SKILLS_SH_REQUESTS_PER_MINUTE,
});

export function skillsShGet(url: string): Promise<HttpResult> {
  return httpGetText(url, { limiter: skillsShLimiter });
}

interface SkillsShItem {
  id?: unknown;
  source?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
}

export interface FetchSkillsShOptions {
  queries?: readonly string[] | undefined;
  get?: HttpGetter | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function installs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// Listing fields are carried for discovery only: no capabilities, domains, or
// evidence come from a search hit. The download probe supplies those.
export function parseSkillsShSearch(payload: unknown): RawCandidate[] {
  const root = record(payload);
  const items = Array.isArray(root?.["skills"]) ? root["skills"] : [];
  const out: RawCandidate[] = [];
  for (const item of items as SkillsShItem[]) {
    const id = str(item.id);
    const source = str(item.source);
    const skillId = str(item.skillId);
    if (!id || !source || !skillId) continue;
    const popularity = installs(item.installs);
    out.push({
      id,
      name: str(item.name) ?? skillId,
      artifact: { kind: "skill", file: "SKILL.md", artifactId: skillId },
      artifactProbed: false,
      sourceKind: "community",
      pinnedRef: "0.0.0",
      license: "unknown",
      repositoryUrl: `https://github.com/${source}`,
      ...(popularity === undefined ? {} : { popularity: { installs: popularity } }),
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

function searchUrl(query: string): string {
  return `${SKILLS_SH_URL}?q=${encodeURIComponent(query)}`;
}

function parseJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Never echo the body: V8 quotes it in parse errors.
    throw new Error(`skills-sh: GET ${url} returned invalid JSON`);
  }
}

export async function fetchSkillsSh(
  opts: FetchSkillsShOptions = {},
): Promise<SourceFetch> {
  const get = opts.get ?? skillsShGet;
  const queries = normalizeQueries(opts.queries ?? DEFAULT_SKILL_QUERIES);
  const byId = new Map<string, RawCandidate>();
  let reported = 0;
  for (const query of queries) {
    const url = searchUrl(query);
    const res = await get(url);
    const payload = parseJson(res.text, url);
    const root = record(payload);
    const skills = root?.["skills"];
    if (!Array.isArray(skills)) {
      throw new Error(
        `skills-sh: search for "${query}" returned no skills array`,
      );
    }
    reported += skills.length;
    for (const raw of parseSkillsShSearch(payload)) {
      if (byId.size >= SKILLS_SH_MAX_CANDIDATES) break;
      if (raw.id !== undefined && !byId.has(raw.id)) byId.set(raw.id, raw);
    }
    if (byId.size >= SKILLS_SH_MAX_CANDIDATES) break;
  }
  const raws = [...byId.values()];
  // A non-empty result set that maps to zero records is a schema failure, not
  // a valid empty harvest.
  if (reported > 0 && raws.length === 0) {
    throw new Error(
      `skills-sh: search listed ${reported} skills but none matched the expected schema`,
    );
  }
  return { raws };
}

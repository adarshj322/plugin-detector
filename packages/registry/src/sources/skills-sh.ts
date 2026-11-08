import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  type HttpGetter,
  type SourceFetch,
} from "./http.js";

// Default endpoint; override via fetcher injection (refresh takes fetchers).
export const SKILLS_SH_ID = "skills-sh";
export const SKILLS_SH_URL = "https://skills.sh/api/skills";

interface SkillsShItem {
  id?: unknown;
  name?: unknown;
  repository?: unknown;
  url?: unknown;
  description?: unknown;
  license?: unknown;
  version?: unknown;
  capabilities?: unknown;
  domains?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strs(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

// shortcut: listings without a version pin to 0.0.0 (unknown, never a
// branch); upgrade when a source publishes immutable refs we can carry over.
export function parseSkillsSh(payload: unknown): RawCandidate[] {
  const items = Array.isArray(payload) ? payload : [];
  const out: RawCandidate[] = [];
  for (const item of items as SkillsShItem[]) {
    const id = str(item.id) ?? str(item.name);
    const url = str(item.repository) ?? str(item.url);
    if (!id || !url) continue;
    const raw: RawCandidate = {
      id,
      name: str(item.name) ?? id,
      artifact: {
        kind: "skill",
        file: "SKILL.md",
        capabilities: strs(item.capabilities),
        domains: strs(item.domains),
      },
      sourceKind: "community",
      pinnedRef: str(item.version) ?? "0.0.0",
      license: str(item.license) ?? "unknown",
      repositoryUrl: url,
      description: str(item.description),
    };
    out.push(raw);
  }
  return out;
}

export async function fetchSkillsSh(
  get: HttpGetter = (url) => httpGetText(url),
): Promise<SourceFetch> {
  const res = await get(SKILLS_SH_URL);
  const fetch: SourceFetch = { raws: parseSkillsSh(JSON.parse(res.text)) };
  if (res.etag) fetch.etag = res.etag;
  if (res.lastModified) fetch.lastModified = res.lastModified;
  return fetch;
}

import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  type HttpGetter,
  type SourceFetch,
} from "./http.js";

export const GITHUB_ID = "github";
export const GITHUB_URL =
  "https://api.github.com/search/repositories?q=topic:claude-plugin+topic:mcp&per_page=100";

interface GithubRepo {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  license?: { spdx_id?: unknown } | null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
    });
  }
  return out;
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json" };

export async function fetchGithub(
  get: HttpGetter = (url) => httpGetText(url, { headers: GITHUB_HEADERS }),
): Promise<SourceFetch> {
  const res = await get(GITHUB_URL);
  const payload = JSON.parse(res.text) as unknown;
  const raws = parseGithubSearch(payload);
  const root = payload as { items?: unknown };
  const reported = Array.isArray(root.items) ? root.items.length : 0;
  if (reported > 0 && raws.length === 0) {
    throw new Error(
      `github: payload listed ${reported} repositories but none matched the expected schema`,
    );
  }
  const fetch: SourceFetch = { raws };
  if (res.etag) fetch.etag = res.etag;
  if (res.lastModified) fetch.lastModified = res.lastModified;
  return fetch;
}

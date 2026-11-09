import type { RawCandidate } from "../probe.js";
import {
  httpGetText,
  type HttpGetter,
  type SourceFetch,
} from "./http.js";

export const AWESOME_LISTS_ID = "awesome-lists";
export const AWESOME_LISTS_URL =
  "https://raw.githubusercontent.com/anthropics/awesome-claude-plugins/main/README.md";

const GITHUB_LINK = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)/g;

// Awesome lists are markdown, not JSON: each GitHub link becomes a
// plugin-shaped record with no evidence beyond the artifact ref (topics and
// list blurbs never become capabilities).
export function parseAwesomeList(markdown: string): RawCandidate[] {
  const seen = new Set<string>();
  const out: RawCandidate[] = [];
  for (const match of markdown.matchAll(GITHUB_LINK)) {
    const slug = match[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      id: slug,
      name: slug,
      artifact: { kind: "plugin", file: "plugin.json" },
      artifactProbed: false,
      sourceKind: "community",
      pinnedRef: "0.0.0",
      license: "unknown",
      repositoryUrl: `https://github.com/${slug}`,
    });
  }
  return out;
}

export async function fetchAwesomeLists(
  get: HttpGetter = (url) => httpGetText(url),
): Promise<SourceFetch> {
  const res = await get(AWESOME_LISTS_URL);
  const raws = parseAwesomeList(res.text);
  // A non-empty list with no GitHub links means the page shape changed; that
  // is a source failure, not a valid empty harvest.
  if (res.text.trim().length > 0 && raws.length === 0) {
    throw new Error(
      "awesome-lists: list page returned content but no GitHub repository links",
    );
  }
  const fetch: SourceFetch = { raws };
  if (res.etag) fetch.etag = res.etag;
  if (res.lastModified) fetch.lastModified = res.lastModified;
  return fetch;
}

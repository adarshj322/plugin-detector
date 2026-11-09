import { createHash } from "node:crypto";
import type { ArtifactEvidence, RawCandidate } from "./probe.js";
import { type HttpGetter, SourceHttpError } from "./sources/http.js";
import { SKILLS_SH_LIMITER, skillsShGet } from "./sources/skills-sh.js";

export const SKILLS_SH_DOWNLOAD_URL = "https://skills.sh/api/download";
export const MAX_EVIDENCE_SNIPPET_LENGTH = 300;

export type SkillsShProbeCode =
  | "ARTIFACT_MISSING"
  | "ARTIFACT_MISMATCH"
  | "ARTIFACT_UNAVAILABLE";

// Typed probe refusal: the candidate id and reason survive into the refresh
// manifest so rejected skills remain reviewable.
export class SkillsShProbeError extends Error {
  constructor(
    readonly candidateId: string,
    readonly code: SkillsShProbeCode,
    readonly reason: string,
  ) {
    super(`skills-sh: candidate "${candidateId}" ${reason}`);
    this.name = "SkillsShProbeError";
  }
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string | undefined;
  version?: string | undefined;
}

interface ListingParts {
  owner: string;
  repo: string;
  slug: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function candidateId(raw: RawCandidate): string {
  return raw.id ?? raw.artifact?.artifactId ?? raw.name ?? "unknown";
}

// Search ids are owner/repo/skill-id and repositoryUrl is the GitHub source;
// either can reconstruct the download path, so a manually built listing works.
function listingParts(raw: RawCandidate): ListingParts | null {
  let owner: string | undefined;
  let repo: string | undefined;
  if (raw.repositoryUrl !== undefined) {
    try {
      const url = new URL(raw.repositoryUrl);
      if (url.hostname.toLowerCase() === "github.com") {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
          owner = segments[0];
          repo = segments[1];
        }
      }
    } catch {
      // Fall through to the listing id.
    }
  }
  const idParts = (raw.id ?? "").split("/").filter(Boolean);
  if ((owner === undefined || repo === undefined) && idParts.length >= 3) {
    owner = idParts[0];
    repo = idParts[1];
  }
  if (owner === undefined || repo === undefined) return null;
  const slug =
    raw.artifact?.artifactId ??
    (idParts.length >= 3 && idParts[0] === owner && idParts[1] === repo
      ? idParts.slice(2).join("/")
      : raw.name);
  if (slug === undefined || slug === "") return null;
  if (
    !validPathSegment(owner) ||
    !validPathSegment(repo) ||
    !validPathSegment(slug)
  ) {
    return null;
  }
  return { owner, repo, slug };
}

function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validPathSegment(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !/[/\\]/.test(value)
  );
}

function unquote(value: string): string {
  const match = /^(?:"([\s\S]*)"|'([\s\S]*)')$/.exec(value);
  if (match === null) return value;
  return match[1] ?? match[2] ?? "";
}

// Minimal top-level YAML frontmatter reader: enough for name/description/
// license/version scalars and |/> block values. No YAML dependency.
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return null;
  const fields = new Map<string, string>();
  let blockKey: string | undefined;
  let blockLines: string[] = [];
  const flush = (): void => {
    if (blockKey === undefined) return;
    fields.set(blockKey, blockLines.join("\n").trim());
    blockKey = undefined;
    blockLines = [];
  };
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (blockKey !== undefined) {
      if (line.trim() === "" || /^\s/.test(line)) {
        blockLines.push(line.trim());
        continue;
      }
      flush();
    }
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field === null) continue;
    const key = (field[1] ?? "").toLowerCase();
    const rawValue = (field[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(rawValue)) {
      blockKey = key;
      continue;
    }
    const value = unquote(rawValue);
    if (value !== "") fields.set(key, value);
  }
  flush();
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) return null;
  const out: SkillFrontmatter = { name, description };
  const license = fields.get("license");
  if (license !== undefined) out.license = license;
  const version = fields.get("version");
  if (version !== undefined) out.version = version;
  return out;
}

function skillMarkdown(files: unknown): string | undefined {
  if (!Array.isArray(files)) return undefined;
  for (const item of files as Array<{ path?: unknown; contents?: unknown }>) {
    if (typeof item.path !== "string" || typeof item.contents !== "string") {
      continue;
    }
    const path = item.path
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .toLowerCase();
    if (path === "skill.md") return item.contents;
  }
  return undefined;
}

function snippet(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= MAX_EVIDENCE_SNIPPET_LENGTH
    ? singleLine
    : singleLine.slice(0, MAX_EVIDENCE_SNIPPET_LENGTH);
}

export async function probeSkillsSh(
  raw: RawCandidate,
  get: HttpGetter = skillsShGet,
): Promise<RawCandidate> {
  const id = candidateId(raw);
  const parts = listingParts(raw);
  if (parts === null) {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISSING",
      "listing has no GitHub owner/repo and skill slug",
    );
  }
  const url = `${SKILLS_SH_DOWNLOAD_URL}/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/${encodeURIComponent(parts.slug)}`;
  let text: string;
  try {
    // Pace injected getters too: cache's timeout-bound wrapper carries no
    // limiter of its own. Wrap exactly once here.
    text = (await SKILLS_SH_LIMITER.run(() => get(url))).text;
  } catch (error) {
    // A missing skill is a hard rejection; only transport/timeout/throttle/
    // server failures are transient.
    if (
      error instanceof SourceHttpError &&
      (error.status === 404 || error.status === 410)
    ) {
      throw new SkillsShProbeError(
        id,
        "ARTIFACT_MISSING",
        `download returned HTTP ${error.status}`,
      );
    }
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_UNAVAILABLE",
      `download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISSING",
      "download payload is not valid JSON",
    );
  }
  const root = record(payload);
  const hash = str(root?.["hash"]);
  if (hash === undefined) {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISSING",
      "download payload has no hash",
    );
  }
  const skillMd = skillMarkdown(root?.["files"]);
  if (skillMd === undefined) {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISSING",
      "download payload has no SKILL.md",
    );
  }
  const frontmatter = parseSkillFrontmatter(skillMd);
  if (frontmatter === null) {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISSING",
      "SKILL.md has no name/description frontmatter",
    );
  }
  const resolvedRef = `skills.sh:${hash}`;
  const hashMatches = raw.pinnedRef === resolvedRef || raw.pinnedRef === hash;
  if (
    normalizeSkillName(frontmatter.name) !== normalizeSkillName(parts.slug) &&
    !hashMatches
  ) {
    throw new SkillsShProbeError(
      id,
      "ARTIFACT_MISMATCH",
      `SKILL.md name "${frontmatter.name}" does not match listing "${parts.slug}"`,
    );
  }
  const license = frontmatter.license ?? str(raw.license) ?? "unknown";
  const evidence: ArtifactEvidence = {
    kind: "skill",
    sourceUrl: url,
    resolvedRef,
    contentHash: createHash("sha256").update(skillMd).digest("hex"),
    license,
    name: frontmatter.name,
    capabilities: [],
    evidenceSnippets: [
      snippet(`name: ${frontmatter.name}`),
      snippet(`description: ${frontmatter.description}`),
    ],
    retrievedAt: new Date().toISOString(),
  };
  if (frontmatter.version !== undefined) evidence.version = frontmatter.version;
  return {
    ...raw,
    name: raw.name ?? frontmatter.name,
    description: frontmatter.description,
    license,
    // The download hash is immutable, so it replaces the unknown 0.0.0 pin.
    pinnedRef: resolvedRef,
    artifactProbed: true,
    artifactProbe: evidence,
  };
}

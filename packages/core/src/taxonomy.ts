// v1 canonical capability vocabulary. All comparisons and overlap detection
// run on these IDs; adapters map local names via capabilityId (spec: Shared
// capability taxonomy). Extended only through ADR-style changes, never ad-hoc.
export const CANONICAL_CAPABILITY_IDS = [
  "testing.runner",
  "testing.e2e",
  "code-review.quality",
  "code-review.security",
  "planning.orchestration",
  "planning.brainstorm",
  "debugging.systematic",
  "vcs.workflow",
  "ci.release",
  "containers.orchestration",
  "docs.writing",
  "design.frontend",
  "design.thumbnail",
  "data.analysis",
  "media.transcode",
  "speech.captions",
  "publishing.delivery",
  "security.dependencies",
  "harness.management",
] as const;
export type CanonicalCapabilityId =
  (typeof CANONICAL_CAPABILITY_IDS)[number];

// Separator-blind key: lowercase, drop every non-alphanumeric run, so
// "Code Review_Quality" and "code-review.quality" compare equal.
function blindKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const CANONICAL_BY_KEY = new Map<string, CanonicalCapabilityId>(
  CANONICAL_CAPABILITY_IDS.map((id) => [blindKey(id), id]),
);

// One explicit alias table for local names with no exact match.
// shortcut: ambiguous shorthands (e.g. "code review") resolve to null rather
// than guessing; extend this table only via ADR-style profile changes.
const ALIASES: Record<string, CanonicalCapabilityId> = {
  e2e: "testing.e2e",
  endtoend: "testing.e2e",
  thumbnails: "design.thumbnail",
  transcoding: "media.transcode",
  captions: "speech.captions",
  subtitles: "speech.captions",
  cicd: "ci.release",
  dependencies: "security.dependencies",
  dependencyscanning: "security.dependencies",
};

export function capabilityId(value: string): string | null {
  const key = blindKey(value);
  if (key.length === 0) return null;
  return CANONICAL_BY_KEY.get(key) ?? ALIASES[key] ?? null;
}

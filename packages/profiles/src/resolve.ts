import { loadProfiles, type V1Profile } from "./schema.js";

export type ProfileStatus = "match" | "partial" | "contradiction" | "unknown";

export interface ProfileResolution {
  status: ProfileStatus;
  // True only for contradiction: Task 11 must ask instead of searching.
  requiresQuestion: boolean;
  declaration: string;
  // Always the declared profile (or null when unknown): project signals
  // never silently replace the declaration.
  profile: V1Profile | null;
  matchedSignals: string[];
  conflictingSignals: string[];
}

export interface ResolveProfileInput {
  declaration: string;
  projectSignals: string[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

// Corroboration resolver: project signals corroborate or contradict the
// declared use case but never override it. Contradictions set
// requiresQuestion and no search may proceed until resolved.
export function resolveProfile(
  input: ResolveProfileInput,
  profiles: V1Profile[] = loadProfiles(),
): ProfileResolution {
  const declaration = normalize(input.declaration);
  const declared = profiles.find((p) => p.id === declaration) ?? null;
  const base = {
    declaration: input.declaration,
    profile: declared,
    matchedSignals: [] as string[],
    conflictingSignals: [] as string[],
  };
  if (!declared) {
    return { ...base, status: "unknown", requiresQuestion: false };
  }
  const signals = [...new Set(input.projectSignals.map(normalize).filter((s) => s))];
  const positive = new Set(declared.signalQueries.map(normalize));
  const negative = new Set(declared.negativeSignals.map(normalize));
  const matchedSignals = signals.filter((s) => positive.has(s));
  const conflictingSignals = signals.filter((s) => negative.has(s));
  if (conflictingSignals.length > 0) {
    return { ...base, status: "contradiction", requiresQuestion: true, matchedSignals, conflictingSignals };
  }
  let otherBest = 0;
  for (const other of profiles) {
    if (other.id === declared.id) continue;
    const otherPositive = new Set(other.signalQueries.map(normalize));
    const hits = signals.filter((s) => otherPositive.has(s)).length;
    if (hits > otherBest) otherBest = hits;
  }
  // Signals corroborate a different use case while nothing corroborates
  // the declaration: treat as contradiction, never override.
  if (matchedSignals.length === 0 && otherBest > 0) {
    return { ...base, status: "contradiction", requiresQuestion: true, matchedSignals, conflictingSignals };
  }
  if (matchedSignals.length === 0 || otherBest > matchedSignals.length) {
    return { ...base, status: "partial", requiresQuestion: false, matchedSignals, conflictingSignals };
  }
  return { ...base, status: "match", requiresQuestion: false, matchedSignals, conflictingSignals };
}

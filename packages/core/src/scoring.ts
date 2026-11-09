import type { Candidate, CapabilityRecord, Confidence } from "./schema.js";
import type { HarnessId } from "./artifacts.js";
import type { Recommendation, Verdict } from "./schema.js";

// Score floor for a `required` verdict. Profiles (Task 10) may override it
// per use case; the threshold always applies to `score` (0-100).
export const DEFAULT_REQUIRED_THRESHOLD = 55;

export interface ScoreInput {
  candidate: Candidate;
  installedCapabilities: CapabilityRecord[];
  profileDomains: string[];
  harness: HarnessId;
  useCaseMatch: number;
  projectSignalMatch: number;
  // Adapter-provided 0-1 compatibility. Omitted means 1 (no harness-specific
  // constraint, e.g. an unknown harness or a fixture corpus).
  compatibility?: number;
}

export interface ScoreBreakdown {
  relevance: number;
  value: number;
  immediacy: number;
  compatibility: number;
  overlap: number;
  setupCost: number;
  risk: number;
  score: number;
  confidence: Confidence;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function credibilityOf(candidate: Candidate): number {
  const provenance =
    candidate.provenance === "official"
      ? 1
      : candidate.provenance === "publisher"
        ? 0.8
        : candidate.provenance === "community"
          ? 0.5
          : 0.2;
  const maintenance =
    candidate.maintenance === "active"
      ? 1
      : candidate.maintenance === "unknown"
        ? 0.5
        : candidate.maintenance === "stale"
          ? 0.25
          : 0;
  const audit =
    candidate.auditStatus === "clean"
      ? 1
      : candidate.auditStatus === "unknown"
        ? 0.5
        : candidate.auditStatus === "warning"
          ? 0.25
          : 0;
  // Popularity is a quality floor/tiebreaker, never the ranking function.
  const popularity =
    (candidate.popularity.stars ?? 0) > 0 ||
    (candidate.popularity.installs ?? 0) > 0 ||
    (candidate.popularity.velocity30d ?? 0) > 0
      ? 1
      : 0.4;
  return (provenance + maintenance + audit + popularity) / 4;
}

// Fraction of the candidate's capabilities covered by the profile domains.
function domainOverlap(candidate: Candidate, profileDomains: string[]): number {
  if (candidate.capabilities.length === 0) return 0;
  const domains = new Set(profileDomains);
  const covered = candidate.capabilities.filter((cap) => domains.has(cap));
  return covered.length / candidate.capabilities.length;
}

function sharesCapability(
  candidate: Candidate,
  record: CapabilityRecord,
): boolean {
  return record.capabilities.some((cap) =>
    candidate.capabilities.includes(cap),
  );
}

function setupCostOf(candidate: Candidate): number {
  return clamp01(
    (candidate.installMode === "manual" ? 0.2 : 0) +
      (candidate.provenance === "unknown" ? 0.1 : 0),
  );
}

function riskPenaltyOf(candidate: Candidate): number {
  const tier =
    candidate.risk === "low"
      ? 0
      : candidate.risk === "medium"
        ? 0.15
        : candidate.risk === "high"
          ? 0.35
          : 0.6;
  const audit =
    candidate.auditStatus === "clean"
      ? 0
      : candidate.auditStatus === "unknown"
        ? 0.1
        : candidate.auditStatus === "warning"
          ? 0.15
          : 0.4;
  const maintenance =
    candidate.maintenance === "active"
      ? 0
      : candidate.maintenance === "unknown"
        ? 0.05
        : candidate.maintenance === "stale"
          ? 0.1
          : 0.4;
  return clamp01(tier + audit + maintenance);
}

function confidenceOf(candidate: Candidate): Confidence {
  const signals =
    (candidate.provenance === "official" ||
    candidate.provenance === "publisher"
      ? 1
      : 0) +
    (candidate.auditStatus === "clean" ? 1 : 0) +
    (candidate.maintenance === "active" ? 1 : 0) +
    (candidate.sources.length > 0 &&
    (candidate.repositoryUrl !== undefined || candidate.packageName !== undefined)
      ? 1
      : 0) +
    ((candidate.popularity.stars ?? 0) > 0 ||
    (candidate.popularity.installs ?? 0) > 0 ||
    (candidate.popularity.velocity30d ?? 0) > 0
      ? 1
      : 0);
  return signals >= 4 ? "high" : signals >= 2 ? "medium" : "low";
}

export function scoreBreakdown(input: ScoreInput): ScoreBreakdown {
  const relevance = clamp01(
    0.6 * clamp01(input.useCaseMatch) + 0.4 * clamp01(input.projectSignalMatch),
  );
  const value = credibilityOf(input.candidate);
  const immediacy = domainOverlap(input.candidate, input.profileDomains);
  const compatibility = clamp01(input.compatibility ?? 1);
  let overlap = 1;
  for (const record of input.installedCapabilities) {
    if (sharesCapability(input.candidate, record)) {
      overlap *= record.enabled ? 0.5 : 0.8;
    }
  }
  const setupCost = setupCostOf(input.candidate);
  const risk = riskPenaltyOf(input.candidate);
  const fit =
    relevance * (0.55 + 0.25 * value + 0.2 * immediacy) * compatibility * overlap;
  const score = round(clamp01(fit - setupCost - risk) * 100, 1);
  return {
    relevance: round(relevance, 4),
    value: round(value, 4),
    immediacy: round(immediacy, 4),
    compatibility,
    overlap: round(overlap, 4),
    setupCost: round(setupCost, 4),
    risk: round(risk, 4),
    score,
    confidence: confidenceOf(input.candidate),
  };
}

// First failing hard gate, if any. Checked before the redundant gate so a
// duplicated-but-dangerous capability reports `risky`, never `redundant`.
function hardGateReason(
  candidate: Candidate,
  compatibility: number,
): string | null {
  if (candidate.license.trim().length === 0) return "missing license";
  if (candidate.artifactProbed === false)
    return "artifact was declared by a source listing but never probed";
  if (candidate.auditStatus === "critical")
    return "critical audit finding for the pinned artifact";
  if (candidate.maintenance === "archived") return "archived maintenance";
  if (
    candidate.provenance === "unknown" &&
    (candidate.risk === "high" || candidate.risk === "critical")
  )
    return "unknown provenance with high/critical risk";
  if (compatibility <= 0) return "incompatible harness";
  return null;
}

function redundantReason(input: ScoreInput): string | null {
  if (input.candidate.capabilities.length === 0) return null;
  const fullyCovered = input.candidate.capabilities.every((cap) =>
    input.installedCapabilities.some(
      (record) => record.enabled && record.capabilities.includes(cap),
    ),
  );
  return fullyCovered ? "capability already installed and enabled" : null;
}

export interface ScoreSetContext {
  installedCapabilities: CapabilityRecord[];
  profileDomains: string[];
  harness: HarnessId;
  projectSignalMatch: number;
  useCaseMatchFor: (candidate: Candidate) => number;
  compatibilityFor?: (candidate: Candidate) => number;
}

// Shared by `recommend` and the benchmark so both exercise identical
// candidate-building rules (use-case match, compatibility, project signals).
export function scoreCandidateSet(
  candidates: Candidate[],
  context: ScoreSetContext,
): Recommendation[] {
  return candidates.map((candidate) =>
    scoreCandidate({
      candidate,
      installedCapabilities: context.installedCapabilities,
      profileDomains: context.profileDomains,
      harness: context.harness,
      useCaseMatch: context.useCaseMatchFor(candidate),
      projectSignalMatch: context.projectSignalMatch,
      compatibility: context.compatibilityFor?.(candidate) ?? 1,
    }),
  );
}

export function scoreCandidate(input: ScoreInput): Recommendation {
  const breakdown = scoreBreakdown(input);
  const gate = hardGateReason(input.candidate, breakdown.compatibility);
  const redundant = gate === null ? redundantReason(input) : null;
  let verdict: Verdict;
  let why: string;
  if (gate !== null) {
    verdict = "risky";
    why = gate;
  } else if (redundant !== null) {
    verdict = "redundant";
    why = redundant;
  } else if (breakdown.score >= DEFAULT_REQUIRED_THRESHOLD) {
    verdict = "required";
    why = "fills a profile-domain gap with acceptable risk";
  } else {
    verdict = "useful-optional";
    why = "below the required score threshold";
  }
  return {
    candidate: input.candidate,
    harness: input.harness,
    verdict,
    confidence: breakdown.confidence,
    score: breakdown.score,
    overlap: breakdown.overlap,
    reasoning:
      `relevance ${breakdown.relevance} · value ${breakdown.value} · ` +
      `immediacy ${breakdown.immediacy} · compatibility ${breakdown.compatibility} · ` +
      `overlap ${breakdown.overlap} · setupCost ${breakdown.setupCost} · ` +
      `risk ${breakdown.risk} → score ${breakdown.score}; ` +
      `verdict ${verdict}: ${why}`,
    evidencePointers: [...input.candidate.sources],
  };
}

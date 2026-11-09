import { DEFAULT_REQUIRED_THRESHOLD } from "./scoring.js";
import type { Recommendation, Verdict } from "./schema.js";

export interface VerdictInput {
  recommendations: Recommendation[];
  requiredThreshold?: number;
}

// Set-level outcome for the top pick. Returns `no-good-candidates` when no
// candidate clears hard gates, the top score misses the profile threshold,
// or top confidence is below medium — never fabricates a required pick.
export function decideVerdict(input: VerdictInput): Verdict {
  const threshold = input.requiredThreshold ?? DEFAULT_REQUIRED_THRESHOLD;
  const eligible = input.recommendations.filter(
    (rec) => rec.verdict !== "risky",
  );
  if (eligible.length === 0) return "no-good-candidates";
  let top = eligible[0] as Recommendation;
  for (const rec of eligible) {
    if (
      rec.score > top.score ||
      (rec.score === top.score && rec.candidate.id < top.candidate.id)
    ) {
      top = rec;
    }
  }
  if (top.score < threshold) return "no-good-candidates";
  if (top.confidence === "low") return "no-good-candidates";
  return top.verdict;
}

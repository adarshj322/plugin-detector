import {
  DEFAULT_REQUIRED_THRESHOLD,
  decideVerdict,
  scoreCandidateSet,
  type CapabilityRecord,
  type HarnessId,
} from "@plugin-detector/core";
import { loadSnapshot } from "@plugin-detector/registry";
import { loadProfiles, resolveProfile } from "@plugin-detector/profiles";
import {
  CliErrorSchema,
  RecommendJsonSchema,
  printJson,
  printSection,
  type RecommendJson,
} from "../output.js";
import { buildAdapters } from "./inventory.js";

export interface RecommendResult {
  exitCode: number;
}

const VALID_HARNESSES = ["auto", "opencode", "claude-code", "codex", "cursor", "unknown"];

function usageError(
  command: string,
  message: string,
  validIds: string[],
  json: boolean,
): RecommendResult {
  console.error(message);
  if (json) {
    printJson(
      { command, error: { code: "usage", message, validIds } },
      CliErrorSchema,
    );
  }
  return { exitCode: 2 };
}

export async function recommend(argv: string[]): Promise<RecommendResult> {
  let useCase: string | undefined;
  const signals: string[] = [];
  let json = false;
  let cacheDir: string | undefined;
  let home: string | undefined;
  let root: string | undefined;
  let harness = "auto";
  let threshold = DEFAULT_REQUIRED_THRESHOLD;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--use-case" && i + 1 < argv.length) {
      useCase = argv[i + 1];
      i += 1;
    } else if (arg === "--signal" && i + 1 < argv.length) {
      signals.push(argv[i + 1] as string);
      i += 1;
    } else if (arg === "--cache-dir" && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else if (arg === "--harness" && i + 1 < argv.length) {
      harness = argv[i + 1] as string;
      i += 1;
    } else if (arg === "--threshold" && i + 1 < argv.length) {
      threshold = Number(argv[i + 1]);
      i += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }

  const profiles = loadProfiles();
  const validIds = profiles.map((p) => p.id);
  if (!useCase) {
    return usageError(
      "recommend",
      `missing required --use-case <id>. Valid ids: ${validIds.join(", ")}`,
      validIds,
      json,
    );
  }
  if (!profiles.some((p) => p.id === useCase)) {
    return usageError(
      "recommend",
      `unknown --use-case "${useCase}". Valid ids: ${validIds.join(", ")}`,
      validIds,
      json,
    );
  }
  if (!VALID_HARNESSES.includes(harness)) {
    console.error(
      `unknown --harness "${harness}". Valid: ${VALID_HARNESSES.join(", ")}`,
    );
    return { exitCode: 2 };
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    console.error(`--threshold must be a number between 0 and 100`);
    return { exitCode: 2 };
  }

  // Corroboration gate: contradiction exits needs-clarification with no
  // search and no candidate output; signals never override the declaration.
  const resolution = resolveProfile({ declaration: useCase, projectSignals: signals });
  if (resolution.status === "contradiction") {
    const payload: RecommendJson = {
      command: "recommend",
      facts: {
        useCase,
        profileStatus: "contradiction",
        verdict: "needs-clarification",
        recommendations: [],
        conflictingSignals: resolution.conflictingSignals,
      },
      estimates: {
        reasoningByCandidate: [],
      },
      untrustedCopy: { withheld: [] },
    };
    if (json) {
      printJson(payload, RecommendJsonSchema);
    } else {
      printSection("facts", [
        `use-case: ${useCase}`,
        `profile-status: contradiction`,
        `verdict: needs-clarification`,
        `conflicting-signals: ${resolution.conflictingSignals.join(", ") || "(none)"}`,
        `matched-signals: ${resolution.matchedSignals.join(", ") || "(none)"}`,
        `question: which workflow should this recommendation serve? Resolve the mismatch, then re-run.`,
      ]);
      printSection("estimates", []);
      printSection("untrustedCopy", []);
    }
    return { exitCode: 3 };
  }
  const profile = resolution.profile;
  if (!profile || resolution.status === "unknown") {
    // Unreachable: unknown declarations exit 2 above; kept for exhaustiveness.
    return usageError("recommend", `unknown --use-case "${useCase}"`, validIds, json);
  }

  let snapshot;
  try {
    snapshot = loadSnapshot({ ...(cacheDir ? { cacheDir } : {}) });
  } catch (error) {
    console.error(
      `no registry snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }

  const adapters = buildAdapters(home, root);
  const detected: string[] = [];
  const installedRecords: CapabilityRecord[] = [];
  for (const adapter of adapters) {
    if ((await adapter.detect()).detected) detected.push(adapter.harness);
    const inv = await adapter.inventory();
    installedRecords.push(...inv.records);
  }
  const selected =
    harness === "auto" ? (detected[0] ?? "unknown") : harness;
  const compatAdapter = adapters.find((a) => a.harness === selected);

  const matched = new Set(resolution.matchedSignals.map((s) => s.toLowerCase()));
  const projectSignalMatch =
    profile.signalQueries.length === 0
      ? 0
      : profile.signalQueries.filter((q) => matched.has(q.toLowerCase())).length /
        profile.signalQueries.length;
  const profileCaps = new Set<string>(profile.capabilities);

  const compatibilityFor = (candidate: (typeof snapshot.candidates)[number]) =>
    compatAdapter ? compatAdapter.compatibility(candidate) : 1;
  // Source listings that never probed a manifest are not recommendations:
  // they stay visible through `explain` and the refresh manifest instead.
  const probed = snapshot.candidates.filter(
    (candidate) => candidate.artifactProbed !== false,
  );
  const scored = scoreCandidateSet(probed, {
    installedCapabilities: installedRecords,
    profileDomains: [...profile.capabilities],
    harness: (selected === "unknown" ? "unknown" : selected) as HarnessId,
    projectSignalMatch,
    useCaseMatchFor: (candidate) =>
      candidate.capabilities.length === 0
        ? 0
        : candidate.capabilities.filter((c) => profileCaps.has(c)).length /
          candidate.capabilities.length,
    compatibilityFor,
  }).map((rec) => ({
    rec,
    compatibility: compatAdapter ? compatibilityFor(rec.candidate) : null,
  }));
  scored.sort((a, b) =>
    b.rec.score === a.rec.score
      ? a.rec.candidate.id < b.rec.candidate.id
        ? -1
        : 1
      : b.rec.score - a.rec.score,
  );
  const top = scored.filter((s) => s.rec.verdict !== "risky").slice(0, 5);
  const verdict = decideVerdict({
    recommendations: scored.map((s) => s.rec),
    requiredThreshold: threshold,
  });

  const payload: RecommendJson = {
    command: "recommend",
    facts: {
      useCase,
      profileStatus: resolution.status,
      verdict,
      ...(verdict === "no-good-candidates"
        ? { message: "No good candidates found." }
        : {}),
      recommendations: top.map((s) => ({
        candidateId: s.rec.candidate.id,
        name: s.rec.candidate.name,
        artifactType: s.rec.candidate.artifactType,
        harness: s.rec.harness,
        verdict: s.rec.verdict,
        confidence: s.rec.confidence,
        score: s.rec.score,
        overlap: s.rec.overlap,
        compatibility: s.compatibility,
        license: s.rec.candidate.license,
        pinnedRef: s.rec.candidate.pinnedRef,
        evidencePointers: s.rec.evidencePointers,
      })),
      conflictingSignals: resolution.conflictingSignals,
    },
    estimates: {
      reasoningByCandidate: top.map((s) => ({
        candidateId: s.rec.candidate.id,
        reasoning: s.rec.reasoning,
      })),
    },
    untrustedCopy: { withheld: [] },
  };
  if (json) {
    printJson(payload, RecommendJsonSchema);
  } else {
    printSection("facts", [
      `use-case: ${useCase} (profile-status: ${resolution.status})`,
      `verdict: ${verdict}`,
      ...payload.facts.recommendations.map(
        (r) =>
          `${r.candidateId} [${r.verdict}] score=${r.score} overlap=${r.overlap} ` +
          `confidence=${r.confidence} license=${r.license} pinned=${r.pinnedRef} ` +
          `evidence=${r.evidencePointers.join(",") || "(none)"}`,
      ),
      ...(verdict === "no-good-candidates" ? ["No good candidates found."] : []),
    ]);
    printSection(
      "estimates",
      payload.estimates.reasoningByCandidate.map(
        (r) => `${r.candidateId}: ${r.reasoning}`,
      ),
    );
    printSection("untrustedCopy", []);
  }
  return { exitCode: 0 };
}

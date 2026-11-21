import {
  DEFAULT_REQUIRED_THRESHOLD,
  decideVerdict,
  scoreCandidateSet,
  type CapabilityRecord,
  type HarnessId,
} from "@plugin-detector/core";
import { detectExternalTools } from "@plugin-detector/adapter-shared";
import {
  applyLatestVersions,
  createLatestVersionResolver,
  loadSnapshot,
  type LatestVersionResolver,
} from "@plugin-detector/registry";
import {
  loadProfileFile,
  loadProfiles,
  resolveProfile,
  type V1Profile,
} from "@plugin-detector/profiles";
import {
  CliErrorSchema,
  RecommendJsonSchema,
  printJson,
  printSection,
  type RecommendJson,
} from "../output.js";
import { buildLifecycleRows } from "../lifecycle.js";
import { buildAdapters } from "./inventory.js";

export interface RecommendResult {
  exitCode: number;
}

export interface RecommendDeps {
  // Test seam; production resolves only when --check-updates is present.
  resolveLatest?: LatestVersionResolver | undefined;
  // Test seam; production probes the curated external-CLI list.
  externalTools?: (() => CapabilityRecord[]) | undefined;
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

export async function recommend(
  argv: string[],
  deps: RecommendDeps = {},
): Promise<RecommendResult> {
  let useCase: string | undefined;
  let profilePath: string | undefined;
  const signals: string[] = [];
  let json = false;
  let checkUpdates = false;
  let cacheDir: string | undefined;
  let home: string | undefined;
  let root: string | undefined;
  let harness = "auto";
  let threshold: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--check-updates") checkUpdates = true;
    else if (arg === "--use-case" && i + 1 < argv.length) {
      useCase = argv[i + 1];
      i += 1;
    } else if (arg === "--profile" && i + 1 < argv.length) {
      profilePath = argv[i + 1];
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

  let customProfile: V1Profile | undefined;
  if (profilePath !== undefined) {
    try {
      customProfile = loadProfileFile(profilePath);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return { exitCode: 1 };
    }
  }
  if (
    customProfile !== undefined &&
    useCase !== undefined &&
    useCase.trim().toLowerCase() !== customProfile.id.trim().toLowerCase()
  ) {
    return usageError(
      "recommend",
      `--use-case "${useCase}" conflicts with --profile "${customProfile.id}" (${profilePath}); pass matching values or omit --use-case`,
      [customProfile.id],
      json,
    );
  }
  const builtins = loadProfiles();
  // A custom profile wins on the same id so its threshold and signals apply.
  const profiles =
    customProfile === undefined
      ? builtins
      : [
          ...builtins.filter(
            (p) =>
              p.id.trim().toLowerCase() !==
              customProfile.id.trim().toLowerCase(),
          ),
          customProfile,
        ];
  const validIds = profiles.map((p) => p.id);
  const declaration = customProfile?.id ?? useCase;
  if (!declaration) {
    return usageError(
      "recommend",
      `missing required --use-case <id> or --profile <file>. Valid ids: ${validIds.join(", ")}`,
      validIds,
      json,
    );
  }
  if (
    customProfile === undefined &&
    !profiles.some((p) => p.id === declaration)
  ) {
    return usageError(
      "recommend",
      `unknown --use-case "${declaration}". Valid ids: ${validIds.join(", ")}`,
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
  if (
    threshold !== undefined &&
    (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)
  ) {
    console.error(`--threshold must be a number between 0 and 100`);
    return { exitCode: 2 };
  }

  // Corroboration gate: contradiction exits needs-clarification with no
  // search and no candidate output; signals never override the declaration.
  const resolution = resolveProfile(
    { declaration, projectSignals: signals },
    profiles,
  );
  if (resolution.status === "contradiction") {
    const payload: RecommendJson = {
      command: "recommend",
      facts: {
        useCase: declaration,
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
        `use-case: ${declaration}`,
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
    return usageError("recommend", `unknown --use-case "${declaration}"`, validIds, json);
  }
  const effectiveThreshold =
    threshold ?? profile.requiredThreshold ?? DEFAULT_REQUIRED_THRESHOLD;

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
  const adapterRecords: CapabilityRecord[] = [];
  for (const adapter of adapters) {
    if ((await adapter.detect()).detected) detected.push(adapter.harness);
    const inv = await adapter.inventory();
    adapterRecords.push(...inv.records);
  }
  // Curated host CLIs are installed inventory too: they cover capabilities
  // (git -> vcs.workflow) and belong in lifecycle rows even though no harness
  // owns them. They are never replacement targets: candidate artifact kinds do
  // not include `cli`, so comparison keeps them.
  const externalRecords = (deps.externalTools ?? detectExternalTools)();
  let installedRecords: CapabilityRecord[] = [
    ...adapterRecords,
    ...externalRecords,
  ];
  if (checkUpdates) {
    // Upstream evidence only; lifecycle comparison decides current/outdated.
    // PATH-sourced CLIs have no registry mapping and stay unknown/manual.
    const resolveLatest =
      deps.resolveLatest ?? createLatestVersionResolver();
    installedRecords = [
      ...(await applyLatestVersions(adapterRecords, resolveLatest)),
      ...externalRecords,
    ];
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
  // Source listings that never fetched a real artifact are not
  // recommendations: they stay visible through `explain` and the refresh
  // manifest instead. Legacy snapshots that predate artifactEvidence are
  // treated as unprobed.
  const probed = snapshot.candidates.filter(
    (candidate) =>
      candidate.artifactEvidence !== undefined &&
      candidate.artifactProbed !== false,
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
    requiredThreshold: effectiveThreshold,
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
    requiredThreshold: effectiveThreshold,
  });
  const lifecycle = buildLifecycleRows(
    installedRecords,
    scored.map((s) => ({
      candidate: s.rec.candidate,
      score: s.rec.score,
    })),
    {
      installedInventory: installedRecords,
      profileDomainsFor: () => profile.capabilities,
      threshold: effectiveThreshold,
      compatibilityFor: (record, candidate) =>
        adapters.find((a) => a.harness === record.harness)?.compatibility(candidate),
    },
  );

  const payload: RecommendJson = {
    command: "recommend",
    facts: {
      useCase: declaration,
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
      lifecycle,
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
      `use-case: ${declaration} (profile-status: ${resolution.status})`,
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
    const visibleLifecycle = lifecycle.filter(
      (row) =>
        row.action !== "keep" ||
        row.candidateId !== undefined ||
        row.latestVersion !== undefined,
    );
    const hiddenLifecycleCount = lifecycle.length - visibleLifecycle.length;
    printSection(
      "installed lifecycle",
      lifecycle.length === 0
        ? ["(none)"]
        : [
            ...visibleLifecycle.flatMap((row) => [
              `${row.installedId} [${row.action}] ` +
                `installed=${row.installedVersion ?? "unknown"} ` +
                `latest=${row.latestVersion ?? "unknown"}` +
                (row.candidateId === undefined
                  ? ""
                  : ` candidate=${row.candidateId}`) +
                ` added=${row.capabilitiesAdded.join(",") || "(none)"} ` +
                `reason=${row.reasons.join("; ")}`,
              ...(row.recipe ?? []).map(
                (step) => `recipe(${row.installedId}): ${step}`,
              ),
            ]),
            ...(hiddenLifecycleCount === 0
              ? []
              : [
                  `${hiddenLifecycleCount} unchanged installed artifact row(s) omitted; --json keeps all rows`,
                ]),
          ],
    );
    printSection("untrustedCopy", []);
  }
  return { exitCode: 0 };
}

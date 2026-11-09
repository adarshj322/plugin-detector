import {
  scoreBreakdown,
  scoreCandidate,
  type CapabilityRecord,
} from "@plugin-detector/core";
import { loadSnapshot } from "@plugin-detector/registry";
import {
  ExplainJsonSchema,
  UNTRUSTED_WARNING,
  printJson,
  printSection,
} from "../output.js";
import { buildAdapters } from "./inventory.js";

export interface ExplainResult {
  exitCode: number;
}

export async function explain(argv: string[]): Promise<ExplainResult> {
  let candidateId: string | undefined;
  let showUntrusted = false;
  let json = false;
  let cacheDir: string | undefined;
  let home: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--show-untrusted") showUntrusted = true;
    else if (arg === "--json") json = true;
    else if (arg === "--cache-dir" && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("--") && candidateId === undefined) {
      candidateId = arg;
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  if (!candidateId) {
    console.error(`usage: plugin-detector explain <candidate-id> [--show-untrusted] [--json]`);
    return { exitCode: 2 };
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
  const candidate = snapshot.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    console.error(`unknown candidate: ${candidateId}`);
    return { exitCode: 1 };
  }
  const provenance = snapshot.provenance.find((p) => p.id === candidate.id);

  const adapters = buildAdapters(home, root);
  const detected: string[] = [];
  const compatibilityByHarness: Record<string, number> = {};
  const installed: CapabilityRecord[] = [];
  for (const adapter of adapters) {
    if ((await adapter.detect()).detected) detected.push(adapter.harness);
    const inv = await adapter.inventory();
    installed.push(...inv.records);
    compatibilityByHarness[adapter.harness] = adapter.compatibility(candidate);
  }
  const selected = detected[0] ?? "unknown";

  // Self-context scoring: explain has no profile, so the candidate is scored
  // against its own declared domains (useCaseMatch 1, no project signals).
  // This shows component behavior, never a recommendation verdict.
  const scoreInput = {
    candidate,
    installedCapabilities: installed,
    profileDomains: candidate.useCaseDomains,
    harness: (selected === "unknown" ? "unknown" : selected) as
      | "opencode"
      | "claude-code"
      | "codex"
      | "cursor"
      | "unknown",
    useCaseMatch: 1,
    projectSignalMatch: 0,
    compatibility: compatibilityByHarness[selected] ?? 1,
  };
  const breakdown = scoreBreakdown(scoreInput);
  const verdict = scoreCandidate(scoreInput).verdict;
  const overlapRecords = installed
    .filter((record) =>
      record.capabilities.some((cap) => candidate.capabilities.includes(cap)),
    )
    .map((record) => ({
      id: record.id,
      name: record.name,
      harness: record.harness,
      capabilities: record.capabilities,
    }));
  const riskFlags = [
    `risk:${candidate.risk}`,
    `audit:${candidate.auditStatus}`,
    `maintenance:${candidate.maintenance}`,
    `provenance:${candidate.provenance}`,
    `install-mode:${candidate.installMode}`,
  ];
  const generatedAt = snapshot.generatedAt;
  const snapshotAgeDays =
    Math.round(
      ((Date.now() - Date.parse(generatedAt)) / 86_400_000) * 10,
    ) / 10;
  const trust = provenance?.trust ?? "unverified";
  const hasUntrusted =
    candidate.rawUntrustedCopy !== undefined &&
    candidate.rawUntrustedCopy.length > 0;

  if (json) {
    printJson(
      {
        command: "explain",
        facts: {
          candidateId: candidate.id,
          name: candidate.name,
          artifactType: candidate.artifactType,
          pinnedRef: candidate.pinnedRef,
          sources: candidate.sources,
          trust,
          capabilities: candidate.capabilities,
          license: candidate.license,
          verdict,
          riskFlags,
          snapshotGeneratedAt: generatedAt,
          snapshotAgeDays: Math.max(0, snapshotAgeDays),
          compatibilityByHarness,
          score: { ...breakdown },
          overlapRecords,
        },
        estimates: {
          reasoning:
            `self-context score ${breakdown.score} (${breakdown.confidence} confidence): ` +
            `relevance ${breakdown.relevance} · value ${breakdown.value} · ` +
            `immediacy ${breakdown.immediacy} · compatibility ${breakdown.compatibility} · ` +
            `overlap ${breakdown.overlap} · setupCost ${breakdown.setupCost} · risk ${breakdown.risk}`,
        },
        untrustedCopy:
          hasUntrusted && showUntrusted
            ? { warning: UNTRUSTED_WARNING, text: candidate.rawUntrustedCopy ?? "" }
            : { withheld: true as const },
      },
      ExplainJsonSchema,
    );
    return { exitCode: 0 };
  }

  printSection("facts", [
    `candidate: ${candidate.id} (${candidate.name})`,
    `pinned-ref: ${candidate.pinnedRef}`,
    `source: ${provenance?.sourceUrl ?? candidate.sources[0] ?? "(none)"}`,
    `trust: ${trust}`,
    `verdict: ${verdict} (self-context; run recommend for a use-case verdict)`,
    `license: ${candidate.license}`,
    `capabilities: ${candidate.capabilities.join(", ") || "(none)"}`,
    `risk-flags: ${riskFlags.join(", ")}`,
    `snapshot-age: generated ${generatedAt} (${Math.max(0, snapshotAgeDays)}d ago)`,
    `compatibility: ${Object.entries(compatibilityByHarness)
      .map(([h, c]) => `${h}=${c}`)
      .join(" ")}`,
    `score: ${breakdown.score} (confidence: ${breakdown.confidence})`,
    `components: relevance=${breakdown.relevance} value=${breakdown.value} ` +
      `immediacy=${breakdown.immediacy} compatibility=${breakdown.compatibility} ` +
      `overlap=${breakdown.overlap} setupCost=${breakdown.setupCost} risk=${breakdown.risk}`,
    `overlap-records: ${overlapRecords.map((r) => r.id).join(", ") || "(none)"}`,
  ]);
  printSection("estimates", [
    `self-context scoring only; run recommend for a verdict against a use-case profile`,
  ]);
  if (hasUntrusted && showUntrusted) {
    printSection("untrustedCopy", [UNTRUSTED_WARNING, candidate.rawUntrustedCopy ?? ""]);
  } else if (hasUntrusted) {
    printSection("untrustedCopy", [
      "[withheld: candidate ships raw untrusted copy — re-run with --show-untrusted]",
    ]);
  } else {
    printSection("untrustedCopy", ["(none)"]);
  }
  return { exitCode: 0 };
}

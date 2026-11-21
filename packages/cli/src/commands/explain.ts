import {
  DEFAULT_REQUIRED_THRESHOLD,
  lifecycleFreshness,
  scoreBreakdown,
  scoreCandidate,
  type CapabilityRecord,
} from "@plugin-detector/core";
import { detectExternalTools } from "@plugin-detector/adapter-shared";
import {
  applyLatestVersions,
  createLatestVersionResolver,
  loadSnapshot,
  type LatestVersionResolver,
} from "@plugin-detector/registry";
import {
  ExplainJsonSchema,
  InstalledExplainJsonSchema,
  UNTRUSTED_WARNING,
  printJson,
  printSection,
} from "../output.js";
import { buildLifecycleRows } from "../lifecycle.js";
import { buildAdapters } from "./inventory.js";

export interface ExplainResult {
  exitCode: number;
}

export interface ExplainDeps {
  // Test seam; production resolves only when --check-updates is present.
  resolveLatest?: LatestVersionResolver | undefined;
  // Test seam; production probes the curated external-CLI list.
  externalTools?: (() => CapabilityRecord[]) | undefined;
}

// A candidate version is only displayed when it is a real comparable semver;
// a content-addressed `github:<hash>` pin is not a version.
const SEMVER_LIKE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function semverLike(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return SEMVER_LIKE.test(trimmed) ? trimmed : undefined;
}

export async function explain(
  argv: string[],
  deps: ExplainDeps = {},
): Promise<ExplainResult> {
  let candidateId: string | undefined;
  let showUntrusted = false;
  let checkUpdates = false;
  let json = false;
  let cacheDir: string | undefined;
  let home: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--show-untrusted") showUntrusted = true;
    else if (arg === "--check-updates") checkUpdates = true;
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
    console.error(
      `usage: plugin-detector explain <candidate-or-installed-id> [--show-untrusted] [--check-updates] [--json]`,
    );
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
  const generatedAt = snapshot.generatedAt;
  const snapshotAgeDays =
    Math.round(
      ((Date.now() - Date.parse(generatedAt)) / 86_400_000) * 10,
    ) / 10;

  const adapters = buildAdapters(home, root);
  const detected: string[] = [];
  const installed: CapabilityRecord[] = [];
  for (const adapter of adapters) {
    if ((await adapter.detect()).detected) detected.push(adapter.harness);
    const inv = await adapter.inventory();
    installed.push(...inv.records);
  }
  // Curated host CLIs are explainable installed records too, matching
  // recommend's lifecycle inventory.
  installed.push(...(deps.externalTools ?? detectExternalTools)());
  const selected = detected[0] ?? "unknown";

  const candidate = snapshot.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    const found = installed.find((r) => r.id === candidateId);
    if (!found) {
      console.error(`unknown candidate or installed artifact: ${candidateId}`);
      return { exitCode: 1 };
    }
    let record = found;
    if (checkUpdates) {
      const [updated] = await applyLatestVersions(
        [found],
        deps.resolveLatest ?? createLatestVersionResolver(),
      );
      if (updated !== undefined) record = updated;
    }
    const compatibilityFor = (
      installedRecord: CapabilityRecord,
      next: (typeof snapshot.candidates)[number],
    ) =>
      adapters.find((a) => a.harness === installedRecord.harness)
        ?.compatibility(next) ?? 1;
    // Match recommend: listing-only records without fetched artifact evidence
    // are never lifecycle candidates.
    const probedCandidates = snapshot.candidates.filter(
      (next) =>
        next.artifactEvidence !== undefined && next.artifactProbed !== false,
    );
    const rows = buildLifecycleRows(
      [record],
      probedCandidates.map((next) => ({
        candidate: next,
        score: scoreCandidate({
          candidate: next,
          installedCapabilities: [],
          profileDomains: next.capabilities,
          harness: record.harness,
          useCaseMatch: 1,
          projectSignalMatch: 0,
          compatibility: compatibilityFor(record, next),
        }).score,
      })),
      {
        installedInventory: installed,
        // Explain has no profile: a candidate's own capabilities are its
        // declared domains, matching the self-context candidate path.
        profileDomainsFor: (next) => next.capabilities,
        threshold: DEFAULT_REQUIRED_THRESHOLD,
        compatibilityFor,
      },
    );
    const row = rows[0];
    if (row === undefined) {
      // Unreachable: one installed record always yields one row.
      console.error(`no lifecycle evidence for installed artifact: ${record.id}`);
      return { exitCode: 1 };
    }
    // `latestVersion` is the installed artifact's upstream latest, never the
    // replacement candidate's version.
    const latestVersion = record.latestVersion;
    const replacement =
      row.candidateId === undefined
        ? undefined
        : snapshot.candidates.find((next) => next.id === row.candidateId);
    const candidateVersion =
      replacement === undefined
        ? undefined
        : semverLike(replacement.artifactEvidence?.version) ??
          semverLike(replacement.pinnedRef);
    const candidateName = replacement?.name;
    const updateStatus = lifecycleFreshness(record);
    if (json) {
      printJson(
        {
          command: "explain",
          facts: {
            kind: "installed",
            installedId: record.id,
            name: record.name,
            harness: record.harness,
            artifactKind: record.kind,
            capabilities: record.capabilities,
            ...(record.version === undefined
              ? {}
              : { installedVersion: record.version }),
            ...(latestVersion === undefined ? {} : { latestVersion }),
            updateStatus,
            action: row.action,
            ...(row.candidateId === undefined
              ? {}
              : { candidateId: row.candidateId }),
            ...(candidateName === undefined ? {} : { candidateName }),
            ...(candidateVersion === undefined ? {} : { candidateVersion }),
            capabilitiesAdded: row.capabilitiesAdded,
            reasons: row.reasons,
            ...(row.recipe === undefined ? {} : { recipe: row.recipe }),
            snapshotGeneratedAt: generatedAt,
            snapshotAgeDays: Math.max(0, snapshotAgeDays),
          },
          estimates: {
            reasoning:
              "installed lifecycle evidence only; run recommend for a use-case verdict",
          },
          untrustedCopy: { withheld: true as const },
        },
        InstalledExplainJsonSchema,
      );
      return { exitCode: 0 };
    }
    printSection("facts", [
      `installed: ${record.id} (${record.name})`,
      `harness: ${record.harness} kind: ${record.kind} enabled: ${record.enabled}`,
      `installed-version: ${record.version ?? "unknown"}`,
      `latest-version: ${latestVersion ?? "unknown"}`,
      `update-status: ${updateStatus}`,
      `action: ${row.action}`,
      `candidate: ${row.candidateId ?? "(none)"}`,
      ...(candidateName === undefined ? [] : [`candidate-name: ${candidateName}`]),
      ...(candidateVersion === undefined
        ? []
        : [`candidate-version: ${candidateVersion}`]),
      `capabilities: ${record.capabilities.join(", ") || "(none)"}`,
      `capabilities-added: ${row.capabilitiesAdded.join(", ") || "(none)"}`,
      `snapshot-age: generated ${generatedAt} (${Math.max(0, snapshotAgeDays)}d ago)`,
      ...row.reasons.map((reason) => `reason: ${reason}`),
      ...(row.recipe ?? []).map((step) => `recipe: ${step}`),
    ]);
    printSection("estimates", [
      "installed lifecycle evidence only; run recommend for a use-case verdict",
    ]);
    printSection("untrustedCopy", ["(none)"]);
    return { exitCode: 0 };
  }

  const provenance = snapshot.provenance.find((p) => p.id === candidate.id);
  const compatibilityByHarness: Record<string, number> = {};
  for (const adapter of adapters) {
    compatibilityByHarness[adapter.harness] = adapter.compatibility(candidate);
  }

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
  const trust = provenance?.trust ?? "unverified";
  const hasUntrusted =
    candidate.rawUntrustedCopy !== undefined &&
    candidate.rawUntrustedCopy.length > 0;

  if (json) {
    printJson(
      {
        command: "explain",
        facts: {
          kind: "candidate",
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

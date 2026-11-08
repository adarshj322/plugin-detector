import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CursorAdapter } from "@plugin-detector/cursor";
import {
  scoreCandidate,
  type Candidate,
  type HarnessId,
  type Verdict,
} from "@plugin-detector/core";
import { OpenCodeAdapter } from "@plugin-detector/opencode";
import {
  classifyTrust,
  detectDrift,
  normalizeCandidate,
  type NormalizedCandidate,
  type RawCandidate,
  type TrustClass,
} from "@plugin-detector/registry";

// Hostile-fixture runner for Task 14. Each fixtures/red-team/*.json file is
// either a plain RawCandidate or an envelope { raw, previous?, harness? }.
// A sibling *.md file (same basename) becomes the raw README, modelling how
// repo copy reaches the pipeline. A previous Candidate enables silent-drift
// comparison (same tag, changed manifest).
export type RedTeamOutcome = "rejected" | "contained" | "actionable";

export interface RedTeamResult {
  fixture: string;
  outcome: RedTeamOutcome;
  verdict?: Verdict | undefined;
  trust?: TrustClass | undefined;
  installKind?: "recipe" | "automatic" | "none" | undefined;
  drifted?: boolean | undefined;
  driftReasons?: string[] | undefined;
  notes: string[];
}

interface FixtureEnvelope {
  raw: RawCandidate;
  previous?: Candidate | undefined;
  harness?: string | undefined;
}

function parseFixture(path: string): {
  raw: RawCandidate;
  previous?: Candidate | undefined;
  harness: HarnessId;
} {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  let raw: RawCandidate;
  let previous: Candidate | undefined;
  let harness: HarnessId = "opencode";
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "raw" in parsed &&
    (parsed as { raw?: unknown }).raw !== null &&
    typeof (parsed as { raw?: unknown }).raw === "object"
  ) {
    const envelope = parsed as FixtureEnvelope;
    raw = envelope.raw;
    previous = envelope.previous;
    if (envelope.harness === "cursor") harness = "cursor";
  } else {
    raw = parsed as RawCandidate;
  }
  const mdPath = join(
    path.slice(0, path.length - basename(path).length),
    `${basename(path, ".json")}.md`,
  );
  if (existsSync(mdPath)) {
    raw = { ...raw, readme: readFileSync(mdPath, "utf8") };
  }
  return previous === undefined ? { raw, harness } : { raw, previous, harness };
}

function planKind(
  candidate: Candidate,
  trust: TrustClass,
  harness: HarnessId,
): "recipe" | "automatic" {
  const adapter =
    harness === "cursor" ? new CursorAdapter() : new OpenCodeAdapter();
  const plan = adapter.installPlan(candidate, trust);
  return plan.operations.every((op) => op.kind === "recipe")
    ? "recipe"
    : "automatic";
}

function runOne(fixture: string, path: string): RedTeamResult {
  const { raw, previous, harness } = parseFixture(path);
  const notes: string[] = [];
  let candidate: NormalizedCandidate;
  try {
    const normalized = normalizeCandidate(raw);
    notes.push(
      `normalized artifactType=${normalized.artifactType} untrustedCopyRisk=${normalized.untrustedCopyRisk}`,
    );
    candidate = normalized;
  } catch (error) {
    return {
      fixture,
      outcome: "rejected",
      installKind: "none",
      notes: [
        `rejected at intake: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const drift =
    previous === undefined
      ? { drifted: false, reasons: [] as string[] }
      : detectDrift(previous, candidate);
  const trust = classifyTrust(candidate, {
    maintainerVerified: candidate.provenance === "official",
    activity: candidate.maintenance,
    reviewEvidence: false,
    ...(drift.drifted ? { drifted: true as const } : {}),
    ...(candidate.untrustedCopyRisk ? { untrustedCopyRisk: true as const } : {}),
  });
  // Worst case for containment: perfect profile/domain match, so a hostile
  // candidate is contained only when gates actually hold.
  const rec = scoreCandidate({
    candidate,
    installedCapabilities: [],
    profileDomains: [...candidate.capabilities],
    harness,
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  const installKind = planKind(candidate, trust, harness);
  notes.push(
    `verdict=${rec.verdict} score=${rec.score} trust=${trust} install=${installKind}`,
  );
  if (drift.drifted) notes.push(`drift: ${drift.reasons.join("; ")}`);
  const actionable = rec.verdict === "required" && installKind === "automatic";
  return {
    fixture,
    outcome: actionable ? "actionable" : "contained",
    verdict: rec.verdict,
    trust,
    installKind,
    drifted: previous === undefined ? undefined : drift.drifted,
    driftReasons: previous === undefined ? undefined : drift.reasons,
    notes,
  };
}

export function runRedTeamFixtures({
  fixtureRoot,
}: {
  fixtureRoot: string;
}): RedTeamResult[] {
  return readdirSync(fixtureRoot)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => runOne(entry, join(fixtureRoot, entry)));
}

export function formatRedTeamReport(results: RedTeamResult[]): string {
  return results
    .map(
      (result) =>
        `${result.fixture}: ${result.outcome}` +
        (result.verdict === undefined ? "" : ` verdict=${result.verdict}`) +
        (result.trust === undefined ? "" : ` trust=${result.trust}`) +
        (result.installKind === undefined
          ? ""
          : ` install=${result.installKind}`) +
        (result.drifted === undefined ? "" : ` drifted=${result.drifted}`),
    )
    .join("\n");
}

import { scoreCandidate } from "./scoring.js";
import type { LifecycleRow } from "./lifecycle.js";
import type { Candidate, CapabilityRecord } from "./schema.js";

export interface LifecycleCompareInput {
  installed: CapabilityRecord;
  candidate: Candidate;
  installedInventory: readonly CapabilityRecord[];
  profileDomains: readonly string[];
  threshold: number;
  // Adapter-provided 0-1 compatibility for the candidate's harness. Omitted
  // means 1 (no harness-specific constraint).
  compatibility?: number;
}

type Version = readonly [major: number, minor: number, patch: number];

// Defensive: only strict semantic versions are comparable. Non-version tags,
// dates, and branch names yield no upgrade decision instead of a guessed one.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(raw: string | undefined): Version | null {
  if (raw === undefined) return null;
  const match = SEMVER.exec(raw.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(left: Version, right: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = left[i] as number;
    const b = right[i] as number;
    if (a !== b) return a > b;
  }
  return false;
}

// The probed artifact's own version is authoritative; a pinned ref is the
// fallback because snapshots do not always carry probe metadata.
function candidateVersion(candidate: Candidate): string | undefined {
  const version = candidate.artifactEvidence?.version;
  if (version !== undefined && parseVersion(version) !== null) {
    return version.trim();
  }
  if (parseVersion(candidate.pinnedRef) !== null) {
    return candidate.pinnedRef.trim();
  }
  return undefined;
}

function sameTool(
  installed: CapabilityRecord,
  candidate: Candidate,
): boolean {
  if (installed.id.trim().toLowerCase() === candidate.id.trim().toLowerCase()) {
    return true;
  }
  const refs = [installed.sourceRef, installed.installPath, ...installed.configRefs]
    .filter((ref): ref is string => ref !== undefined)
    .map(normalizeSource);
  if (refs.length === 0) return false;
  const packageName = (
    candidate.packageName ?? candidate.artifactEvidence?.packageName
  )
    ?.trim()
    .toLowerCase();
  if (
    packageName !== undefined &&
    refs.some((ref) => ref.includes(packageName))
  ) {
    return true;
  }
  if (candidate.repositoryUrl === undefined) return false;
  const repository = normalizeSource(candidate.repositoryUrl);
  return refs.some((ref) => ref === repository || ref.includes(repository));
}

function sameDisplayName(
  installed: CapabilityRecord,
  candidate: Candidate,
): boolean {
  return (
    installed.name.trim().toLowerCase() ===
    candidate.name.trim().toLowerCase()
  );
}

function normalizeSource(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "");
}

// Adapter `kind` vocabulary: adapters spell the MCP class "mcp" while the
// candidate ArtifactType spells it "mcp-server". Match on the shared spelling;
// future adapter aliases belong in this map rather than in each rule.
const KIND_ALIASES: Readonly<Record<string, string>> = {
  mcp: "mcp-server",
};

function normalizeKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  return KIND_ALIASES[normalized] ?? normalized;
}

// Installed freshness without rescoring the installed record. Explicit
// inventory status wins; otherwise only two comparable versions can decide.
function freshnessOf(
  installed: CapabilityRecord,
): "current" | "outdated" | "unknown" {
  if (installed.updateStatus === "current") return "current";
  if (installed.updateStatus === "outdated") return "outdated";
  const current = parseVersion(installed.version);
  const latest = parseVersion(installed.latestVersion);
  if (current === null || latest === null) return "unknown";
  return isNewer(latest, current) ? "outdated" : "current";
}

function capabilitiesAddedBy(
  installed: CapabilityRecord,
  candidate: Candidate,
  inventory: readonly CapabilityRecord[],
): string[] {
  const enabled = new Set<string>();
  for (const record of inventory) {
    if (record.enabled) for (const cap of record.capabilities) enabled.add(cap);
  }
  // The caller is expected to pass the installed record in the inventory, but
  // its own capabilities always cover it.
  if (installed.enabled) {
    for (const cap of installed.capabilities) enabled.add(cap);
  }
  return candidate.capabilities.filter((cap) => !enabled.has(cap));
}

// Replacing a tool must not silently drop a capability it provides. Another
// enabled install may still cover that capability, so the candidate only has
// to carry what nothing else provides.
function unpreservedCapabilities(
  installed: CapabilityRecord,
  candidate: Candidate,
  inventory: readonly CapabilityRecord[],
): string[] {
  const others = new Set<string>();
  for (const record of inventory) {
    if (!record.enabled || record.id === installed.id) continue;
    for (const cap of record.capabilities) others.add(cap);
  }
  return installed.capabilities.filter(
    (cap) => !candidate.capabilities.includes(cap) && !others.has(cap),
  );
}

// Candidate score with the lifecycle overlap handled separately: the policy
// compares capability coverage directly, so the general recommendation overlap
// penalty must not veto a legitimate superset replacement. Project signals are
// not part of this input, so lifecycle scoring stays conservative.
function scoreForReplacement(
  input: LifecycleCompareInput,
): { score: number; risky: boolean } {
  const { candidate, installed, profileDomains, threshold, compatibility } =
    input;
  const domains = new Set(profileDomains);
  const useCaseMatch =
    candidate.capabilities.length === 0
      ? 0
      : candidate.capabilities.filter((cap) => domains.has(cap)).length /
        candidate.capabilities.length;
  const recommendation = scoreCandidate({
    candidate,
    installedCapabilities: [],
    profileDomains: [...profileDomains],
    harness: installed.harness,
    useCaseMatch,
    projectSignalMatch: 0,
    compatibility: compatibility ?? 1,
    requiredThreshold: threshold,
  });
  return {
    score: recommendation.score,
    risky: recommendation.verdict === "risky",
  };
}

export function compareLifecycle(input: LifecycleCompareInput): LifecycleRow {
  const { installed, candidate, installedInventory, threshold } = input;
  const installedVersion =
    installed.version === undefined ? {} : { installedVersion: installed.version };
  const same = sameTool(installed, candidate);
  const candidateRaw = candidateVersion(candidate);
  const nextRaw = same ? candidateRaw ?? installed.latestVersion : candidateRaw;
  const currentVersion = parseVersion(installed.version);
  const nextVersion = parseVersion(nextRaw);

  if (installed.modified === true || installed.updateStatus === "modified") {
    return {
      installedId: installed.id,
      action: "review",
      reasons: [
        "installed artifact is locally modified; manual review required before any change",
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }

  if (normalizeKind(candidate.artifactType) !== normalizeKind(installed.kind)) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        `candidate kind ${candidate.artifactType} does not match installed kind ${installed.kind}`,
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }

  // A shared display name is not identity. Different tools can collide on
  // "reviewer" or "linter"; without id/package/repository evidence, no action.
  if (
    !same &&
    sameDisplayName(installed, candidate) &&
    installed.id.trim().toLowerCase() !== candidate.id.trim().toLowerCase()
  ) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        "candidate shares a display name but has a different identity; refusing to treat it as the same tool",
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }

  if (same) {
    if (
      currentVersion !== null &&
      nextVersion !== null &&
      isNewer(nextVersion, currentVersion)
    ) {
      return {
        installedId: installed.id,
        candidateId: candidate.id,
        action: "upgrade",
        reasons: [
          `same tool ${installed.id}: ${installed.version} -> ${nextRaw}`,
        ],
        ...installedVersion,
        latestVersion: nextRaw as string,
        capabilitiesAdded: [],
      };
    }
    const reason =
      currentVersion === null || nextVersion === null
        ? "same tool but version is unknown or not comparable; no upgrade"
        : "same tool is not older than the candidate; no upgrade";
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [reason],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }

  const added = capabilitiesAddedBy(installed, candidate, installedInventory);
  const freshness = freshnessOf(installed);

  if (added.length === 0) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        "candidate adds no capability that is not already covered by an enabled installed artifact",
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }
  const lost = unpreservedCapabilities(
    installed,
    candidate,
    installedInventory,
  );
  if (lost.length > 0) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        `replacement would drop installed capability ${lost.join(", ")} with no enabled artifact covering it`,
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }
  const { score, risky } = scoreForReplacement(input);
  if (risky) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: ["candidate fails the risk gate; not a safe replacement"],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }
  if (score < threshold) {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        `candidate score ${score} is below the profile threshold ${threshold}`,
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }
  // No forced migration when versions cannot be established: only proven
  // outdatedness justifies replacing an installed artifact.
  if (freshness !== "outdated") {
    return {
      installedId: installed.id,
      action: "keep",
      reasons: [
        freshness === "current"
          ? "installed artifact is current; a newer alternative is not worth the churn"
          : "installed version evidence is unknown; do not force a replacement",
      ],
      ...installedVersion,
      capabilitiesAdded: [],
    };
  }

  const replacementVersion = candidateRaw;
  return {
    installedId: installed.id,
    candidateId: candidate.id,
    action: "replace",
    reasons: [
      `installed status ${freshness} with weaker version evidence`,
      `candidate adds ${added.join(", ")}`,
      `candidate score ${score} meets the profile threshold ${threshold}`,
    ],
    ...installedVersion,
    ...(replacementVersion === undefined
      ? {}
      : { latestVersion: replacementVersion }),
    capabilitiesAdded: added,
  };
}

// One candidate can be the best replacement for several installed records that
// share a capability. Emit it once; later rows stay visible as keep so a plan
// never installs the same candidate twice. Callers control priority by row
// order and should put the strongest replacement first.
export function dedupeReplacementRows(
  rows: readonly LifecycleRow[],
): LifecycleRow[] {
  const claimed = new Set<string>();
  return rows.map((row) => {
    if (row.action !== "replace" || row.candidateId === undefined) return row;
    if (!claimed.has(row.candidateId)) {
      claimed.add(row.candidateId);
      return row;
    }
    const { candidateId, latestVersion, recipe: _recipe, ...rest } = row;
    return {
      ...rest,
      action: "keep",
      reasons: [
        ...row.reasons,
        `candidate ${candidateId} is already proposed as a replacement for another installed artifact`,
      ],
      capabilitiesAdded: [],
    };
  });
}

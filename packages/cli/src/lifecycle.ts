import {
  compareLifecycle,
  dedupeReplacementRows,
  type Candidate,
  type CapabilityRecord,
  type LifecycleAction,
  type LifecycleRow,
} from "@plugin-detector/core";

export interface LifecycleCandidate {
  candidate: Candidate;
  score: number;
  compatibility?: number;
}

export interface LifecycleOptions {
  installedInventory: readonly CapabilityRecord[];
  profileDomainsFor: (candidate: Candidate) => readonly string[];
  threshold: number;
}

const ACTION_RANK: Readonly<Record<LifecycleAction, number>> = {
  replace: 3,
  upgrade: 2,
  review: 1,
  keep: 0,
};

// Relevance only; compareLifecycle still owns identity and name-collision
// rules. Empty or whitespace identity needles never match.
function relatedTo(
  installed: CapabilityRecord,
  candidate: Candidate,
): boolean {
  const installedId = installed.id.trim().toLowerCase();
  const candidateId = candidate.id.trim().toLowerCase();
  const installedName = installed.name.trim().toLowerCase();
  const candidateName = candidate.name.trim().toLowerCase();
  if (installedId.length > 0 && installedId === candidateId) return true;
  if (installedName.length > 0 && installedName === candidateName) return true;
  return candidate.capabilities.some((cap) =>
    installed.capabilities.includes(cap),
  );
}

function keepRow(installed: CapabilityRecord, reason: string): LifecycleRow {
  return {
    installedId: installed.id,
    action: "keep",
    reasons: [reason],
    ...(installed.version === undefined ? {} : { installedVersion: installed.version }),
    capabilitiesAdded: [],
  };
}

function rowFor(
  installed: CapabilityRecord,
  candidates: readonly LifecycleCandidate[],
  options: LifecycleOptions,
): LifecycleRow {
  const compared = candidates.map(({ candidate, score, compatibility }) => ({
    candidate,
    score,
    row: compareLifecycle({
      installed,
      candidate,
      installedInventory: options.installedInventory,
      profileDomains: [...options.profileDomainsFor(candidate)],
      threshold: options.threshold,
      ...(compatibility === undefined ? {} : { compatibility }),
    }),
  }));
  if (installed.modified === true || installed.updateStatus === "modified") {
    const review = compared.find((entry) => entry.row.action === "review");
    if (review !== undefined) return review.row;
    return {
      installedId: installed.id,
      action: "review",
      reasons: [
        "installed artifact is locally modified; manual review required before any change",
      ],
      ...(installed.version === undefined ? {} : { installedVersion: installed.version }),
      capabilitiesAdded: [],
    };
  }
  const eligible = compared.filter(
    (entry) =>
      entry.row.action !== "keep" || relatedTo(installed, entry.candidate),
  );
  eligible.sort((a, b) => {
    const byAction = ACTION_RANK[b.row.action] - ACTION_RANK[a.row.action];
    if (byAction !== 0) return byAction;
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.id < b.candidate.id
      ? -1
      : a.candidate.id > b.candidate.id
        ? 1
        : 0;
  });
  const best = eligible[0];
  return best !== undefined
    ? best.row
    : keepRow(installed, "no registry candidate matches this installed artifact");
}

// One candidate must never yield two plans: replace is the stronger claim, so
// it claims the candidate first, upgrades claim their own, and every later row
// is demoted to a recipe-free keep.
function dedupeCandidatePlans(rows: readonly LifecycleRow[]): LifecycleRow[] {
  const claimed = new Set<string>();
  return rows.map((row) => {
    const candidateId = row.candidateId;
    if (candidateId === undefined) return row;
    if (!claimed.has(candidateId)) {
      claimed.add(candidateId);
      return row;
    }
    const {
      candidateId: _candidateId,
      latestVersion: _latestVersion,
      recipe: _recipe,
      ...rest
    } = row;
    return {
      ...rest,
      action: "keep",
      reasons: [
        ...row.reasons,
        `candidate ${candidateId} is already proposed as a change for another installed artifact`,
      ],
      capabilitiesAdded: [],
    };
  });
}

export function buildLifecycleRows(
  installed: readonly CapabilityRecord[],
  candidates: readonly LifecycleCandidate[],
  options: LifecycleOptions,
): LifecycleRow[] {
  const rows = installed.map((record) => rowFor(record, candidates, options));
  // Stable sort: stronger actions come first so dedupe keeps them, while
  // inventory order survives within the same action.
  rows.sort((a, b) => ACTION_RANK[b.action] - ACTION_RANK[a.action]);
  return dedupeCandidatePlans(dedupeReplacementRows(rows));
}

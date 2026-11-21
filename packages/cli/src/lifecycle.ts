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
}

export interface LifecycleOptions {
  installedInventory: readonly CapabilityRecord[];
  profileDomainsFor: (candidate: Candidate) => readonly string[];
  threshold: number;
  // Adapter compatibility for the installed record's own harness, matching
  // explain. Omitted means "no harness-specific constraint".
  compatibilityFor?: (
    installed: CapabilityRecord,
    candidate: Candidate,
  ) => number | undefined;
}

const ACTION_RANK: Readonly<Record<LifecycleAction, number>> = {
  replace: 3,
  upgrade: 2,
  review: 1,
  keep: 0,
};

const APPROVAL_NOTE =
  "Run only after explicit approval; back up config before editing.";

function isGitHubOrSkillsSh(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com" || host === "skills.sh";
  } catch {
    return false;
  }
}

function hasSkillsCliSource(candidate: Candidate): boolean {
  return [candidate.repositoryUrl, ...candidate.sources].some(
    (value) => value !== undefined && isGitHubOrSkillsSh(value),
  );
}

function isLocalSpec(spec: string): boolean {
  return (
    spec.startsWith("/") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("~")
  );
}

// The spec an OpenCode plugin install would use; a local path has no
// portable add command and stays manual.
function installSpec(candidate: Candidate): string | undefined {
  const spec = (candidate.packageName ?? candidate.repositoryUrl)?.trim();
  if (spec === undefined || spec === "" || isLocalSpec(spec)) return undefined;
  return spec;
}

// Claude marketplace specs are `plugin@marketplace`; a scoped npm name
// (`@scope/pkg`) is not one.
function marketplaceSpec(candidate: Candidate): string | undefined {
  const spec = (candidate.packageName ?? candidate.id).trim();
  return spec.indexOf("@", 1) > 0 ? spec : undefined;
}

function sourceRefOf(candidate: Candidate): string {
  return (
    candidate.packageName ??
    candidate.repositoryUrl ??
    candidate.sources[0] ??
    candidate.id
  );
}

function withApproval(lines: string[]): string[] {
  return [...lines, APPROVAL_NOTE];
}

function manualInstallLine(
  candidate: Candidate | undefined,
  harness: string,
): string {
  const name = candidate?.name ?? "the candidate";
  const source =
    candidate === undefined ? "its documented source" : sourceRefOf(candidate);
  return `Manual: install "${name}" from ${source} using the ${harness} documented installation procedure.`;
}

function manualPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  if (row.action === "upgrade") {
    return withApproval([
      `Manual: upgrade "${installed.name}" using the ${installed.harness} documented upgrade procedure; no automatic command is known.`,
    ]);
  }
  return withApproval([
    `Manual: remove "${installed.name}" using the ${installed.harness} documented uninstall procedure; no automatic removal command is known.`,
    manualInstallLine(candidate, installed.harness),
  ]);
}

function skillsPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  if (candidate === undefined || !hasSkillsCliSource(candidate)) {
    return manualPlan(row, installed, candidate);
  }
  const install = `npx skills add ${candidate.id}`;
  return row.action === "upgrade"
    ? withApproval([install])
    : withApproval([`npx skills remove ${installed.id}`, install]);
}

function opencodePluginPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const spec = candidate === undefined ? undefined : installSpec(candidate);
  if (candidate === undefined || spec === undefined) {
    return manualPlan(row, installed, candidate);
  }
  const install = `opencode plugin add ${spec}`;
  if (row.action === "upgrade") return withApproval([install]);
  if (installed.sourceRef === undefined) {
    return manualPlan(row, installed, candidate);
  }
  return withApproval([
    `opencode plugin remove ${installed.sourceRef}`,
    install,
  ]);
}

function claudePluginPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const spec = candidate === undefined ? undefined : marketplaceSpec(candidate);
  if (candidate === undefined || spec === undefined) {
    return manualPlan(row, installed, candidate);
  }
  const install = `claude plugin install ${spec}`;
  if (row.action === "upgrade") return withApproval([install]);
  if (installed.sourceRef === undefined) {
    return manualPlan(row, installed, candidate);
  }
  return withApproval([
    `claude plugin uninstall ${installed.sourceRef}`,
    install,
  ]);
}

function mcpPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  if (candidate === undefined) return [];
  const config =
    installed.configRefs[0] ?? `the ${installed.harness} MCP configuration`;
  const source = sourceRefOf(candidate);
  return row.action === "upgrade"
    ? withApproval([
        `Edit ${config}: update the "${installed.name}" server entry to ${source}.`,
      ])
    : withApproval([
        `Edit ${config}: remove the "${installed.name}" server entry.`,
        `Edit ${config}: add the "${candidate.id}" server entry from ${source}.`,
      ]);
}

// Print-only plan for an actionable lifecycle row: exact, documented commands
// where the harness supports them; a manual recipe everywhere else. Never
// writes, fetches, or consumes an approval token.
export function lifecyclePlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate?: Candidate,
): string[] {
  if (row.action !== "replace" && row.action !== "upgrade") return [];
  if (installed.kind === "mcp") return mcpPlan(row, installed, candidate);
  if (
    installed.kind === "skill" &&
    (installed.harness === "opencode" || installed.harness === "claude-code")
  ) {
    return skillsPlan(row, installed, candidate);
  }
  if (installed.harness === "opencode" && installed.kind === "plugin") {
    return opencodePluginPlan(row, installed, candidate);
  }
  if (installed.harness === "claude-code" && installed.kind === "plugin") {
    return claudePluginPlan(row, installed, candidate);
  }
  return manualPlan(row, installed, candidate);
}

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
  const compared = candidates.map(({ candidate, score }) => {
    const compatibility = options.compatibilityFor?.(installed, candidate);
    return {
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
    };
  });
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
// is demoted to a recipe-free keep. A replace survivor records why a weaker
// upgrade for the same candidate was folded into it.
function dedupeCandidatePlans(rows: readonly LifecycleRow[]): LifecycleRow[] {
  const claimed = new Map<string, number>();
  const output: LifecycleRow[] = [];
  for (const row of rows) {
    const candidateId = row.candidateId;
    if (candidateId === undefined) {
      output.push(row);
      continue;
    }
    const claimedIndex = claimed.get(candidateId);
    if (claimedIndex === undefined) {
      claimed.set(candidateId, output.length);
      output.push(row);
      continue;
    }
    const survivor = output[claimedIndex];
    if (survivor?.action === "replace" && row.action === "upgrade") {
      output[claimedIndex] = {
        ...survivor,
        reasons: [
          ...survivor.reasons,
          `candidate ${candidateId} also upgrades ${row.installedId}; replace plan takes precedence`,
        ],
      };
    }
    const {
      candidateId: _candidateId,
      latestVersion: _latestVersion,
      recipe: _recipe,
      ...rest
    } = row;
    output.push({
      ...rest,
      action: "keep",
      reasons: [
        ...row.reasons,
        `candidate ${candidateId} is already proposed as a change for another installed artifact`,
      ],
      capabilitiesAdded: [],
    });
  }
  return output;
}

export function buildLifecycleRows(
  installed: readonly CapabilityRecord[],
  candidates: readonly LifecycleCandidate[],
  options: LifecycleOptions,
): LifecycleRow[] {
  const rows = installed.map((record) => {
    const row = rowFor(record, candidates, options);
    // Upstream evidence resolved onto the installed record must stay visible
    // on keep/review rows, where compareLifecycle omits it. Upgrade/replace
    // latest versions describe the candidate and must not be relabeled.
    return (row.action === "keep" || row.action === "review") &&
      row.latestVersion === undefined &&
      record.latestVersion !== undefined
      ? { ...row, latestVersion: record.latestVersion }
      : row;
  });
  // Stable sort: stronger actions come first so dedupe keeps them, while
  // inventory order survives within the same action.
  rows.sort((a, b) => ACTION_RANK[b.action] - ACTION_RANK[a.action]);
  const records = new Map(installed.map((record) => [record.id, record]));
  const candidateById = new Map(
    candidates.map((entry) => [entry.candidate.id, entry.candidate]),
  );
  // Recipes attach after dedupe so demoted rows stay recipe-free.
  return dedupeCandidatePlans(dedupeReplacementRows(rows)).map((row) => {
    if (row.action !== "replace" && row.action !== "upgrade") return row;
    const record = records.get(row.installedId);
    if (record === undefined) return row;
    const next =
      row.candidateId === undefined
        ? undefined
        : candidateById.get(row.candidateId);
    const recipe = lifecyclePlan(row, record, next);
    return recipe.length === 0 ? row : { ...row, recipe };
  });
}

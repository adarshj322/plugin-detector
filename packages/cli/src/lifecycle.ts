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
// Recipes are print-only, but still never interpolate control characters or
// shell metacharacters into a command line.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const SAFE_ARG = /^[A-Za-z0-9@._:/+~-]+$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const KNOWN_SCOPES = new Set(["global", "user", "project", "local"]);
const CONFIG_BASENAMES = new Set([
  "opencode.json",
  "opencode.jsonc",
  ".claude.json",
  "settings.json",
]);

type InstalledScope = "global" | "user" | "project" | "local" | "unknown";

function plain(value: string): string {
  return value.replace(CONTROL_CHARS, " ").trim();
}

function quoted(value: string): string {
  return plain(value).replace(/"/g, '\\"');
}

function safeArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && !trimmed.startsWith("-") && SAFE_ARG.test(trimmed)
    ? trimmed
    : undefined;
}

function safeSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed !== "" && !trimmed.startsWith("-") && SAFE_SEGMENT.test(trimmed)
    ? trimmed
    : undefined;
}

function scopeOf(installed: CapabilityRecord): InstalledScope {
  const segment = installed.id.split(":")[2]?.trim().toLowerCase();
  if (segment !== undefined && KNOWN_SCOPES.has(segment)) {
    return segment as InstalledScope;
  }
  for (const ref of installed.configRefs) {
    const normalized = plain(ref).replace(/\\/g, "/").toLowerCase();
    if (
      installed.harness === "opencode" &&
      normalized.includes("/.config/opencode/")
    ) {
      return "global";
    }
    if (
      installed.harness === "claude-code" &&
      normalized.endsWith("/.claude.json")
    ) {
      return "user";
    }
  }
  return "unknown";
}

function configRefOf(installed: CapabilityRecord): string {
  const found = installed.configRefs.find((ref) => {
    const base = plain(ref).replace(/\\/g, "/").split("/").pop() ?? "";
    return CONFIG_BASENAMES.has(base);
  });
  return plain(
    found ??
      installed.configRefs[0] ??
      `the ${installed.harness} configuration`,
  );
}

function isLocalSpec(spec: string): boolean {
  return (
    spec.startsWith("/") ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("~") ||
    spec.startsWith("file:")
  );
}

// The spec an OpenCode plugin install would use; a local path has no
// portable add command and stays manual.
function installSpec(candidate: Candidate): string | undefined {
  const spec = (candidate.packageName ?? candidate.repositoryUrl)?.trim();
  if (spec === undefined || spec === "" || isLocalSpec(spec)) return undefined;
  return safeArg(spec);
}

// Claude marketplace specs are `plugin@marketplace`; a scoped npm name
// (`@scope/pkg`) is not one, and a version-like suffix (`@1.0.0`, `@v1`) is
// an npm pin, not a marketplace id.
function marketplaceSpec(candidate: Candidate): string | undefined {
  const spec = safeArg(candidate.packageName ?? candidate.id);
  if (spec === undefined) return undefined;
  const at = spec.indexOf("@", 1);
  if (at <= 0) return undefined;
  const marketplace = spec.slice(at + 1);
  return /^v?\d+(?:\.\d+)*$/i.test(marketplace) ? undefined : spec;
}

function sourceRefOf(candidate: Candidate): string {
  return (
    candidate.packageName ??
    candidate.repositoryUrl ??
    candidate.sources[0] ??
    candidate.id
  );
}

function safeInstalledSource(installed: CapabilityRecord): string | undefined {
  if (
    installed.sourceRef === undefined ||
    isLocalSpec(installed.sourceRef)
  ) {
    return undefined;
  }
  return safeArg(installed.sourceRef);
}

function withSafety(target: string, steps: string[]): string[] {
  return [
    `Back up ${target} before making changes.`,
    ...steps,
    `Rollback: restore ${target} from that backup.`,
    APPROVAL_NOTE,
  ];
}

function githubRepo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = safeSegment(segments[0]);
    const repo = safeSegment(segments[1]?.replace(/\.git$/, ""));
    return owner === undefined || repo === undefined
      ? undefined
      : `${owner}/${repo}`;
  } catch {
    return undefined;
  }
}

function candidateSkillName(candidate: Candidate): string | undefined {
  const declared =
    safeSegment(candidate.artifactEvidence?.name) ??
    safeSegment(candidate.name);
  if (declared !== undefined) return declared;
  return safeSegment(candidate.id.split("/").filter(Boolean).at(-1));
}

function candidateSkillsSpec(candidate: Candidate): string | undefined {
  const repo =
    githubRepo(candidate.repositoryUrl) ??
    candidate.sources
      .map((source) => githubRepo(source))
      .find((value) => value !== undefined);
  const skill = candidateSkillName(candidate);
  return repo === undefined || skill === undefined
    ? undefined
    : `${repo}@${skill}`;
}

function installedSkillName(installed: CapabilityRecord): string | undefined {
  const declared = safeSegment(installed.name);
  if (declared !== undefined) return declared;
  const fromPath = installed.installPath ?? installed.sourceRef;
  if (fromPath === undefined) return undefined;
  const base = fromPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return safeSegment(base);
}

function manualInstallLine(
  candidate: Candidate | undefined,
  harness: string,
): string {
  const name = quoted(candidate?.name ?? "the candidate");
  const source =
    candidate === undefined
      ? "its documented source"
      : `"${quoted(sourceRefOf(candidate))}"`;
  return `Manual: install "${name}" from ${source} using the ${plain(harness)} documented installation procedure.`;
}

function manualPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const name = quoted(installed.name);
  const harness = plain(installed.harness);
  const target = quoted(installed.installPath ?? configRefOf(installed));
  if (row.action === "upgrade") {
    return withSafety(target, [
      `Manual: upgrade "${name}" using the ${harness} documented upgrade procedure; no automatic command is known.`,
    ]);
  }
  return withSafety(target, [
    `Manual: remove "${name}" using the ${harness} documented uninstall procedure; no automatic removal command is known.`,
    manualInstallLine(candidate, harness),
  ]);
}

// A locally installed plugin has no portable CLI removal; say what to delete
// instead of passing a filesystem path to a package-manager command.
function localPluginPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const target = quoted(
    installed.sourceRef ?? installed.installPath ?? installed.name,
  );
  if (row.action === "upgrade") {
    return withSafety(target, [
      `Manual: update the local plugin at "${target}" using its documented procedure; no automatic command is known.`,
    ]);
  }
  return withSafety(target, [
    `Manual: delete the local plugin at "${target}" (or remove its config entry); no automatic removal command is known.`,
    manualInstallLine(candidate, installed.harness),
  ]);
}

function skillsScopeFlag(scope: InstalledScope): string | undefined {
  if (scope === "global" || scope === "user") return "-g";
  if (scope === "project" || scope === "local") return "";
  return undefined;
}

// The installed skill directory, used for the backup/rollback prose. A
// homepage sourceRef is not a directory, so configRefs ending in SKILL.md win
// over it.
function skillDirectoryOf(installed: CapabilityRecord): string {
  const install = installed.installPath ?? installed.sourceRef;
  if (install !== undefined && !/^https?:\/\//i.test(install)) return install;
  const skillFile = installed.configRefs.find((ref) =>
    /[\\/]SKILL\.md$/i.test(ref),
  );
  if (skillFile !== undefined) {
    return skillFile.replace(/[\\/]SKILL\.md$/i, "");
  }
  return configRefOf(installed);
}

function skillsPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const name = installedSkillName(installed);
  const flag = skillsScopeFlag(scopeOf(installed));
  const agent = safeSegment(installed.harness);
  if (name === undefined || flag === undefined) {
    return manualPlan(row, installed, candidate);
  }
  const scope = flag === "" ? [] : [flag];
  const target = quoted(skillDirectoryOf(installed));
  // `skills update` has no -a/--agent flag; scope and name only.
  const update = ["npx", "skills", "update", ...scope, name].join(" ");
  if (row.action === "upgrade") return withSafety(target, [update]);
  const spec = candidate === undefined ? undefined : candidateSkillsSpec(candidate);
  if (agent === undefined || spec === undefined) {
    return manualPlan(row, installed, candidate);
  }
  return withSafety(target, [
    ["npx", "skills", "remove", ...scope, "-a", agent, name].join(" "),
    ["npx", "skills", "add", ...scope, "-a", agent, spec].join(" "),
  ]);
}

// Project/local plugins live in the config file, not in the global plugin
// registry the CLI mutates.
function opencodeConfigPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] | undefined {
  const source = safeInstalledSource(installed);
  const spec = candidate === undefined ? undefined : installSpec(candidate);
  if (source === undefined || spec === undefined) return undefined;
  const config = quoted(configRefOf(installed));
  return row.action === "upgrade"
    ? withSafety(config, [
        `Edit ${config}: update the "${quoted(source)}" plugin entry to "${quoted(spec)}".`,
      ])
    : withSafety(config, [
        `Edit ${config}: remove "${quoted(source)}" from the "plugin" array.`,
        `Edit ${config}: add "${quoted(spec)}" to the "plugin" array.`,
      ]);
}

function opencodePluginPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  if (
    installed.sourceRef !== undefined &&
    isLocalSpec(installed.sourceRef)
  ) {
    return localPluginPlan(row, installed, candidate);
  }
  if (scopeOf(installed) !== "global") {
    const configPlan = opencodeConfigPlan(row, installed, candidate);
    return configPlan ?? manualPlan(row, installed, candidate);
  }
  const config = quoted(configRefOf(installed));
  const source = safeInstalledSource(installed);
  const spec = candidate === undefined ? undefined : installSpec(candidate);
  if (row.action === "upgrade") {
    const updateTarget = source ?? spec;
    return updateTarget === undefined
      ? manualPlan(row, installed, candidate)
      : withSafety(config, [`opencode plugin update ${updateTarget}`]);
  }
  if (source === undefined || spec === undefined) {
    return manualPlan(row, installed, candidate);
  }
  return withSafety(config, [
    `opencode plugin remove ${source}`,
    `opencode plugin add ${spec}`,
  ]);
}

function claudeScopeArg(scope: InstalledScope): string | undefined {
  return scope === "user" || scope === "project" || scope === "local"
    ? `--scope ${scope}`
    : undefined;
}

function claudePluginPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  const scope = claudeScopeArg(scopeOf(installed));
  if (scope === undefined) return manualPlan(row, installed, candidate);
  const config = quoted(configRefOf(installed));
  const source = safeInstalledSource(installed);
  const spec = candidate === undefined ? undefined : marketplaceSpec(candidate);
  if (row.action === "upgrade") {
    const updateTarget = source ?? spec;
    return updateTarget === undefined
      ? manualPlan(row, installed, candidate)
      : withSafety(config, [`claude plugin update ${scope} ${updateTarget}`]);
  }
  if (source === undefined || spec === undefined) {
    return manualPlan(row, installed, candidate);
  }
  return withSafety(config, [
    `claude plugin uninstall ${scope} --keep-data ${source}`,
    `claude plugin install ${scope} ${spec}`,
  ]);
}

function mcpPlan(
  row: LifecycleRow,
  installed: CapabilityRecord,
  candidate: Candidate | undefined,
): string[] {
  if (candidate === undefined) return [];
  const config = quoted(configRefOf(installed));
  const key = quoted(installed.name);
  const source = quoted(sourceRefOf(candidate));
  return row.action === "upgrade"
    ? withSafety(config, [
        `Edit ${config}: update the "${key}" server entry to "${source}".`,
      ])
    : withSafety(config, [
        `Edit ${config}: remove the "${key}" server entry.`,
        `Edit ${config}: add the "${quoted(candidate.id)}" server entry from "${source}".`,
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

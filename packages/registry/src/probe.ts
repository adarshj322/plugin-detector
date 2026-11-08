import type { ArtifactType } from "@plugin-detector/core";

// Source-specific raw record as handed to the local pipeline (Task 5 owns
// fetching; this task only normalizes records already on disk). Free-text and
// self-declared fields (tags/topics/keywords/description/readme) are carried
// for diagnostics but never treated as evidence.
export interface RawArtifactRef {
  kind: string;
  file?: string | undefined;
  artifactId?: string | undefined;
  capabilities?: string[] | undefined;
  domains?: string[] | undefined;
}

export interface RawCandidate {
  id?: string | undefined;
  name?: string | undefined;
  artifact?: RawArtifactRef | null | undefined;
  sourceKind?: string | undefined;
  pinnedRef?: string | undefined;
  license?: string | undefined;
  repositoryUrl?: string | undefined;
  registryUrl?: string | undefined;
  packageName?: string | undefined;
  lastVerified?: string | undefined;
  maintenance?: "active" | "stale" | "archived" | "unknown" | undefined;
  auditStatus?: "clean" | "warning" | "critical" | "unknown" | undefined;
  risk?: "low" | "medium" | "high" | "critical" | undefined;
  popularity?:
    | {
        stars?: number | undefined;
        installs?: number | undefined;
        velocity30d?: number | undefined;
      }
    | undefined;
  tags?: string[] | undefined;
  topics?: string[] | undefined;
  keywords?: string[] | undefined;
  description?: string | undefined;
  readme?: string | undefined;
  // Declared install hooks (e.g. npm `postinstall` scripts). Any entry
  // refuses automatic handling: hooks run publisher code at install time.
  installHooks?: string[] | undefined;
}

export interface ArtifactProbe {
  found: boolean;
  artifactType?: ArtifactType | undefined;
  evidence: string[];
  reason?: string | undefined;
}

function baseName(path: string): string {
  const slash = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return slash.toLowerCase();
}

// Vendor/harness namespaces squatted by typo-squat and dependency-confusion
// packages. Blocking is conservative (exact, reserved prefix/scope, or one
// edit away) and never applies to the official channel, which assigns its
// own sourceKind. shortcut: no registry-occupancy lookup; upgrade when a
// false rejection lands with evidence of legitimate prior use.
export const RESERVED_NAMESPACES = [
  "opencode",
  "claude",
  "claude-code",
  "codex",
  "cursor",
  "plugin-detector",
];

// Narrow prompt-injection shape: imperative instruction-override language.
// Shell/exec how-to text is NOT rejected here (legit docs mention shells);
// it sets untrustedCopyRisk at normalize time and suppresses trusted
// handling at classifyTrust time instead.
const PROMPT_INJECTION_PATTERN =
  /\bignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+instructions?\b|\bdisregard\s[^.\n]{0,80}?\b(instructions?|safety|policies?|guidelines?|restrictions?)\b|\byou\s+are\s+now\s+(an?\s+)?(unrestricted|root|admin|different)\b|\bnew\s+system\s+prompt\b/i;

function isOfficialSource(sourceKind: string | undefined): boolean {
  const kind = (sourceKind ?? "").trim().toLowerCase();
  return (
    kind === "official" ||
    kind === "official-registry" ||
    kind === "standards-body"
  );
}

// True when the names differ by a single substitution, insertion, deletion,
// or adjacent transposition.
function oneEditAway(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        diffs.push(i);
        if (diffs.length > 2) return false;
      }
    }
    if (diffs.length === 1) return true;
    if (diffs.length === 2) {
      const [i, j] = [diffs[0] as number, diffs[1] as number];
      return j === i + 1 && a[i] === b[j] && a[j] === b[i];
    }
    return false;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      j += 1;
    }
  }
  return true;
}

// Reserved-name/dependency-confusion block, or null when the name is fine.
// Returns a human-readable reason so normalize surfaces it in the rejection.
// `label` names the inspected field (package name or candidate id).
export function blockedPackageName(
  packageName: string | undefined,
  sourceKind: string | undefined,
  label: string = "package name",
): string | null {
  if (isOfficialSource(sourceKind)) return null;
  const lower = (packageName ?? "").trim().toLowerCase();
  if (!lower) return null;
  const scoped = lower.startsWith("@");
  const rest = scoped ? lower.slice(1) : lower;
  const segments = rest.split("/");
  const scope = scoped ? (segments[0] ?? "") : null;
  const name = scoped ? segments.slice(1).join("/") : lower;
  for (const reserved of RESERVED_NAMESPACES) {
    if (scope !== null && scope !== "" && scope === reserved)
      return `${label} scope "@${scope}" squats reserved namespace "${reserved}"`;
    if (scope !== null && scope !== "" && oneEditAway(scope, reserved))
      return `${label} scope "@${scope}" is confusable with reserved namespace "${reserved}"`;
    if (name === reserved)
      return `${label} "${packageName}" squats reserved name "${reserved}"`;
    // Reserved-prefix rule: only non-official sources reach this function,
    // so a community/marketplace "<reserved>-*" name claiming the vendor
    // namespace is confusion, not coincidence. The official channel (which
    // owns these namespaces) is exempt above, with tests pinning both sides.
    if (name.startsWith(`${reserved}-`) || name.startsWith(`${reserved}_`))
      return `${label} "${packageName}" claims reserved prefix "${reserved}"`;
    if (name !== "" && oneEditAway(name, reserved))
      return `${label} "${packageName}" is confusable with reserved name "${reserved}"`;
  }
  return null;
}

// Local artifact fixtures only: recognized manifest files or kinds map to a
// closed ArtifactType. Anything else (bare tags, unknown files) is not
// evidence, with or without a marketplace id we cannot classify.
export function probeArtifact(input: RawCandidate): ArtifactProbe {
  const hooks = (input.installHooks ?? []).filter((h) => h.trim().length > 0);
  if (hooks.length > 0) {
    return {
      found: false,
      evidence: [],
      reason: `install hooks (${hooks.join(", ")}) run publisher code at install time; automatic handling refused`,
    };
  }
  const untrustedText = [input.description, input.readme]
    .filter((t): t is string => t !== undefined && t.length > 0)
    .join("\n\n");
  if (PROMPT_INJECTION_PATTERN.test(untrustedText)) {
    return {
      found: false,
      evidence: [],
      reason:
        "prompt-injection language in display copy: instruction-override text is never evidence",
    };
  }
  // Both the registry name and the candidate id are inspected: an id-only
  // squat (no packageName set) must not evade the block.
  const blocked =
    blockedPackageName(input.packageName, input.sourceKind) ??
    blockedPackageName(input.id, input.sourceKind, "candidate id");
  if (blocked !== null) {
    return { found: false, evidence: [], reason: blocked };
  }
  const ref = input.artifact;
  if (!ref) {
    return {
      found: false,
      evidence: [],
      reason:
        "no artifact ref: self-declared tags/topics without a probed artifact are not evidence",
    };
  }
  const kind = ref.kind.trim().toLowerCase();
  const file = (ref.file ?? "").trim();
  const name = baseName(file);

  let artifactType: ArtifactType | undefined;
  if (kind === "skill" || name === "skill.md") artifactType = "skill";
  else if (
    kind === "plugin" ||
    name === "plugin.json" ||
    name === ".claude-plugin"
  )
    artifactType = "plugin";
  else if (
    kind === "mcp" ||
    kind === "mcp-server" ||
    name === "server.json" ||
    name === "mcp.json" ||
    name === ".mcp.json"
  )
    artifactType = "mcp-server";
  else if (kind === "hook" || kind === "hooks" || name === "hooks.json")
    artifactType = "hook";
  else if (kind === "command") artifactType = "command";
  else if (kind === "tool") artifactType = "tool";

  if (!artifactType) {
    return {
      found: false,
      evidence: [],
      reason: `unrecognized artifact kind ${JSON.stringify(ref.kind)} with no known manifest file`,
    };
  }

  const evidence: string[] = [];
  if (file) evidence.push(`artifact file ${JSON.stringify(ref.file)}`);
  evidence.push(`artifact kind ${JSON.stringify(ref.kind)}`);
  if (ref.artifactId) evidence.push(`marketplace artifact id ${ref.artifactId}`);
  // Archive/stale hard gate at intake: unmaintained candidates never enter
  // the snapshot (scoring keeps its archived→risky gate as defense in depth
  // for directly built candidates).
  if (input.maintenance === "archived" || input.maintenance === "stale") {
    return {
      found: false,
      evidence,
      reason: `maintenance is "${input.maintenance}": re-verify before listing`,
    };
  }
  return { found: true, artifactType, evidence };
}

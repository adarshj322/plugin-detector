import { OpenCodeAdapter } from "@plugin-detector/opencode";
import { ClaudeCodeAdapter } from "@plugin-detector/claude-code";
import { CodexAdapter } from "@plugin-detector/codex";
import { CursorAdapter } from "@plugin-detector/cursor";
import type {
  Candidate,
  CapabilityRecord,
  InstallPlan,
} from "@plugin-detector/core";
import { loadSnapshot } from "@plugin-detector/registry";
import {
  InventoryJsonSchema,
  printJson,
  printSection,
  type HarnessInventory,
} from "../output.js";

export interface InventoryResult {
  exitCode: number;
}

export type TrustLabel = "verified" | "curated" | "unverified";

interface RawAdapter {
  detect(): Promise<{ detected: boolean }>;
  inventory(): Promise<{
    status: "ok" | "partial";
    records: CapabilityRecord[];
    warnings: string[];
  }>;
  compatibility(candidate: Candidate): number;
  installPlan(candidate: Candidate, trust?: TrustLabel): InstallPlan;
}

interface AdapterLike extends RawAdapter {
  harness: string;
}

export function buildAdapters(home?: string, root?: string): AdapterLike[] {
  const opts = { ...(home ? { home } : {}), ...(root ? { root } : {}) };
  // Fixed order keeps output deterministic across machines.
  const defs: { harness: string; adapter: RawAdapter }[] = [
    { harness: "opencode", adapter: new OpenCodeAdapter(opts) },
    { harness: "claude-code", adapter: new ClaudeCodeAdapter(opts) },
    { harness: "codex", adapter: new CodexAdapter(opts) },
    { harness: "cursor", adapter: new CursorAdapter(opts) },
  ];
  return defs.map((d) => ({
    harness: d.harness,
    detect: () => d.adapter.detect(),
    inventory: () => d.adapter.inventory(),
    compatibility: (candidate: Candidate) =>
      d.adapter.compatibility(candidate),
    installPlan: (candidate: Candidate, trust?: TrustLabel) =>
      d.adapter.installPlan(candidate, trust),
  }));
}

export interface SnapshotCandidate {
  candidate: Candidate;
  trust: TrustLabel;
}

// Shared resolution for `plan` and `install`: the candidate and its trust
// always come from the registry snapshot, never from the plan file.
export function findSnapshotCandidate(
  candidateId: string,
  cacheDir?: string,
): SnapshotCandidate | null {
  const snapshot = loadSnapshot({ ...(cacheDir ? { cacheDir } : {}) });
  const candidate = snapshot.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;
  const provenance = snapshot.provenance.find((p) => p.id === candidateId);
  return { candidate, trust: provenance?.trust ?? "unverified" };
}

function adaptersFor(home?: string, root?: string): AdapterLike[] {
  return buildAdapters(home, root);
}

// Mask secret-shaped values in case a config path or warning ever embeds
// one; values themselves are never read, only names and paths.
function redactSecrets(value: string): string {
  return value
    .replace(
      /((?:token|secret|password|api[-_]?key)\s*[:=]\s*)([^\s;,}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(Bearer\s+)[^\s;,}]+/gi, "$1[redacted]");
}

export async function collectInventories(
  home?: string,
  root?: string,
): Promise<HarnessInventory[]> {
  const out: HarnessInventory[] = [];
  for (const adapter of adaptersFor(home, root)) {
    const detected = (await adapter.detect()).detected;
    if (!detected) {
      out.push({
        harness: adapter.harness,
        detected: false,
        status: "unknown",
        enabled: 0,
        disabled: 0,
        records: [],
        configRefs: [],
        warnings: [],
      });
      continue;
    }
    // Partial inventories merge as-is: a warning never becomes a conflict.
    const inv = await adapter.inventory();
    const refs = [
      ...new Set(inv.records.flatMap((r) => r.configRefs)),
    ].sort();
    out.push({
      harness: adapter.harness,
      detected: true,
      status: inv.status,
      enabled: inv.records.filter((r) => r.enabled).length,
      disabled: inv.records.filter((r) => !r.enabled).length,
      records: inv.records,
      configRefs: refs.map(redactSecrets),
      warnings: inv.warnings.map(redactSecrets),
    });
  }
  return out;
}

export async function inventory(argv: string[]): Promise<InventoryResult> {
  let json = false;
  let home: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  const harnesses = await collectInventories(home, root);
  if (json) {
    printJson({ command: "inventory", facts: { harnesses } }, InventoryJsonSchema);
    return { exitCode: 0 };
  }
  const lines = harnesses.map(
    (h) =>
      `${h.harness}: detected=${h.detected ? "yes" : "no"} status=${h.status} ` +
      `enabled=${h.enabled} disabled=${h.disabled} records=${h.records.length}`,
  );
  for (const h of harnesses) {
    for (const ref of h.configRefs) lines.push(`${h.harness} config: ${ref}`);
    for (const warning of h.warnings)
      lines.push(`${h.harness} warning: ${warning}`);
  }
  // Secrets note: values are never read; only names and paths are shown.
  lines.push("secret values are never read (names and paths only)");
  printSection("facts", lines);
  return { exitCode: 0 };
}

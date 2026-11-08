import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  APPROVAL_TOKEN_ENV,
  consumeApprovalToken,
  stateDir,
} from "./approval.js";
import { InstallPlanSchema, type InstallPlan } from "./schema.js";

// Verified install execution for OpenCode/Claude Code. The orchestrator here
// owns consent (token or interactive TTY) and the file-safety primitives
// (backup preimages, atomic writes, parse-back verify, byte-for-byte
// rollback); harness adapters own the config-merge shapes and call back into
// these helpers. Unverified candidates yield a manual recipe with zero
// mutation. Secrets are never written: only names, paths, and the approved
// commands reach the filesystem.

export interface InstallAdapter {
  applyPlan(plan: InstallPlan): Promise<unknown>;
  rollback(plan: InstallPlan): Promise<{ restored: string[] }>;
}

export interface InstallReceipt {
  status: "applied" | "recipe";
  writes: string[];
  restored: string[];
  recipe?: string;
}

export type InstallErrorCode =
  | "approval-required"
  | "declined"
  | "apply-failed"
  | "invalid-plan"
  | "recipe-only";

export class InstallError extends Error {
  readonly code: InstallErrorCode;

  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

export interface ConsentDetail {
  candidateId: string;
  harness: string;
  candidateName?: string;
  source?: string;
  trust?: string;
  operations: InstallPlan["operations"];
  backupRefs: string[];
  rollback: string[];
}

export interface ApplyInstallOptions {
  approvalToken?: string;
  allowEnvToken?: boolean;
  isTTY?: boolean;
  confirm?: (detail: ConsentDetail) => boolean | Promise<boolean>;
  now?: number;
}

export function isRecipeOnly(plan: InstallPlan): boolean {
  return (
    plan.operations.length > 0 &&
    plan.operations.every((op) => op.kind === "recipe")
  );
}

export function recipeText(plan: InstallPlan): string {
  return plan.operations.map((op) => op.summary).join("\n");
}

export function consentDetail(
  plan: InstallPlan,
  extra?: Pick<ConsentDetail, "candidateName" | "source" | "trust">,
): ConsentDetail {
  return {
    candidateId: plan.candidateId,
    harness: plan.harness,
    ...(extra ?? {}),
    operations: plan.operations,
    backupRefs: plan.backupRefs,
    rollback: plan.rollbackOperations.map((op) => op.summary),
  };
}

function resolveToken(explicit: string | undefined, allowEnv: boolean): string | null {
  if (explicit !== undefined && explicit !== "") return explicit;
  if (!allowEnv) return null;
  const env = process.env[APPROVAL_TOKEN_ENV];
  return env !== undefined && env !== "" ? env : null;
}

export async function applyInstallPlan(
  plan: InstallPlan,
  approval: string | { token?: string | undefined } | null | undefined,
  adapter: InstallAdapter,
  opts?: ApplyInstallOptions,
): Promise<InstallReceipt> {
  const parsed = InstallPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new InstallError("invalid-plan", "Install plan failed validation.");
  }
  const valid = parsed.data;
  if (isRecipeOnly(valid)) {
    return { status: "recipe", writes: [], restored: [], recipe: recipeText(valid) };
  }
  const explicit =
    typeof approval === "string" ? approval : approval?.token ?? undefined;
  const token = resolveToken(explicit, opts?.allowEnvToken ?? true);
  if (token !== null) {
    consumeApprovalToken(token, valid, { now: opts?.now });
  } else if (opts?.isTTY ?? process.stdin.isTTY ?? false) {
    const confirmed = await opts?.confirm?.(consentDetail(valid));
    if (confirmed !== true) {
      throw new InstallError("declined", "Install declined at TTY prompt.");
    }
  } else {
    throw new InstallError(
      "approval-required",
      "Install requires an approval token (non-TTY with no token refuses).",
    );
  }
  try {
    await adapter.applyPlan(valid);
  } catch (error) {
    let restored: string[] = [];
    try {
      restored = (await adapter.rollback(valid)).restored;
    } catch {
      restored = [];
    }
    throw new InstallError(
      "apply-failed",
      `Install failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { status: "applied", writes: [...valid.backupRefs], restored: [] };
}

// --- File-safety primitives (backup preimages, atomic writes, rollback) ---

function backupsDir(dir?: string): string {
  return path.join(dir ?? stateDir(), "backups");
}

function backupKey(target: string): string {
  return createHash("sha256").update(path.resolve(target)).digest("hex");
}

export function backupFilePath(target: string, dir?: string): string {
  return path.join(backupsDir(dir), `${backupKey(target)}.json`);
}

interface BackupMeta {
  target: string;
  existed: boolean;
  isDirectory: boolean;
}

// Snapshot the preimage (or its absence) before any write. Never throws for
// missing paths: absence is itself the preimage.
export function backupFile(target: string, dir?: string): string | null {
  const meta: BackupMeta = {
    target: path.resolve(target),
    existed: existsSync(target),
    isDirectory: false,
  };
  let bytes: Buffer | null = null;
  if (meta.existed) {
    try {
      meta.isDirectory = statSync(target).isDirectory();
    } catch {
      meta.isDirectory = false;
    }
    if (!meta.isDirectory) bytes = readFileSync(target);
  }
  const base = path.join(backupsDir(dir), backupKey(target));
  mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
  writeFileSync(`${base}.meta.json`, JSON.stringify(meta), { mode: 0o600 });
  if (bytes !== null) writeFileSync(`${base}.bytes`, bytes, { mode: 0o600 });
  return meta.existed && !meta.isDirectory ? `${base}.bytes` : null;
}

// Atomic write: tmp file in the target dir plus rename, so a crash never
// leaves a torn config behind.
export function atomicWriteFile(target: string, content: string | NodeJS.ArrayBufferView): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, target);
}

// Parse-back verify: the bytes on disk must parse after the write.
export function verifyParseableJson(target: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch (error) {
    throw new InstallError(
      "apply-failed",
      `Parse-back validation failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsed;
}

// Byte-for-byte rollback of every backed-up path. Files the install created
// are removed; directories are never deleted (an external command may own
// them — the plan's rollback recipe covers manual removal).
export function restoreBackups(targets: string[], dir?: string): string[] {
  const restored: string[] = [];
  for (const target of targets) {
    const base = path.join(backupsDir(dir), backupKey(target));
    let meta: BackupMeta;
    try {
      meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8")) as BackupMeta;
    } catch {
      continue;
    }
    const resolved = meta.target;
    if (meta.isDirectory) continue;
    if (meta.existed) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(`${base}.bytes`);
      } catch {
        continue;
      }
      try {
        atomicWriteFile(resolved, bytes);
      } catch {
        continue;
      }
      restored.push(target);
    } else if (existsSync(resolved)) {
      try {
        if (!statSync(resolved).isDirectory()) {
          rmSync(resolved);
          restored.push(target);
        }
      } catch {
        continue;
      }
    }
    try {
      rmSync(`${base}.meta.json`);
    } catch {
      // Best effort: stale metadata never blocks a restore.
    }
    try {
      rmSync(`${base}.bytes`);
    } catch {
      // Best effort: stale preimages never block a restore.
    }
  }
  return restored;
}

// --- Operation summary parsing (installPlan and applyPlan share these) ---
//
// Plans carry human-readable summaries, so applyPlan re-derives the exact
// edit from our own anchored formats and refuses anything else.

export interface AppendEdit {
  source: string;
  key: string;
  mode: "array" | "map";
  file: string;
}

const APPEND_RE = /^Append "(.+)" to the "([^"]+)" (array|map) in (.+)\.$/;

export function parseAppendOp(op: InstallPlan["operations"][number]): AppendEdit {
  const match = APPEND_RE.exec(op.summary);
  if (match === null || match[1] === undefined || match[4] === undefined) {
    throw new InstallError(
      "apply-failed",
      `Unrecognized append operation: ${op.summary}`,
    );
  }
  if (op.target !== undefined && op.target !== match[4]) {
    throw new InstallError(
      "apply-failed",
      `Append target mismatch for ${op.summary}`,
    );
  }
  return {
    source: match[1],
    key: match[2] ?? "",
    mode: match[3] === "map" ? "map" : "array",
    file: match[4],
  };
}

export interface McpEdit {
  serverId: string;
  source: string;
  section: string;
  file: string;
}

const MCP_RE = /^Merge MCP server "(.+)" \(source (.+)\) into the "([^"]+)" object in (.+)\.$/;

export function parseMcpOp(op: InstallPlan["operations"][number]): McpEdit {
  const match = MCP_RE.exec(op.summary);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  ) {
    throw new InstallError(
      "apply-failed",
      `Unrecognized MCP merge operation: ${op.summary}`,
    );
  }
  if (op.target !== undefined && op.target !== match[4]) {
    throw new InstallError(
      "apply-failed",
      `MCP target mismatch for ${op.summary}`,
    );
  }
  return { serverId: match[1], source: match[2], section: match[3], file: match[4] };
}

const RUN_RE = /npx skills add (\S+)/;

export function parseRunSource(summary: string): string {
  const match = RUN_RE.exec(summary);
  if (match === null || match[1] === undefined) {
    throw new InstallError(
      "apply-failed",
      `Unrecognized run operation: ${summary}`,
    );
  }
  return match[1];
}

// A URL source cannot become a runnable MCP command, so it stays a manual
// recipe instead of a fabricated entry.
export function isRunnableSource(source: string): boolean {
  return !source.includes("://") && !source.startsWith("/") && !source.startsWith(".");
}

export interface RunResult {
  status: number;
}

export type RunCommand = (command: string, args: string[]) => RunResult;

export function defaultRunCommand(command: string, args: string[]): RunResult {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return { status: result.status ?? 1 };
}

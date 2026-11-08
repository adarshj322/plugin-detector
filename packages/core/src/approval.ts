import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { InstallPlan } from "./schema.js";

// One-shot scoped consent tokens. Tokens live in a single 0600 JSON file
// under the managed state dir so approval survives the approve/install
// process boundary without ever touching candidate config files.
export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;
export const APPROVAL_TOKEN_MAX_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_TOKEN_ENV = "PLUGIN_DETECTOR_APPROVAL_TOKEN";
export const APPROVAL_STATE_DIR_ENV = "PLUGIN_DETECTOR_STATE_DIR";

export interface ApprovalToken {
  token: string;
  candidateId: string;
  planHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export type ApprovalErrorCode =
  | "missing"
  | "expired"
  | "candidate-mismatch"
  | "plan-mismatch"
  | "reused";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

interface TokenStore {
  tokens: Record<string, ApprovalToken>;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function stateDir(): string {
  const override = process.env[APPROVAL_STATE_DIR_ENV];
  if (override !== undefined && override.length > 0) return override;
  return path.join(homedir(), ".plugin-detector");
}

export function approvalsPath(dir?: string): string {
  return path.join(dir ?? stateDir(), "approvals");
}

// Canonical plan serialization: stable JSON of the operations array (sorted
// keys, no whitespace variance), sha256 hex. Approve stores it, install
// recomputes and compares.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalPlanHash(
  operations: InstallPlan["operations"],
): string {
  return createHash("sha256").update(stableStringify(operations)).digest("hex");
}

export function planHash(plan: InstallPlan): string {
  return canonicalPlanHash(plan.operations);
}

function loadStore(file: string): TokenStore {
  if (!existsSync(file)) return { tokens: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Approval store is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("tokens" in parsed) ||
    parsed.tokens === null ||
    typeof parsed.tokens !== "object"
  ) {
    throw new Error("Approval store is corrupt: expected { tokens }.");
  }
  return { tokens: parsed.tokens as Record<string, ApprovalToken> };
}

function saveStore(file: string, store: TokenStore): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function createApprovalToken(args: {
  candidateId: string;
  planHash: string;
  ttlMs?: number;
  now?: number;
}): ApprovalToken {
  const { candidateId, planHash: hash } = args;
  if (candidateId.length === 0) throw new Error("candidateId is required.");
  if (!HEX64.test(hash)) {
    throw new Error("planHash must be a sha256 hex digest.");
  }
  let ttl = args.ttlMs ?? APPROVAL_TOKEN_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = APPROVAL_TOKEN_TTL_MS;
  ttl = Math.min(ttl, APPROVAL_TOKEN_MAX_TTL_MS);
  const at = args.now ?? Date.now();
  const record: ApprovalToken = {
    token: randomBytes(32).toString("hex"),
    candidateId,
    planHash: hash.toLowerCase(),
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + ttl).toISOString(),
    usedAt: null,
  };
  const file = approvalsPath();
  const store = loadStore(file);
  store.tokens[record.token] = record;
  saveStore(file, store);
  return record;
}

function checkRecord(
  record: ApprovalToken | undefined,
  plan: InstallPlan,
  now: number,
): ApprovalToken {
  if (record === undefined) {
    throw new ApprovalError("missing", "No such approval token.");
  }
  if (record.usedAt !== null) {
    throw new ApprovalError("reused", "Approval token was already used.");
  }
  if (now > Date.parse(record.expiresAt)) {
    throw new ApprovalError("expired", "Approval token has expired.");
  }
  if (record.candidateId !== plan.candidateId) {
    throw new ApprovalError(
      "candidate-mismatch",
      `Approval token is for candidate "${record.candidateId}", not "${plan.candidateId}".`,
    );
  }
  if (record.planHash.toLowerCase() !== planHash(plan).toLowerCase()) {
    throw new ApprovalError(
      "plan-mismatch",
      "Install plan does not match the approved plan hash.",
    );
  }
  return record;
}

// Read-only check: verifies without consuming.
export function verifyApprovalToken(
  tokenValue: string | null | undefined,
  plan: InstallPlan,
  opts?: { now?: number | undefined },
): ApprovalToken {
  if (tokenValue === null || tokenValue === undefined || tokenValue === "") {
    throw new ApprovalError("missing", "No approval token was provided.");
  }
  const store = loadStore(approvalsPath());
  return checkRecord(store.tokens[tokenValue], plan, opts?.now ?? Date.now());
}

// Atomic single-use consumption: verify + mark used in one step so a reused
// token refuses before any write happens.
export function consumeApprovalToken(
  tokenValue: string | null | undefined,
  plan: InstallPlan,
  opts?: { now?: number | undefined },
): ApprovalToken {
  if (tokenValue === null || tokenValue === undefined || tokenValue === "") {
    throw new ApprovalError("missing", "No approval token was provided.");
  }
  const file = approvalsPath();
  const store = loadStore(file);
  const record = checkRecord(
    store.tokens[tokenValue],
    plan,
    opts?.now ?? Date.now(),
  );
  const consumed: ApprovalToken = {
    ...record,
    usedAt: new Date(opts?.now ?? Date.now()).toISOString(),
  };
  store.tokens[tokenValue] = consumed;
  saveStore(file, store);
  return consumed;
}

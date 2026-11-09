import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyInstallPlan,
  atomicWriteFile,
  backupFile,
  consentDetail,
  InstallError,
  isRecipeOnly,
  restoreBackups,
  verifyParseableJson,
  type InstallAdapter,
} from "../src/install.js";
import {
  ApprovalError,
  createApprovalToken,
  planHash,
} from "../src/approval.js";
import { InstallPlanSchema, type InstallPlan } from "../src/index.js";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";
const TOKEN_ENV = "PLUGIN_DETECTOR_APPROVAL_TOKEN";

let savedState: string | undefined;
let savedToken: string | undefined;
let stateDir: string;
let workDir: string;

beforeEach(() => {
  savedState = process.env[STATE_ENV];
  savedToken = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  stateDir = mkdtempSync(join(tmpdir(), "pd-install-state-"));
  workDir = mkdtempSync(join(tmpdir(), "pd-install-work-"));
  process.env[STATE_ENV] = stateDir;
});

afterEach(() => {
  if (savedState === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = savedState;
  if (savedToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedToken;
});

function makePlan(candidateId = "cand-1"): InstallPlan {
  const target = join(workDir, "opencode.json");
  return InstallPlanSchema.parse({
    candidateId,
    harness: "opencode",
    operations: [
      {
        kind: "append",
        target,
        summary: `Append "pkg" to the "plugin" array in ${target}.`,
      },
    ],
    backupRefs: [target],
    rollbackOperations: [{ kind: "recipe", summary: "Restore the backup." }],
    approvalTokenRequired: true,
  });
}

function recipePlan(): InstallPlan {
  return InstallPlanSchema.parse({
    candidateId: "unverified-1",
    harness: "opencode",
    operations: [
      {
        kind: "recipe",
        summary:
          'Manual install of "x" (hook) from src: no harness-native installer. No files were changed.',
      },
    ],
    backupRefs: [],
    rollbackOperations: [],
    approvalTokenRequired: true,
  });
}

function fakeAdapter(): InstallAdapter & { calls: number } {
  const fake = {
    calls: 0,
    async applyPlan(_plan: InstallPlan): Promise<{ applied: string[] }> {
      fake.calls += 1;
      return { applied: [] };
    },
    async rollback(_plan: InstallPlan): Promise<{ restored: string[] }> {
      return { restored: [] };
    },
  };
  return fake;
}

function mint(plan: InstallPlan): string {
  return createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  }).token;
}

test("reused approval token performs zero writes", async () => {
  const plan = makePlan();
  const before = readTree(workDir);
  const token = mint(plan);
  const adapter = fakeAdapter();
  await applyInstallPlan(plan, token, adapter, { isTTY: false });
  assert.equal(adapter.calls, 1);
  await assert.rejects(applyInstallPlan(plan, token, adapter), (error: unknown) => {
    assert.ok(error instanceof ApprovalError);
    assert.equal((error as { code: unknown }).code, "reused");
    return true;
  });
  assert.equal(adapter.calls, 1);
  assert.deepEqual(readTree(workDir), before);
});

function readTree(dir: string): string {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push(`${full}:${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

test("missing token on non-TTY refuses without writes", async () => {
  const plan = makePlan();
  const before = readTree(workDir);
  await assert.rejects(
    applyInstallPlan(plan, null, fakeAdapter(), { isTTY: false }),
    (error: unknown) => {
      assert.ok(error instanceof InstallError);
      assert.equal((error as { code: unknown }).code, "approval-required");
      return true;
    },
  );
  assert.deepEqual(readTree(workDir), before);
});

test("bogus token is refused as missing", async () => {
  const plan = makePlan();
  await assert.rejects(
    applyInstallPlan(plan, "bogus", fakeAdapter(), { isTTY: false }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "missing");
      return true;
    },
  );
});

test("expired, mismatched, and reused tokens refuse with zero writes", async () => {
  const plan = makePlan();
  const before = readTree(workDir);
  const expired = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
    ttlMs: 60 * 1000,
    now: Date.now() - 120 * 1000,
  }).token;
  await assert.rejects(
    applyInstallPlan(plan, expired, fakeAdapter(), { isTTY: false }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "expired");
      return true;
    },
  );
  const otherCandidate = createApprovalToken({
    candidateId: "someone-else",
    planHash: planHash(plan),
  }).token;
  await assert.rejects(
    applyInstallPlan(plan, otherCandidate, fakeAdapter(), { isTTY: false }),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "candidate-mismatch");
      return true;
    },
  );
  assert.deepEqual(readTree(workDir), before);
});

test("env token is accepted when no flag token is given", async () => {
  const plan = makePlan();
  process.env[TOKEN_ENV] = mint(plan);
  const receipt = await applyInstallPlan(plan, null, fakeAdapter(), {
    isTTY: false,
  });
  assert.equal(receipt.status, "applied");
});

test("TTY confirmation path applies without a token when confirmed", async () => {
  const plan = makePlan();
  let seen: unknown = null;
  const receipt = await applyInstallPlan(plan, null, fakeAdapter(), {
    isTTY: true,
    confirm: (detail) => {
      seen = detail;
      return true;
    },
  });
  assert.equal(receipt.status, "applied");
  const detail = consentDetail(plan);
  assert.deepEqual(Object.keys(seen as object).sort(), Object.keys(detail).sort());
});

test("TTY decline refuses without writes", async () => {
  const plan = makePlan();
  const before = readTree(workDir);
  await assert.rejects(
    applyInstallPlan(plan, null, fakeAdapter(), {
      isTTY: true,
      confirm: () => false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof InstallError);
      assert.equal((error as { code: unknown }).code, "declined");
      return true;
    },
  );
  assert.deepEqual(readTree(workDir), before);
});

test("untrusted-candidate manual recipe performs zero writes", async () => {
  const plan = recipePlan();
  assert.ok(isRecipeOnly(plan));
  const before = readTree(workDir);
  const adapter = fakeAdapter();
  const receipt = await applyInstallPlan(plan, null, adapter, {
    isTTY: false,
  });
  assert.equal(receipt.status, "recipe");
  assert.equal(adapter.calls, 0);
  assert.deepEqual(readTree(workDir), before);
});

test("backup and restore round-trips bytes exactly", () => {
  const target = join(workDir, "cfg.json");
  const preimage = '{"a":1}\n';
  writeFileSync(target, preimage);
  backupFile(target, stateDir);
  writeFileSync(target, '{"a":2}\n');
  const restored = restoreBackups([target], stateDir);
  assert.deepEqual(restored, [target]);
  assert.equal(readFileSync(target, "utf8"), preimage);
});

test("restore deletes files the install created", () => {
  const target = join(workDir, "new.json");
  backupFile(target, stateDir);
  atomicWriteFile(target, "{}\n");
  const restored = restoreBackups([target], stateDir);
  assert.deepEqual(restored, [target]);
  assert.throws(() => readFileSync(target, "utf8"));
});

test("restore leaves directories created after backup in place", () => {
  const target = join(workDir, "skills");
  backupFile(target, stateDir);
  mkdirSync(target, { recursive: true });
  assert.deepEqual(restoreBackups([target], stateDir), []);
  assert.ok(statSync(target).isDirectory());
});

test("parse-back validation failure restores the preimage", () => {
  const target = join(workDir, "cfg.json");
  const preimage = '{"ok":true}\n';
  writeFileSync(target, preimage);
  backupFile(target, stateDir);
  // Simulate a torn write: garbage lands on disk after the write step.
  writeFileSync(target, "{not json");
  assert.throws(() => verifyParseableJson(target));
  assert.deepEqual(restoreBackups([target], stateDir), [target]);
  assert.equal(readFileSync(target, "utf8"), preimage);
});

test("adapter failure triggers orchestrator rollback and apply-failed", async () => {
  const target = join(workDir, "cfg.json");
  const preimage = '{"plugin":[]}\n';
  writeFileSync(target, preimage);
  backupFile(target, stateDir);
  let rolled = 0;
  const failing = {
    async applyPlan(_plan: InstallPlan): Promise<never> {
      writeFileSync(target, "PARTIAL");
      throw new Error("boom");
    },
    async rollback(_plan: InstallPlan): Promise<{ restored: string[] }> {
      rolled += 1;
      return { restored: restoreBackups([target], stateDir) };
    },
  };
  const plan = InstallPlanSchema.parse({
    candidateId: "cand-1",
    harness: "opencode",
    operations: [
      {
        kind: "append",
        target,
        summary: `Append "pkg" to the "plugin" array in ${target}.`,
      },
    ],
    backupRefs: [target],
    rollbackOperations: [{ kind: "recipe", summary: "Restore the backup." }],
    approvalTokenRequired: true,
  });
  const token = mint(plan);
  await assert.rejects(applyInstallPlan(plan, token, failing), (error: unknown) => {
    assert.ok(error instanceof InstallError);
    assert.equal((error as { code: unknown }).code, "apply-failed");
    assert.match((error as Error).message, /boom/);
    return true;
  });
  assert.equal(rolled, 1);
  assert.equal(readFileSync(target, "utf8"), preimage);
});

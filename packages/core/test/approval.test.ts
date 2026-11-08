import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_TOKEN_MAX_TTL_MS,
  APPROVAL_TOKEN_TTL_MS,
  ApprovalError,
  approvalsPath,
  canonicalPlanHash,
  consumeApprovalToken,
  createApprovalToken,
  planHash,
  verifyApprovalToken,
} from "../src/approval.js";
import { InstallPlanSchema, type InstallPlan } from "../src/index.js";

const ENV_KEY = "PLUGIN_DETECTOR_STATE_DIR";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  process.env[ENV_KEY] = mkdtempSync(join(tmpdir(), "pd-approvals-"));
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

function makePlan(candidateId = "cand-1"): InstallPlan {
  return InstallPlanSchema.parse({
    candidateId,
    harness: "opencode",
    operations: [
      {
        kind: "append",
        target: "/tmp/pd-opencode.json",
        summary: 'Append "pkg" to the "plugin" array in /tmp/pd-opencode.json.',
      },
    ],
    backupRefs: ["/tmp/pd-opencode.json"],
    rollbackOperations: [{ kind: "recipe", summary: "Restore the backup." }],
    approvalTokenRequired: true,
  });
}

test("createApprovalToken defaults to a 10-minute TTL", () => {
  const plan = makePlan();
  const now = Date.now();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
    now,
  });
  assert.equal(record.usedAt, null);
  assert.equal(
    Date.parse(record.expiresAt) - Date.parse(record.createdAt),
    APPROVAL_TOKEN_TTL_MS,
  );
  assert.equal(APPROVAL_TOKEN_TTL_MS, 10 * 60 * 1000);
});

test("createApprovalToken caps TTL at 30 minutes", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
    ttlMs: 60 * 60 * 1000,
  });
  assert.equal(
    Date.parse(record.expiresAt) - Date.parse(record.createdAt),
    APPROVAL_TOKEN_MAX_TTL_MS,
  );
  assert.equal(APPROVAL_TOKEN_MAX_TTL_MS, 30 * 60 * 1000);
});

test("approval store file is mode 0600", () => {
  const plan = makePlan();
  createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  });
  const mode = statSync(approvalsPath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("canonical plan hash is stable under key order variance", () => {
  const a: InstallPlan["operations"] = [
    { kind: "write", target: "/x", summary: "s" },
  ];
  const b: InstallPlan["operations"] = [
    { summary: "s", target: "/x", kind: "write" },
  ];
  assert.equal(canonicalPlanHash(a), canonicalPlanHash(b));
  assert.match(canonicalPlanHash(a), /^[0-9a-f]{64}$/);
});

test("verifyApprovalToken accepts a fresh token for the same plan", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  });
  const checked = verifyApprovalToken(record.token, plan);
  assert.equal(checked.token, record.token);
  // Verify does not consume: the token stays single-use for install.
  assert.equal(verifyApprovalToken(record.token, plan).token, record.token);
});

test("unknown token is refused as missing", () => {
  assert.throws(() => verifyApprovalToken("nope", makePlan()), (error: unknown) => {
    assert.ok(error instanceof ApprovalError);
    assert.equal((error as { code: unknown }).code, "missing");
    return true;
  });
});

test("expired token is refused", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
    ttlMs: 60 * 1000,
    now: Date.now() - 120 * 1000,
  });
  assert.throws(
    () => verifyApprovalToken(record.token, plan),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "expired");
      return true;
    },
  );
});

test("candidate mismatch is refused with a distinct code", () => {
  const plan = makePlan("cand-1");
  const record = createApprovalToken({
    candidateId: "cand-1",
    planHash: planHash(plan),
  });
  assert.throws(
    () => verifyApprovalToken(record.token, makePlan("cand-2")),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "candidate-mismatch");
      return true;
    },
  );
});

test("plan hash mismatch is refused with a distinct code", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  });
  const other = InstallPlanSchema.parse({
    ...JSON.parse(JSON.stringify(plan)),
    operations: [
      { kind: "write", target: "/other.json", summary: "Different op." },
    ],
  });
  assert.throws(
    () => verifyApprovalToken(record.token, other),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "plan-mismatch");
      return true;
    },
  );
});

test("consumed token is refused as reused", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  });
  consumeApprovalToken(record.token, plan);
  assert.throws(
    () => verifyApprovalToken(record.token, plan),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "reused");
      return true;
    },
  );
  assert.throws(
    () => consumeApprovalToken(record.token, plan),
    (error: unknown) => {
      assert.ok(error instanceof ApprovalError);
      assert.equal((error as { code: unknown }).code, "reused");
      return true;
    },
  );
});

test("non-hex plan hashes are rejected at mint time", () => {
  assert.throws(() =>
    createApprovalToken({ candidateId: "c", planHash: "zzz" }),
  );
});

test("store file contents round-trip through the written file", () => {
  const plan = makePlan();
  const record = createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  });
  const raw = JSON.parse(readFileSync(approvalsPath(), "utf8")) as {
    tokens: Record<string, { candidateId: string }>;
  };
  assert.equal(raw.tokens[record.token]?.candidateId, "cand-1");
});

function runConsumer(
  planFile: string,
  token: string,
  modUrl: string,
  stateDir: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { readFileSync } from "node:fs";',
          "const [planFile, token, modUrl] = process.argv.slice(1);",
          "const plan = JSON.parse(readFileSync(planFile, 'utf8'));",
          "const mod = await import(modUrl);",
          "try { mod.consumeApprovalToken(token, plan); process.exitCode = 0; }",
          "catch (error) { process.exitCode = error && error.code === 'reused' ? 4 : 1; }",
        ].join("\n"),
        planFile,
        token,
        modUrl,
      ],
      { env: { ...process.env, PLUGIN_DETECTOR_STATE_DIR: stateDir }, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

test("concurrent consumers split exactly one success and one reuse", async () => {
  const stateDir = process.env[ENV_KEY] as string;
  const modUrl = new URL("../src/approval.js", import.meta.url).href;
  for (let round = 0; round < 5; round += 1) {
    const plan = makePlan();
    const planFile = join(stateDir, `plan-${round}.json`);
    writeFileSync(planFile, JSON.stringify(plan));
    const token = createApprovalToken({
      candidateId: plan.candidateId,
      planHash: planHash(plan),
    }).token;
    const [first, second] = await Promise.all([
      runConsumer(planFile, token, modUrl, stateDir),
      runConsumer(planFile, token, modUrl, stateDir),
    ]);
    assert.deepEqual(
      [first, second].sort(),
      [0, 4],
      `round ${round}: expected one consume and one reuse`,
    );
  }
  assert.ok(!existsSync(join(stateDir, "approvals.lock")));
});

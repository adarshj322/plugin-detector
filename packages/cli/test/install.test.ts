import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve } from "../src/commands/approve.js";
import {
  buildConsentLines,
  describeCandidate,
  install,
} from "../src/commands/install.js";
import {
  ApproveJsonSchema,
  InstallJsonSchema,
} from "../src/output.js";
import {
  InstallPlanSchema,
  canonicalPlanHash,
  createApprovalToken,
  planHash,
  type InstallPlan,
} from "@plugin-detector/core";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";
const TOKEN_ENV = "PLUGIN_DETECTOR_APPROVAL_TOKEN";

let savedState: string | undefined;
let savedToken: string | undefined;
let base: string;
let home: string;
let root: string;
let planFile: string;

beforeEach(() => {
  savedState = process.env[STATE_ENV];
  savedToken = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  base = mkdtempSync(join(tmpdir(), "pd-cli-install-"));
  process.env[STATE_ENV] = join(base, "state");
  home = join(base, "home");
  root = join(base, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  planFile = join(base, "plan.json");
});

afterEach(() => {
  if (savedState === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = savedState;
  if (savedToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedToken;
});

async function capture(run: () => Promise<unknown>): Promise<{
  logs: string[];
  errors: string[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

function writePlan(plan: InstallPlan): string {
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return planFile;
}

function pluginPlan(): InstallPlan {
  return InstallPlanSchema.parse({
    candidateId: "c1",
    harness: "opencode",
    operations: [
      {
        kind: "append",
        target: join(root, "opencode.json"),
        summary: `Append "@ex/c1" to the "plugin" array in ${join(root, "opencode.json")}.`,
      },
    ],
    backupRefs: [join(root, "opencode.json")],
    rollbackOperations: [
      { kind: "recipe", summary: 'Remove "@ex/c1" to restore.' },
    ],
    approvalTokenRequired: true,
  });
}

function mint(plan: InstallPlan): string {
  return createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  }).token;
}

test("approve mints a token for a plan hash", async () => {
  const plan = pluginPlan();
  const hash = planHash(plan);
  const { logs } = await capture(() =>
    approve(["--candidate", "c1", "--plan", hash]),
  );
  assert.ok(logs.some((line) => line.includes("approval-token:")));
  assert.ok(logs.some((line) => line.includes(hash)));
});

test("approve --plan-file computes the canonical hash", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const { logs } = await capture(() =>
    approve(["--candidate", "c1", "--plan-file", planFile, "--json"]),
  );
  const payload = ApproveJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown);
  assert.equal(payload.facts.planHash, canonicalPlanHash(plan.operations));
});

test("approve caps ttl at 30 minutes", async () => {
  const hash = planHash(pluginPlan());
  await capture(() =>
    approve(["--candidate", "c1", "--plan", hash, "--ttl-minutes", "60"]),
  );
  const store = JSON.parse(
    readFileSync(join(base, "state", "approvals"), "utf8"),
  ) as { tokens: Record<string, { expiresAt: string; createdAt: string }> };
  const [record] = Object.values(store.tokens);
  assert.ok(record !== undefined);
  assert.equal(
    Date.parse(record.expiresAt) - Date.parse(record.createdAt),
    30 * 60 * 1000,
  );
});

test("approve rejects missing args and bad hashes", async () => {
  assert.equal((await approve([])).exitCode, 2);
  assert.equal(
    (await approve(["--candidate", "c1", "--plan", "zzz"])).exitCode,
    2,
  );
  assert.equal(
    (await approve(["--candidate", "c1", "--ttl-minutes", "nope"])).exitCode,
    2,
  );
});

test("install applies a verified plan with a flag token", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const token = mint(plan);
  const { logs } = await capture(() =>
    install([
      "--plan-file",
      planFile,
      "--approval-token",
      token,
      "--home",
      home,
      "--root",
      root,
    ]),
  );
  assert.ok(logs.some((line) => line.includes("status: applied")));
  const merged = JSON.parse(
    readFileSync(join(root, "opencode.json"), "utf8"),
  ) as { plugin: string[] };
  assert.deepEqual(merged.plugin, ["@ex/c1"]);
});

test("install accepts the env token and reports json", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  process.env[TOKEN_ENV] = mint(plan);
  const { logs } = await capture(() =>
    install(["--plan-file", planFile, "--home", home, "--root", root, "--json"]),
  );
  const payload = InstallJsonSchema.parse(
    JSON.parse(logs.join("\n")) as unknown,
  );
  assert.equal(payload.facts.status, "applied");
  assert.deepEqual(payload.facts.writes, [join(root, "opencode.json")]);
});

test("install refuses without a token on non-TTY", async () => {
  writePlan(pluginPlan());
  const { errors } = await capture(() =>
    install(["--plan-file", planFile, "--home", home, "--root", root]),
  );
  assert.ok(errors.some((line) => line.includes("approval-required")));
  assert.ok(!existsSync(join(root, "opencode.json")));
});

test("install exit codes: missing token 4, bogus token 4, reuse 4", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  assert.equal(
    (
      await install([
        "--plan-file",
        planFile,
        "--home",
        home,
        "--root",
        root,
      ])
    ).exitCode,
    4,
  );
  assert.equal(
    (
      await install([
        "--plan-file",
        planFile,
        "--approval-token",
        "bogus",
        "--home",
        home,
        "--root",
        root,
      ])
    ).exitCode,
    4,
  );
  const token = mint(plan);
  assert.equal(
    (
      await install([
        "--plan-file",
        planFile,
        "--approval-token",
        token,
        "--home",
        home,
        "--root",
        root,
      ])
    ).exitCode,
    0,
  );
  assert.equal(
    (
      await install([
        "--plan-file",
        planFile,
        "--approval-token",
        token,
        "--home",
        home,
        "--root",
        root,
      ])
    ).exitCode,
    4,
  );
});

test("install refuses a mismatched plan hash", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const other = InstallPlanSchema.parse({
    ...JSON.parse(JSON.stringify(plan)) as InstallPlan,
    operations: [
      {
        kind: "append",
        target: join(root, "opencode.json"),
        summary: `Append "@ex/evil" to the "plugin" array in ${join(root, "opencode.json")}.`,
      },
    ],
  });
  const token = createApprovalToken({
    candidateId: other.candidateId,
    planHash: planHash(other),
  }).token;
  const code = (
    await install([
      "--plan-file",
      planFile,
      "--approval-token",
      token,
      "--home",
      home,
      "--root",
      root,
    ])
  ).exitCode;
  assert.equal(code, 4);
  assert.ok(!existsSync(join(root, "opencode.json")));
});

test("install prints a manual recipe with zero writes", async () => {
  const plan = InstallPlanSchema.parse({
    candidateId: "u1",
    harness: "opencode",
    operations: [{ kind: "recipe", summary: "Do it by hand." }],
    backupRefs: [],
    rollbackOperations: [],
    approvalTokenRequired: true,
  });
  writePlan(plan);
  const before = existsSync(join(root, "opencode.json"));
  const { logs } = await capture(() =>
    install(["--plan-file", planFile, "--home", home, "--root", root]),
  );
  assert.ok(logs.some((line) => line.includes("Do it by hand.")));
  assert.equal(existsSync(join(root, "opencode.json")), before);
});

test("consent lines show candidate, source, trust, operations, rollback", () => {
  const lines = buildConsentLines({
    candidateId: "c1",
    harness: "opencode",
    candidateName: "C1",
    source: "@ex/c1",
    trust: "verified",
    operations: [
      { kind: "append", target: "/cfg", summary: "Append x." },
    ],
    backupRefs: ["/cfg"],
    rollback: ["Restore the backup."],
  });
  for (const want of [
    "candidate: c1",
    "name: C1",
    "source: @ex/c1",
    "trust: verified",
    "Append x.",
    "backup-refs: /cfg",
    "Restore the backup.",
  ]) {
    assert.ok(
      lines.some((line) => line.includes(want)),
      `missing ${want}`,
    );
  }
});

test("describeCandidate falls back without a snapshot", () => {
  assert.deepEqual(
    describeCandidate("nope", join(base, "no-cache")),
    {},
  );
});

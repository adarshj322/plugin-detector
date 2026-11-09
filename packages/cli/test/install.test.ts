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
import { OpenCodeAdapter } from "@plugin-detector/opencode";
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
  CandidateSchema,
  InstallPlanSchema,
  canonicalPlanHash,
  createApprovalToken,
  planHash,
  type Candidate,
  type InstallPlan,
} from "@plugin-detector/core";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";
const TOKEN_ENV = "PLUGIN_DETECTOR_APPROVAL_TOKEN";

interface SnapshotInput {
  candidate: Candidate;
  trust: "verified" | "curated" | "unverified";
}

let savedState: string | undefined;
let savedToken: string | undefined;
let base: string;
let home: string;
let root: string;
let cacheDir: string;
let planFile: string;

function candidate(
  id: string,
  artifactType: "plugin" | "command" = "plugin",
): Candidate {
  return CandidateSchema.parse({
    id,
    name: id.toUpperCase(),
    artifactType,
    sources: [`https://example.com/${id}`],
    useCaseDomains: ["software-development"],
    capabilities: ["vcs.workflow"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: `https://github.com/example/${id}`,
    packageName: `@ex/${id}`,
    installMode: "verified",
    lastVerified: "2026-11-08T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
  });
}

function writeSnapshot(entries: SnapshotInput[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const at = "2026-11-08T00:00:00.000Z";
  writeFileSync(
    join(cacheDir, "registry-snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: at,
      candidates: entries.map((entry) => entry.candidate),
      provenance: entries.map((entry) => ({
        id: entry.candidate.id,
        sourceUrl: entry.candidate.sources[0],
        retrievedAt: at,
        trust: entry.trust,
      })),
    }),
  );
}

function writePlan(plan: InstallPlan): string {
  writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return planFile;
}

function pluginPlan(): InstallPlan {
  return new OpenCodeAdapter({ home, root }).installPlan(candidate("c1"), "verified");
}

function baseArgs(): string[] {
  return [
    "--plan-file",
    planFile,
    "--candidate",
    "c1",
    "--harness",
    "opencode",
    "--cache-dir",
    cacheDir,
    "--home",
    home,
    "--root",
    root,
  ];
}

function mint(plan: InstallPlan): string {
  return createApprovalToken({
    candidateId: plan.candidateId,
    planHash: planHash(plan),
  }).token;
}

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

beforeEach(() => {
  savedState = process.env[STATE_ENV];
  savedToken = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  base = mkdtempSync(join(tmpdir(), "pd-cli-install-"));
  process.env[STATE_ENV] = join(base, "state");
  home = join(base, "home");
  root = join(base, "root");
  cacheDir = join(base, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  planFile = join(base, "plan.json");
  writeSnapshot([
    { candidate: candidate("c1"), trust: "verified" },
    { candidate: candidate("u1", "command"), trust: "verified" },
    { candidate: candidate("x1"), trust: "unverified" },
  ]);
});

afterEach(() => {
  if (savedState === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = savedState;
  if (savedToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = savedToken;
});

test("approve mints a token for a plan hash", async () => {
  const plan = pluginPlan();
  const hash = planHash(plan);
  const { logs } = await capture(() =>
    approve(["--candidate", "c1", "--plan", hash]),
  );
  assert.ok(logs.some((line) => line.includes("approval-token:")));
  assert.ok(logs.some((line) => line.includes(hash)));
});

test("approve --plan-file computes the full-plan canonical hash", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const { logs } = await capture(() =>
    approve(["--candidate", "c1", "--plan-file", planFile, "--json"]),
  );
  const payload = ApproveJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown);
  assert.equal(payload.facts.planHash, planHash(plan));
  assert.equal(payload.facts.planHash, canonicalPlanHash(plan));
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

test("install applies a verified re-derived plan with a flag token", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const token = mint(plan);
  const { logs } = await capture(() =>
    install([...baseArgs(), "--approval-token", token]),
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
    install([...baseArgs(), "--json"]),
  );
  const payload = InstallJsonSchema.parse(
    JSON.parse(logs.join("\n")) as unknown,
  );
  assert.equal(payload.facts.status, "applied");
  assert.deepEqual(payload.facts.writes, [join(root, "opencode.json")]);
});

test("install refuses without a token on non-TTY", async () => {
  writePlan(pluginPlan());
  const { errors } = await capture(() => install(baseArgs()));
  assert.ok(errors.some((line) => line.includes("approval-required")));
  assert.ok(!existsSync(join(root, "opencode.json")));
});

test("install exit codes: missing token 4, bogus token 4, reuse 4", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  assert.equal((await install(baseArgs())).exitCode, 4);
  assert.equal(
    (await install([...baseArgs(), "--approval-token", "bogus"])).exitCode,
    4,
  );
  const token = mint(plan);
  assert.equal(
    (await install([...baseArgs(), "--approval-token", token])).exitCode,
    0,
  );
  assert.equal(
    (await install([...baseArgs(), "--approval-token", token])).exitCode,
    4,
  );
});

test("install rejects a tampered plan without consuming the token", async () => {
  const expected = pluginPlan();
  const token = mint(expected);
  const tampered = InstallPlanSchema.parse({
    ...expected,
    backupRefs: [...expected.backupRefs, join(root, "evil.json")],
  });
  writePlan(tampered);
  const { errors } = await capture(() =>
    install([...baseArgs(), "--approval-token", token]),
  );
  assert.ok(errors.some((line) => line.includes("plan-mismatch")));
  assert.ok(!existsSync(join(root, "opencode.json")));

  // The same token still works for the real plan: rejection happened before
  // consumption.
  writePlan(expected);
  assert.equal(
    (await install([...baseArgs(), "--approval-token", token])).exitCode,
    0,
  );
});

test("install rejects an unverified candidate before consuming the token", async () => {
  const unverifiedPlan = new OpenCodeAdapter({ home, root }).installPlan(
    candidate("x1"),
    "unverified",
  );
  writePlan(unverifiedPlan);
  const token = mint(unverifiedPlan);
  const args = [
    "--plan-file",
    planFile,
    "--candidate",
    "x1",
    "--harness",
    "opencode",
    "--cache-dir",
    cacheDir,
    "--home",
    home,
    "--root",
    root,
    "--approval-token",
    token,
  ];
  const { errors } = await capture(() => install(args));
  assert.ok(errors.some((line) => line.includes("candidate-unverified")));
  assert.ok(!existsSync(join(root, "opencode.json")));
  const store = JSON.parse(
    readFileSync(join(base, "state", "approvals"), "utf8"),
  ) as { tokens: Record<string, { usedAt: string | null }> };
  assert.equal(store.tokens[token]?.usedAt, null, "token must not be consumed");
});

test("install rejects a plan for a different candidate than --candidate", async () => {
  const plan = pluginPlan();
  writePlan(plan);
  const token = mint(plan);
  const args = [
    "--plan-file",
    planFile,
    "--candidate",
    "u1",
    "--harness",
    "opencode",
    "--cache-dir",
    cacheDir,
    "--home",
    home,
    "--root",
    root,
    "--approval-token",
    token,
  ];
  const { errors } = await capture(() => install(args));
  assert.ok(errors.some((line) => line.includes("plan-mismatch")));
  assert.ok(!existsSync(join(root, "opencode.json")));
});

test("install requires --candidate and --harness", async () => {
  writePlan(pluginPlan());
  assert.equal(
    (await install(["--plan-file", planFile, "--cache-dir", cacheDir])).exitCode,
    2,
  );
  assert.equal(
    (
      await install([
        "--plan-file",
        planFile,
        "--candidate",
        "c1",
        "--harness",
        "nope",
        "--cache-dir",
        cacheDir,
      ])
    ).exitCode,
    2,
  );
});

test("install prints a manual recipe with zero writes", async () => {
  const plan = new OpenCodeAdapter({ home, root }).installPlan(
    candidate("u1", "command"),
    "verified",
  );
  writePlan(plan);
  const before = existsSync(join(root, "opencode.json"));
  const { logs } = await capture(() =>
    install([
      "--plan-file",
      planFile,
      "--candidate",
      "u1",
      "--harness",
      "opencode",
      "--cache-dir",
      cacheDir,
      "--home",
      home,
      "--root",
      root,
    ]),
  );
  assert.ok(logs.some((line) => line.includes("Manual install")));
  assert.equal(existsSync(join(root, "opencode.json")), before);
});

test("consent lines show candidate, source, trust, operations, rollback", () => {
  const lines = buildConsentLines({
    candidateId: "c1",
    harness: "opencode",
    candidateName: "C1",
    source: "@ex/c1",
    canonicalUrl: "https://github.com/ex/c1",
    artifactType: "plugin",
    pinnedRef: "v1.0.0",
    license: "MIT",
    trust: "verified",
    trustEvidence: "https://example.com/list retrieved 2026-11-09; trust verified",
    permissions: "unknown (not declared by source metadata)",
    envVars: "unknown (not declared by source metadata)",
    sideEffects: "writes only the files listed in operations",
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
    "canonical-url: https://github.com/ex/c1",
    "artifact-type: plugin",
    "pinned-ref: v1.0.0",
    "license: MIT",
    "trust: verified",
    "trust-evidence: https://example.com/list",
    "permissions: unknown",
    "env-vars: unknown",
    "side-effects: writes only",
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

test("TTY yes reaches the writer without a token", async () => {
  const { ttyHooks } = await import("../src/commands/install.js");
  writePlan(pluginPlan());
  const origTTY = ttyHooks.isTTY;
  const origConfirm = ttyHooks.confirm;
  let prompted: string[] = [];
  ttyHooks.isTTY = () => true;
  ttyHooks.confirm = async (lines: string[]) => {
    prompted = lines;
    return true;
  };
  try {
    let code = -1;
    const { logs } = await capture(async () => {
      code = (await install(baseArgs())).exitCode;
    });
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.includes("status: applied")));
    assert.ok(prompted.some((line) => line.includes("candidate: c1")));
    assert.ok(prompted.some((line) => line.includes("Append")));
    assert.ok(prompted.some((line) => line.includes("rollback:")));
    const merged = JSON.parse(
      readFileSync(join(root, "opencode.json"), "utf8"),
    ) as { plugin: string[] };
    assert.deepEqual(merged.plugin, ["@ex/c1"]);
  } finally {
    ttyHooks.isTTY = origTTY;
    ttyHooks.confirm = origConfirm;
  }
});

test("TTY decline refuses with zero writes", async () => {
  const { ttyHooks } = await import("../src/commands/install.js");
  writePlan(pluginPlan());
  const origTTY = ttyHooks.isTTY;
  const origConfirm = ttyHooks.confirm;
  ttyHooks.isTTY = () => true;
  ttyHooks.confirm = async () => false;
  try {
    let code = -1;
    const { errors } = await capture(async () => {
      code = (await install(baseArgs())).exitCode;
    });
    assert.equal(code, 4);
    assert.ok(errors.some((line) => line.includes("declined")));
    assert.ok(!existsSync(join(root, "opencode.json")));
  } finally {
    ttyHooks.isTTY = origTTY;
    ttyHooks.confirm = origConfirm;
  }
});

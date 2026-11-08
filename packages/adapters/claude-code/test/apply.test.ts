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
import { ClaudeCodeAdapter } from "../src/index.js";
import {
  CandidateSchema,
  InstallError,
  InstallPlanSchema,
  type Candidate,
  type InstallPlan,
} from "@plugin-detector/core";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";

let saved: string | undefined;
let base: string;
let home: string;
let root: string;

beforeEach(() => {
  saved = process.env[STATE_ENV];
  base = mkdtempSync(join(tmpdir(), "pd-claude-apply-"));
  process.env[STATE_ENV] = join(base, "state");
  home = join(base, "home");
  root = join(base, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = saved;
});

function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return CandidateSchema.parse({
    id: "c1",
    name: "C1",
    artifactType: "plugin",
    sources: ["https://example.com/r"],
    useCaseDomains: ["software-development"],
    capabilities: ["code-search"],
    license: "MIT",
    pinnedRef: "v1.2.3",
    packageName: "@ex/c1",
    installMode: "verified",
    lastVerified: "2026-01-01",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: {},
    ...overrides,
  });
}

function adapter(
  runCommand?: (cmd: string, args: string[]) => { status: number },
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    home,
    root,
    ...(runCommand === undefined ? {} : { runCommand }),
  });
}

test("verified plugin plan sets enabledPlugins and rolls back", async () => {
  const configPath = join(home, ".claude.json");
  const preimage = '{"enabledPlugins":{}}\n';
  writeFileSync(configPath, preimage);
  const plan = adapter().installPlan(candidate(), "verified");
  assert.equal(plan.approvalTokenRequired, true);
  assert.ok(plan.operations.every((op) => op.kind !== "recipe"));
  const receipt = await adapter().applyPlan(plan);
  assert.deepEqual(receipt.applied, [configPath]);
  const merged = JSON.parse(readFileSync(configPath, "utf8")) as {
    enabledPlugins: Record<string, boolean>;
  };
  assert.equal(merged.enabledPlugins["@ex/c1"], true);
  const rolled = await adapter().rollback(plan);
  assert.deepEqual(rolled.restored, [configPath]);
  assert.equal(readFileSync(configPath, "utf8"), preimage);
});

test("verified mcp plan merges into .mcp.json and rolls back", async () => {
  const mcpPath = join(root, ".mcp.json");
  writeFileSync(mcpPath, '{"mcpServers":{}}\n');
  const plan = adapter().installPlan(
    candidate({ id: "m1", artifactType: "mcp-server" }),
    "verified",
  );
  await adapter().applyPlan(plan);
  const merged = JSON.parse(readFileSync(mcpPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(merged.mcpServers["m1"], {
    command: "npx",
    args: ["@ex/c1"],
  });
  await adapter().rollback(plan);
  assert.equal(readFileSync(mcpPath, "utf8"), '{"mcpServers":{}}\n');
});

test("unverified candidate yields a recipe-only plan that apply refuses", async () => {
  const plan = adapter().installPlan(candidate(), "unverified");
  assert.ok(plan.operations.every((op) => op.kind === "recipe"));
  await assert.rejects(adapter().applyPlan(plan), (error: unknown) => {
    assert.ok(error instanceof InstallError);
    assert.equal((error as { code: unknown }).code, "recipe-only");
    return true;
  });
  assert.ok(!existsSync(join(home, ".claude.json")));
});

test("failed skill run rolls back earlier file writes", async () => {
  const configPath = join(home, ".claude.json");
  const preimage = '{"enabledPlugins":{}}\n';
  writeFileSync(configPath, preimage);
  const pluginPlan = adapter().installPlan(candidate(), "verified");
  const skillPlan = adapter().installPlan(
    candidate({ id: "s1", artifactType: "skill" }),
    "verified",
  );
  const plan: InstallPlan = InstallPlanSchema.parse({
    ...pluginPlan,
    operations: [...pluginPlan.operations, ...skillPlan.operations],
    backupRefs: [...pluginPlan.backupRefs, ...skillPlan.backupRefs],
  });
  await assert.rejects(
    adapter(() => ({ status: 1 })).applyPlan(plan),
    /failed with status 1/,
  );
  assert.equal(readFileSync(configPath, "utf8"), preimage);
});

test("write failure restores the first operation byte-for-byte", async () => {
  const configPath = join(home, ".claude.json");
  const preimage = '{"enabledPlugins":{}}\n';
  writeFileSync(configPath, preimage);
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "not a dir");
  const badTarget = join(blocker, ".mcp.json");
  const pluginPlan = adapter().installPlan(candidate(), "verified");
  const mcpPlan = adapter().installPlan(
    candidate({ id: "m1", artifactType: "mcp-server" }),
    "verified",
  );
  const badOp = InstallPlanSchema.parse({
    ...mcpPlan,
    operations: mcpPlan.operations.map((op) => ({
      ...op,
      target: badTarget,
      summary: op.summary.replace(/in .+\.$/, `in ${badTarget}.`),
    })),
  });
  const plan: InstallPlan = InstallPlanSchema.parse({
    ...pluginPlan,
    operations: [...pluginPlan.operations, ...badOp.operations],
    backupRefs: [...pluginPlan.backupRefs, badTarget],
  });
  await assert.rejects(adapter().applyPlan(plan), /ENOTDIR|failed/i);
  assert.equal(readFileSync(configPath, "utf8"), preimage);
  assert.ok(!existsSync(badTarget));
});

test("created config files are removed on rollback", async () => {
  const configPath = join(home, ".claude.json");
  const plan = adapter().installPlan(candidate(), "verified");
  await adapter().applyPlan(plan);
  assert.ok(existsSync(configPath));
  const rolled = await adapter().rollback(plan);
  assert.deepEqual(rolled.restored, [configPath]);
  assert.ok(!existsSync(configPath));
});

test("skill rollback never deletes the pre-existing skills dir", async () => {
  const dest = join(home, ".claude", "skills");
  mkdirSync(dest, { recursive: true });
  const plan = adapter().installPlan(
    candidate({ id: "s1", artifactType: "skill" }),
    "verified",
  );
  await adapter(() => ({ status: 0 })).applyPlan(plan);
  const rolled = await adapter().rollback(plan);
  assert.deepEqual(rolled.restored, []);
  assert.ok(existsSync(dest));
});

test("empty operations fall through to the recipe-only throw", async () => {
  const plan = InstallPlanSchema.parse({
    candidateId: "c1",
    harness: "claude-code",
    operations: [],
    backupRefs: [],
    rollbackOperations: [],
    approvalTokenRequired: true,
  });
  await assert.rejects(adapter().applyPlan(plan), (error: unknown) => {
    assert.ok(error instanceof InstallError);
    assert.equal((error as { code: unknown }).code, "recipe-only");
    return true;
  });
});

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
import { OpenCodeAdapter } from "../src/index.js";
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
  base = mkdtempSync(join(tmpdir(), "pd-opencode-apply-"));
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

function adapter(runCommand?: (cmd: string, args: string[]) => { status: number }): OpenCodeAdapter {
  return new OpenCodeAdapter({
    home,
    root,
    ...(runCommand === undefined ? {} : { runCommand }),
  });
}

test("verified plugin plan applies through config merge and rolls back", async () => {
  const configPath = join(root, "opencode.json");
  const preimage = '{"plugin":["@ex/old"]}\n';
  writeFileSync(configPath, preimage);
  const plan = adapter().installPlan(candidate(), "verified");
  assert.equal(plan.approvalTokenRequired, true);
  assert.ok(plan.operations.every((op) => op.kind !== "recipe"));
  const receipt = await adapter().applyPlan(plan);
  assert.deepEqual(receipt.applied, [configPath]);
  const merged = JSON.parse(readFileSync(configPath, "utf8")) as {
    plugin: string[];
  };
  assert.deepEqual(merged.plugin, ["@ex/old", "@ex/c1"]);
  const rolled = await adapter().rollback(plan);
  assert.deepEqual(rolled.restored, [configPath]);
  assert.equal(readFileSync(configPath, "utf8"), preimage);
});

test("verified mcp plan merges a minimal local entry and rolls back", async () => {
  const configPath = join(root, "opencode.json");
  writeFileSync(configPath, "{}\n");
  const plan = adapter().installPlan(
    candidate({ id: "m1", artifactType: "mcp-server" }),
    "verified",
  );
  await adapter().applyPlan(plan);
  const merged = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcp: Record<string, { command: string[] }>;
  };
  assert.deepEqual(merged.mcp["m1"], {
    type: "local",
    command: ["npx", "@ex/c1"],
  });
  await adapter().rollback(plan);
  assert.equal(readFileSync(configPath, "utf8"), "{}\n");
});

test("unverified candidate yields a recipe-only plan that apply refuses", async () => {
  const plan = adapter().installPlan(candidate(), "unverified");
  assert.ok(plan.operations.every((op) => op.kind === "recipe"));
  const before = existsSync(join(root, "opencode.json"));
  await assert.rejects(adapter().applyPlan(plan), (error: unknown) => {
    assert.ok(error instanceof InstallError);
    assert.equal(
      (error as { code: unknown }).code,
      "recipe-only",
    );
    return true;
  });
  assert.equal(existsSync(join(root, "opencode.json")), before);
});

test("skill run uses the injected runner only after verification", async () => {
  const seen: string[][] = [];
  const plan = adapter().installPlan(
    candidate({ id: "s1", artifactType: "skill" }),
    "verified",
  );
  const receipt = await adapter((cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0 };
  }).applyPlan(plan);
  assert.deepEqual(seen, [["npx", "skills", "add", "@ex/c1"]]);
  assert.deepEqual(receipt.applied, ["npx skills add @ex/c1"]);
});

test("skill rollback never deletes the pre-existing skills dir", async () => {
  const dest = join(home, ".config", "opencode", "skills");
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

test("failed skill run rolls back earlier file writes", async () => {
  const configPath = join(root, "opencode.json");
  const preimage = '{"plugin":[]}\n';
  writeFileSync(configPath, preimage);
  const pluginPlan = adapter().installPlan(candidate(), "verified");
  const skillPlan = adapter().installPlan(
    candidate({ id: "s1", artifactType: "skill" }),
    "verified",
  );
  const plan = InstallPlanSchema.parse({
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
  const configPath = join(root, "opencode.json");
  const preimage = '{"plugin":[]}\n';
  writeFileSync(configPath, preimage);
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "not a dir");
  const badTarget = join(blocker, "nested.json");
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
  const configPath = join(root, "opencode.json");
  const plan = adapter().installPlan(candidate(), "verified");
  await adapter().applyPlan(plan);
  assert.ok(existsSync(configPath));
  const rolled = await adapter().rollback(plan);
  assert.deepEqual(rolled.restored, [configPath]);
  assert.ok(!existsSync(configPath));
});

test("url-source mcp stays manual and writes nothing", async () => {
  const configPath = join(root, "opencode.json");
  const plan = adapter().installPlan(
    candidate({
      id: "m2",
      artifactType: "mcp-server",
      packageName: undefined,
      repositoryUrl: "https://example.com/m2",
    }),
    "verified",
  );
  await assert.rejects(adapter().applyPlan(plan), /manual recipe/);
  assert.ok(!existsSync(configPath));
});

test("empty operations fall through to the recipe-only throw", async () => {
  const plan = InstallPlanSchema.parse({
    candidateId: "c1",
    harness: "opencode",
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

test("jsonc-only config makes plugin/MCP config writes recipe-only", async () => {
  const jsonc = join(root, "opencode.jsonc");
  writeFileSync(jsonc, '{\n  // keep this comment\n  "mcp": {}\n}\n');
  const pluginPlan = adapter().installPlan(candidate(), "verified");
  assert.ok(pluginPlan.operations.every((op) => op.kind === "recipe"));
  assert.match(pluginPlan.operations[0]?.summary ?? "", /opencode\.jsonc/);
  const mcpPlan = adapter().installPlan(
    candidate({ id: "m1", artifactType: "mcp-server" }),
    "verified",
  );
  assert.ok(mcpPlan.operations.every((op) => op.kind === "recipe"));
});

test("jsonc alongside json is preferred and blocks a shadow config write", async () => {
  const json = join(root, "opencode.json");
  const jsonc = join(root, "opencode.jsonc");
  writeFileSync(json, '{"plugin":[]}\n');
  writeFileSync(jsonc, '{/* real config */ "plugin": []}\n');
  const plan = adapter().installPlan(candidate(), "verified");
  assert.equal(plan.operations[0]?.kind, "recipe");
  assert.match(plan.operations[0]?.summary ?? "", /opencode\.jsonc/);
});

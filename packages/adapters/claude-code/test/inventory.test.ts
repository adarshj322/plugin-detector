import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@plugin-detector/core";
import { ClaudeCodeAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/claude-code", import.meta.url),
);
const home = (name: string): string => path.join(FIXTURES, name, "home");
const project = (name: string): string => path.join(FIXTURES, name, "project");
const adapterFor = (name: string): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter({ root: project(name), home: home(name) });

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "test-candidate",
    name: "test candidate",
    artifactType: "skill",
    sources: ["https://example.com/repo"],
    useCaseDomains: ["code-review.quality"],
    capabilities: ["code-review.quality"],
    license: "MIT",
    pinnedRef: "1.2.3",
    repositoryUrl: "https://example.com/repo",
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
    ...overrides,
  };
}

test("empty harness inventories clean", async () => {
  const inventory = await adapterFor("empty").inventory();
  assert.equal(inventory.harness, "claude-code");
  assert.equal(inventory.status, "ok");
  assert.deepEqual(inventory.records, []);
  assert.deepEqual(inventory.warnings, []);
});

test("user project and local plugins normalize with marketplace and version", async () => {
  const inventory = await adapterFor("plugins-scopes").inventory();
  const plugins = inventory.records.filter((entry) => entry.kind === "plugin");
  assert.equal(plugins.length, 6);

  const reviewer = plugins.find((entry) => entry.name === "reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer?.enabled, true);
  assert.equal(reviewer?.contextCostClass, "per-session");
  assert.ok(reviewer?.id.includes("official"));
  assert.ok(reviewer?.id.includes("1.4.0"));
  assert.ok(reviewer?.configRefs.some((ref) => ref.endsWith(".claude.json")));

  const scopes = new Map(plugins.map((entry) => [entry.name, entry.id]));
  assert.ok(scopes.get("reviewer")?.includes(":user:"));
  assert.ok(scopes.get("e2e-help")?.includes(":project:"));
  assert.ok(scopes.get("scratchpad")?.includes(":local:"));
});

test("disabled-but-installed plugin is kept with enabled false", async () => {
  const inventory = await adapterFor("plugins-scopes").inventory();
  const disabled = inventory.records.find(
    (entry) => entry.kind === "plugin" && entry.name === "old-linter",
  );
  assert.ok(disabled);
  assert.equal(disabled?.enabled, false);
});

test("missing marketplace and version stay unknown, never guessed", async () => {
  const inventory = await adapterFor("plugins-scopes").inventory();
  const mystery = inventory.records.find(
    (entry) => entry.kind === "plugin" && entry.name === "mystery",
  );
  assert.ok(mystery);
  assert.ok(mystery?.id.includes("unlisted"));
  assert.ok(!mystery?.id.includes("@"));
  const noversion = inventory.records.find(
    (entry) => entry.kind === "plugin" && entry.name === "noversion",
  );
  assert.ok(noversion);
  assert.ok(!noversion?.id.includes("@"));
  assert.ok(inventory.warnings.length > 0);
  assert.equal(inventory.status, "partial");
});

test("skills and agents inventory as separate kinds with distinct costs", async () => {
  const inventory = await adapterFor("skills-agents").inventory();
  const skills = inventory.records.filter((entry) => entry.kind === "skill");
  const agents = inventory.records.filter((entry) => entry.kind === "agent");
  assert.equal(skills.length, 3);
  assert.equal(agents.length, 3);
  assert.ok(skills.every((entry) => entry.contextCostClass === "per-use"));
  assert.ok(agents.every((entry) => entry.contextCostClass === "per-session"));

  const good = skills.find((entry) => entry.name === "good-skill");
  assert.ok(good);
  assert.deepEqual(good?.capabilities, ["code-review.quality"]);
  assert.ok(good?.id.includes(":project:"));
  const globalSkill = skills.find((entry) => entry.name === "global-skill");
  assert.ok(globalSkill?.id.includes(":user:"));

  const e2e = agents.find((entry) => entry.name === "e2e-runner");
  assert.ok(e2e);
  assert.deepEqual(e2e?.capabilities, ["testing.e2e"]);

  assert.ok(inventory.warnings.length > 0);
  assert.equal(inventory.status, "partial");
});

test("hooks and commands inventory without executing hook commands", async () => {
  const inventory = await adapterFor("hooks-commands").inventory();
  assert.equal(inventory.status, "ok");
  const hooks = inventory.records.filter((entry) => entry.kind === "hook");
  const commands = inventory.records.filter(
    (entry) => entry.kind === "command",
  );
  assert.equal(hooks.length, 4);
  assert.equal(commands.length, 2);
  assert.ok(hooks.every((entry) => entry.contextCostClass === "per-session"));
  assert.ok(commands.every((entry) => entry.contextCostClass === "zero"));

  const preToolUse = hooks.find((entry) => entry.name === "PreToolUse/Edit");
  assert.ok(preToolUse);
  assert.equal(preToolUse?.enabled, true);
  assert.ok(
    preToolUse?.configRefs.some((ref) => ref.endsWith("settings.json")),
  );
  const names = new Set(hooks.map((entry) => entry.name));
  assert.ok(names.has("PostToolUse/Write"));
  assert.ok(names.has("SessionStart"));
  assert.ok(names.has("UserPromptSubmit/.*"));

  const deploy = commands.find((entry) => entry.name === "deploy");
  assert.ok(deploy?.id.includes(":project:"));
  const notes = commands.find((entry) => entry.name === "notes");
  assert.ok(notes?.id.includes(":user:"));

  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("C0MMAND-SECRET-marker"));
});

test("mcp servers inventory per-query from global and project config", async () => {
  const inventory = await adapterFor("mcp").inventory();
  assert.equal(inventory.status, "ok");
  const servers = inventory.records.filter((entry) => entry.kind === "mcp");
  assert.equal(servers.length, 3);
  assert.ok(servers.every((entry) => entry.contextCostClass === "per-query"));

  const reviewer = servers.find((entry) => entry.name === "reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer?.enabled, true);
  assert.ok(reviewer?.id.includes(":user:"));
  const projectDb = servers.find((entry) => entry.name === "project-db");
  assert.ok(projectDb);
  assert.ok(projectDb?.id.includes(":project:"));
  assert.ok(
    projectDb?.configRefs.some((ref) => ref.endsWith(".mcp.json")),
  );
  const disabled = servers.find((entry) => entry.name === "disabled-docs");
  assert.equal(disabled?.enabled, false);

  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("sk-ant-secret-value-that-must-never-appear"));
  assert.ok(!serialized.includes("db-secret-value-that-must-never-appear"));
});

test("invalid claude config does not crash inventory", async () => {
  const inventory = await adapterFor("invalid-config").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(inventory.warnings.length >= 2);
});

test("compatibility scores supported kinds high and caps missing pins", () => {
  const adapter = adapterFor("empty");
  assert.equal(adapter.compatibility(candidate()), 1);
  assert.equal(
    adapter.compatibility(candidate({ artifactType: "mcp-server" })),
    1,
  );
  assert.equal(adapter.compatibility(candidate({ artifactType: "plugin" })), 1);
  // Unverified third-party provenance lowers trust, not compatibility.
  assert.equal(
    adapter.compatibility(
      candidate({ provenance: "unknown", artifactType: "skill" }),
    ),
    1,
  );
  assert.equal(adapter.compatibility(candidate({ artifactType: "tool" })), 0);
  const fractional = adapter.compatibility(
    candidate({ artifactType: "command" }),
  );
  assert.ok(fractional > 0 && fractional < 1);
  assert.ok(
    adapter.compatibility(candidate({ artifactType: "hook" })) > 0 &&
      adapter.compatibility(candidate({ artifactType: "hook" })) < 1,
  );
  const noSource = adapter.compatibility(
    candidate({ repositoryUrl: undefined, packageName: undefined }),
  );
  assert.ok(noSource < 1);
  // Missing or mutable pinned refs cap compatibility below auto-install.
  for (const pinnedRef of ["", "main", "latest"]) {
    assert.ok(
      adapter.compatibility(candidate({ pinnedRef })) < 0.5,
      `expected cap for pinnedRef ${JSON.stringify(pinnedRef)}`,
    );
  }
});

test("installPlan is verified only for verified trust plus supported type", () => {
  const adapter = adapterFor("empty");
  const verified = adapter.installPlan(candidate(), "verified");
  assert.equal(verified.harness, "claude-code");
  assert.equal(verified.approvalTokenRequired, true);
  const manual = adapter.installPlan(candidate(), "unverified");
  assert.ok(manual.operations.every((op) => op.kind === "recipe"));
  const unsupported = adapter.installPlan(
    candidate({ artifactType: "tool" }),
    "verified",
  );
  assert.ok(unsupported.operations.every((op) => op.kind === "recipe"));
});

test("applyPlan refuses recipe-only plans with zero mutation", async () => {
  const adapter = adapterFor("empty");
  const plan = adapter.installPlan(candidate(), "unverified");
  await assert.rejects(() => adapter.applyPlan(plan), /recipe-only/);
});

test("rollback restores nothing when nothing was written", async () => {
  const adapter = adapterFor("empty");
  const plan = adapter.installPlan(candidate(), "unverified");
  const result = await adapter.rollback(plan);
  assert.deepEqual(result.restored, []);
});

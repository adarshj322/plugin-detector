import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@plugin-detector/core";
import { CodexAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/codex", import.meta.url),
);
const home = (name: string): string => path.join(FIXTURES, name, "home");
const project = (name: string): string => path.join(FIXTURES, name, "project");
const adapterFor = (name: string): CodexAdapter =>
  new CodexAdapter({ root: project(name), home: home(name) });

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
  assert.equal(inventory.harness, "codex");
  assert.equal(inventory.status, "ok");
  assert.deepEqual(inventory.records, []);
  assert.deepEqual(inventory.warnings, []);
});

test("full fixture inventories plugins, mcp, and skills without secrets", async () => {
  const inventory = await adapterFor("full").inventory();
  assert.equal(inventory.status, "ok");

  const plugins = inventory.records.filter((entry) => entry.kind === "plugin");
  assert.equal(plugins.length, 3);
  assert.ok(plugins.some((entry) => entry.name === "reviewer@1.4.0"));
  assert.ok(plugins.some((entry) => entry.name === "table-plugin"));
  assert.ok(plugins.every((entry) => entry.contextCostClass === "per-session"));
  assert.ok(plugins.every((entry) => entry.enabled));

  const servers = inventory.records.filter((entry) => entry.kind === "mcp");
  assert.equal(servers.length, 4);
  assert.ok(servers.every((entry) => entry.contextCostClass === "per-query"));
  const reviewer = servers.find((entry) => entry.name === "reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer?.enabled, true);
  assert.ok(reviewer?.id.includes(":global:"));
  const disabled = servers.find((entry) => entry.name === "disabled-docs");
  assert.equal(disabled?.enabled, false);
  const projectDb = servers.find((entry) => entry.name === "project-db");
  assert.ok(projectDb?.id.includes(":project:"));
  const dotted = servers.find((entry) => entry.name === "extra");
  assert.equal(dotted?.enabled, false);

  const skills = inventory.records.filter((entry) => entry.kind === "skill");
  assert.equal(skills.length, 4);
  assert.ok(skills.every((entry) => entry.contextCostClass === "per-use"));
  const good = skills.find(
    (entry) => entry.name === "global-skill" || entry.id.endsWith(":global-skill"),
  );
  assert.ok(good);
  assert.deepEqual(good?.capabilities, ["testing.e2e"]);

  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("sk-codex-secret-value-that-must-never-appear"));
  assert.ok(!serialized.includes("db-secret-value-that-must-never-appear"));
  assert.ok(!serialized.includes("codex-auth-secret-that-must-never-appear"));
});

test("duplicate skill across roots keeps both records with scope ids", async () => {
  const inventory = await adapterFor("full").inventory();
  const dupes = inventory.records.filter(
    (entry) => entry.kind === "skill" && entry.name === "shared-skill",
  );
  assert.equal(dupes.length, 2);
  const scopes = new Set(
    dupes.map((entry) => entry.id.split(":")[2]),
  );
  assert.deepEqual(scopes, new Set(["global", "project"]));
});

test("unknown sections warn but known entries survive", async () => {
  const inventory = await adapterFor("unknown").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(
    inventory.warnings.some((warning) => warning.includes("lab_features")),
  );
  const server = inventory.records.find(
    (entry) => entry.kind === "mcp" && entry.name === "ok-server",
  );
  assert.ok(server);
  assert.equal(server?.enabled, true);
});

test("malformed toml, json, and skill frontmatter never crash", async () => {
  const inventory = await adapterFor("malformed").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(inventory.warnings.length >= 3);
  const bad = inventory.records.find((entry) => entry.name === "bad-skill");
  assert.ok(bad);
});

test("json config inventories plugins and mcp with unknown warnings", async () => {
  const inventory = await adapterFor("json").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(
    inventory.warnings.some((warning) => warning.includes("labFeatures")),
  );
  const plugin = inventory.records.find(
    (entry) => entry.kind === "plugin" && entry.name === "json-plugin@2.1.0",
  );
  assert.ok(plugin);
  const server = inventory.records.find(
    (entry) => entry.kind === "mcp" && entry.name === "json-mcp",
  );
  assert.ok(server);
  assert.equal(server?.enabled, true);
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("json-secret-value-that-must-never-appear"));
});

test("compatibility scores skills and mcp at 1, tools at 0", () => {
  const adapter = adapterFor("empty");
  assert.equal(adapter.compatibility(candidate()), 1);
  assert.equal(
    adapter.compatibility(candidate({ artifactType: "mcp-server" })),
    1,
  );
  assert.equal(
    adapter.compatibility(candidate({ artifactType: "plugin" })),
    1,
  );
  assert.equal(adapter.compatibility(candidate({ artifactType: "tool" })), 0);
  const fractional = adapter.compatibility(
    candidate({ artifactType: "command" }),
  );
  assert.ok(fractional > 0 && fractional < 1);
  const noSource = adapter.compatibility(
    candidate({ repositoryUrl: undefined, packageName: undefined }),
  );
  assert.ok(noSource < 1);
});

test("installPlan is always a manual recipe, even for verified trust", () => {
  const adapter = adapterFor("empty");
  for (const trust of ["verified", "curated", "unverified"] as const) {
    const plan = adapter.installPlan(candidate(), trust);
    assert.equal(plan.harness, "codex");
    assert.equal(plan.approvalTokenRequired, true);
    assert.ok(plan.operations.length > 0);
    assert.ok(plan.operations.every((op) => op.kind === "recipe"));
    assert.ok(
      plan.operations.some((op) => op.summary.includes("unverified")),
      `expected unverified-mutation warning for trust ${trust}`,
    );
  }
  const unsupported = adapter.installPlan(
    candidate({ artifactType: "tool" }),
    "verified",
  );
  assert.ok(unsupported.operations.every((op) => op.kind === "recipe"));
});

test("recipe-only posture: flag is false and applyPlan always throws", async () => {
  const adapter = adapterFor("empty");
  assert.equal(adapter.installVerified, false);
  // No fixture or trust level can express an auto plan: verified candidates
  // still get recipe-only operations.
  const verifiedPlan = adapter.installPlan(candidate(), "verified");
  assert.ok(verifiedPlan.operations.every((op) => op.kind === "recipe"));
  await assert.rejects(() => adapter.applyPlan(verifiedPlan), /unverified/);
  const manualPlan = adapter.installPlan(candidate(), "unverified");
  await assert.rejects(() => adapter.applyPlan(manualPlan), /unverified/);
});

test("rollback restores nothing when nothing was written", async () => {
  const adapter = adapterFor("empty");
  const plan = adapter.installPlan(candidate(), "unverified");
  const result = await adapter.rollback(plan);
  assert.deepEqual(result.restored, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@plugin-detector/core";
import { CursorAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/cursor", import.meta.url),
);
const home = (name: string): string => path.join(FIXTURES, name, "home");
const project = (name: string): string => path.join(FIXTURES, name, "project");
const adapterFor = (name: string): CursorAdapter =>
  new CursorAdapter({ root: project(name), home: home(name) });

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "test-candidate",
    name: "test candidate",
    artifactType: "mcp-server",
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

test("empty harness is not detected and inventories clean", async () => {
  const adapter = adapterFor("empty");
  const detected = await adapter.detect();
  assert.equal(detected.harness, "cursor");
  assert.equal(detected.detected, false);
  const inventory = await adapter.inventory();
  assert.equal(inventory.harness, "cursor");
  assert.equal(inventory.status, "ok");
  assert.deepEqual(inventory.records, []);
  assert.deepEqual(inventory.warnings, []);
});

test("full fixture is detected and inventories mcp, skills, rules, commands without secrets", async () => {
  const adapter = adapterFor("full");
  const detected = await adapter.detect();
  assert.equal(detected.detected, true);
  assert.ok(detected.evidence.some((entry) => entry.endsWith("mcp.json")));

  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "ok");

  const servers = inventory.records.filter((entry) => entry.kind === "mcp");
  assert.equal(servers.length, 3);
  assert.ok(servers.every((entry) => entry.contextCostClass === "per-query"));
  const reviewer = servers.find((entry) => entry.name === "reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer?.enabled, true);
  assert.ok(reviewer?.id.includes(":user:"));
  const disabled = servers.find((entry) => entry.name === "disabled-docs");
  assert.equal(disabled?.enabled, false);
  const projectDb = servers.find((entry) => entry.name === "project-db");
  assert.ok(projectDb?.id.includes(":project:"));

  const skills = inventory.records.filter((entry) => entry.kind === "skill");
  assert.equal(skills.length, 2);
  assert.ok(skills.every((entry) => entry.contextCostClass === "per-use"));
  const good = skills.find((entry) => entry.id.endsWith(":global-skill"));
  assert.ok(good);
  assert.deepEqual(good?.capabilities, ["testing.e2e"]);

  const rules = inventory.records.filter((entry) => entry.kind === "rule");
  assert.equal(rules.length, 2);
  assert.ok(rules.some((entry) => entry.name === "code-review"));
  assert.ok(rules.some((entry) => entry.name === ".cursorrules"));

  const commands = inventory.records.filter(
    (entry) => entry.kind === "command",
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "fix");

  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("sk-cursor-secret-value-that-must-never-appear"));
  assert.ok(!serialized.includes("db-secret-value-that-must-never-appear"));
});

test("unknown sections warn but known entries survive", async () => {
  const inventory = await adapterFor("unknown").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(
    inventory.warnings.some((warning) => warning.includes("labFeatures")),
  );
  const server = inventory.records.find(
    (entry) => entry.kind === "mcp" && entry.name === "ok-server",
  );
  assert.ok(server);
  assert.equal(server?.enabled, true);
});

test("malformed json and skill frontmatter never crash", async () => {
  const inventory = await adapterFor("malformed").inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(inventory.warnings.length >= 3);
  const bad = inventory.records.find((entry) => entry.name === "bad-skill");
  assert.ok(bad);
});

test("claimed compatibility without config evidence stays empty", async () => {
  const adapter = adapterFor("claims");
  const detected = await adapter.detect();
  assert.equal(detected.detected, false);
  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "ok");
  assert.deepEqual(inventory.records, []);
});

test("compatibility is documented for mcp, inferred for skills, unknown for tools", () => {
  const adapter = adapterFor("empty");
  assert.equal(adapter.compatibilityBasis(candidate()), "documented");
  assert.equal(adapter.compatibility(candidate()), 1);
  assert.equal(
    adapter.compatibilityBasis(candidate({ artifactType: "skill" })),
    "inferred",
  );
  assert.equal(adapter.compatibility(candidate({ artifactType: "skill" })), 0.5);
  assert.equal(
    adapter.compatibilityBasis(candidate({ artifactType: "tool" })),
    "unknown",
  );
  assert.equal(adapter.compatibility(candidate({ artifactType: "tool" })), 0);
  const noSource = adapter.compatibility(
    candidate({ repositoryUrl: undefined, packageName: undefined }),
  );
  assert.ok(noSource < 1);
});

test("installPlan is always a manual recipe with the Cursor experimental label", () => {
  const adapter = adapterFor("empty");
  for (const trust of ["verified", "curated", "unverified"] as const) {
    const plan = adapter.installPlan(candidate(), trust);
    assert.equal(plan.harness, "cursor");
    assert.equal(plan.approvalTokenRequired, true);
    assert.ok(plan.operations.length > 0);
    assert.ok(plan.operations.every((op) => op.kind === "recipe"));
    assert.ok(
      plan.operations.some((op) => op.summary.includes("unverified")),
      `expected unverified-mutation warning for trust ${trust}`,
    );
    assert.ok(
      plan.operations.some((op) => op.summary.includes("experimental")),
      `expected Cursor experimental label for trust ${trust}`,
    );
  }
  const inferred = adapter.installPlan(
    candidate({ artifactType: "skill" }),
    "verified",
  );
  assert.ok(inferred.operations.every((op) => op.kind === "recipe"));
  assert.ok(
    inferred.operations.some((op) => op.summary.includes("inferred")),
  );
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

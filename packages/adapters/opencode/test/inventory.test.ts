import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candidate } from "@plugin-detector/core";
import { OpenCodeAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/opencode", import.meta.url),
);
const fixture = (name: string): string => path.join(FIXTURES, name);

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
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const inventory = await adapter.inventory();
  assert.equal(inventory.harness, "opencode");
  assert.equal(inventory.status, "ok");
  assert.deepEqual(inventory.records, []);
  assert.deepEqual(inventory.warnings, []);
});

test("npm plugin entry normalizes to a capability record", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("npm-plugin") });
  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "ok");
  assert.equal(inventory.records.length, 1);
  const [record] = inventory.records;
  assert.equal(record?.harness, "opencode");
  assert.equal(record?.kind, "plugin");
  assert.equal(record?.enabled, true);
  assert.equal(record?.contextCostClass, "per-session");
  assert.ok(record?.configRefs.some((ref) => ref.endsWith("opencode.json")));
});

test("local plugin file normalizes without executing it", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("local-plugin") });
  const inventory = await adapter.inventory();
  const record = inventory.records.find((entry) => entry.kind === "plugin");
  assert.ok(record);
  assert.equal(record?.name, "local-plugin");
  assert.equal(record?.enabled, true);
  assert.ok(
    record?.configRefs.some((ref) =>
      ref.endsWith(".opencode/plugins/local-plugin.ts"),
    ),
  );
});

test("malformed skill frontmatter warns but keeps records", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("skills-malformed") });
  const inventory = await adapter.inventory();
  assert.ok(inventory.records.length >= 2);
  assert.ok(inventory.warnings.length > 0);
  const good = inventory.records.find((entry) => entry.name === "good-skill");
  assert.ok(good);
  assert.deepEqual(good?.capabilities, ["code-review.quality"]);
  assert.equal(good?.contextCostClass, "per-use");
});

test("mcp servers inventory per-query without secret values", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("mcp") });
  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "ok");
  const reviewer = inventory.records.find(
    (entry) => entry.kind === "mcp" && entry.name === "reviewer",
  );
  assert.ok(reviewer);
  assert.equal(reviewer?.enabled, true);
  assert.equal(reviewer?.contextCostClass, "per-query");
  const disabled = inventory.records.find((entry) => entry.name === "disabled-docs");
  assert.equal(disabled?.enabled, false);
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("sk-ant-secret-value-that-must-never-appear"));
});

test("invalid opencode config does not crash inventory", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("invalid-config") });
  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(inventory.warnings.length > 0);
});

test("compatibility scores skills and mcp at 1, tools at 0", () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  assert.equal(adapter.compatibility(candidate()), 1);
  assert.equal(
    adapter.compatibility(candidate({ artifactType: "mcp-server" })),
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

test("installPlan is verified only for verified trust plus supported type", () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const verified = adapter.installPlan(candidate(), "verified");
  assert.equal(verified.approvalTokenRequired, true);
  assert.ok(
    verified.operations.some(
      (op) => op.kind === "run" && op.summary.includes("skills add"),
    ),
  );
  const manual = adapter.installPlan(candidate(), "unverified");
  assert.ok(manual.operations.every((op) => op.kind === "recipe"));
  const unsupported = adapter.installPlan(
    candidate({ artifactType: "tool" }),
    "verified",
  );
  assert.ok(unsupported.operations.every((op) => op.kind === "recipe"));
});

test("applyPlan throws until task 13", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const plan = adapter.installPlan(candidate(), "unverified");
  await assert.rejects(() => adapter.applyPlan(plan), /Inventory-only milestone/);
});

test("rollback restores nothing when nothing was written", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const plan = adapter.installPlan(candidate(), "unverified");
  const result = await adapter.rollback(plan);
  assert.deepEqual(result.restored, []);
});

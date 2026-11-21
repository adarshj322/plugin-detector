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

test("config-only plugin keeps its declared spec and no installed version", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("npm-plugin") });
  const inventory = await adapter.inventory();
  const [record] = inventory.records;
  assert.ok(record);
  assert.equal(record?.sourceRef, "my-opencode-plugin@1.2.3");
  assert.equal(record?.version, undefined);
  assert.equal(record?.installPath, undefined);
  assert.equal(record?.lastUpdated, undefined);
  assert.equal(record?.modified, "unknown");
  assert.equal(record?.updateStatus, "unknown");
});

test("disk plugin lifecycle records package version and local mtime", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("known-plugins") });
  const inventory = await adapter.inventory();
  const manifest = inventory.records.find(
    (r) => r.name === "manifest-from-package",
  );
  assert.ok(manifest);
  assert.equal(manifest?.version, "1.0.0");
  assert.ok(manifest?.installPath?.endsWith("plugins/manifest-dir"));
  assert.equal(manifest?.sourceRef, manifest?.installPath);
  assert.equal(manifest?.lastUpdatedSource, "local");
  const lastUpdated = manifest?.lastUpdated;
  assert.ok(lastUpdated);
  assert.equal(Number.isNaN(Date.parse(lastUpdated)), false);
  assert.equal(manifest?.modified, "unknown");
  assert.equal(manifest?.updateStatus, "unknown");
});

test("known config plugins receive capability hints", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("known-plugins") });
  const inventory = await adapter.inventory();
  const superpowers = inventory.records.find((r) => r.name.includes("superpowers"));
  assert.ok(superpowers);
  assert.ok(superpowers?.capabilities.includes("planning.brainstorm"));
  assert.ok(superpowers?.capabilities.includes("testing.runner"));
  const ponytail = inventory.records.find((r) => r.name.includes("ponytail"));
  assert.deepEqual(ponytail?.capabilities, ["code-review.quality"]);
  const hindsight = inventory.records.find((r) => r.name.includes("coding-agents"));
  assert.deepEqual(hindsight?.capabilities, ["memory.context"]);
});

test("global auto-discovered plugins are inventoried without duplicates", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("known-plugins") });
  const inventory = await adapter.inventory();
  const ocr = inventory.records.find((r) => r.name === "open-code-review");
  assert.ok(ocr);
  assert.equal(ocr?.kind, "plugin");
  assert.equal(ocr?.id, "opencode:plugin:global:open-code-review");
  assert.deepEqual(ocr?.capabilities, ["code-review.quality", "code-review.security"]);
  assert.equal(
    ocr?.configRefs[0]?.endsWith(".config/opencode/plugins/open-code-review.ts"),
    true,
  );
  const rtk = inventory.records.find((r) => r.name === "rtk");
  assert.deepEqual(rtk?.capabilities, ["harness.management"]);
  const adhd = inventory.records.find((r) => r.name === "i-have-adhd");
  assert.deepEqual(adhd?.capabilities, ["planning.orchestration"]);
  const manifest = inventory.records.find(
    (r) => r.name === "manifest-from-package",
  );
  assert.equal(manifest?.id, "opencode:plugin:global:manifest-from-package");
  assert.equal(
    manifest?.configRefs[0]?.endsWith("plugins/manifest-dir"),
    true,
  );
  const indexOnly = inventory.records.find((r) => r.name === "index-only");
  assert.equal(indexOnly?.id, "opencode:plugin:global:index-only");
  assert.equal(
    inventory.records.some((r) => r.name === "stray-folder"),
    false,
  );
  const superpowers = inventory.records.filter((r) =>
    r.name.includes("superpowers"),
  );
  assert.equal(superpowers.length, 1);
  assert.equal(
    new Set(inventory.records.map((r) => r.id)).size,
    inventory.records.length,
  );
});

test("config and disk plugin records merge the install path", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("known-plugins") });
  const inventory = await adapter.inventory();
  const records = inventory.records.filter((r) =>
    r.name.includes("superpowers"),
  );
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(record?.name.startsWith("superpowers@git+"));
  assert.equal(
    record?.configRefs[0]?.endsWith(".config/opencode/plugins/superpowers.ts"),
    true,
  );
  assert.ok(
    record?.configRefs.some((ref) => ref.endsWith("opencode.json")),
  );
  assert.ok(record?.sourceRef?.startsWith("superpowers@git+"));
  assert.ok(record?.installPath?.endsWith("plugins/superpowers.ts"));
  assert.equal(record?.version, undefined);
  assert.equal(record?.lastUpdatedSource, "local");
  assert.equal(record?.modified, "unknown");
  assert.equal(record?.updateStatus, "unknown");
});

test("unknown plugins fall back to name inference", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("known-plugins") });
  const inventory = await adapter.inventory();
  const postgres = inventory.records.find((r) => r.name === "postgres-helper");
  assert.deepEqual(postgres?.capabilities, ["data.database"]);
  const misc = inventory.records.find((r) => r.name === "misc-helper");
  assert.deepEqual(misc?.capabilities, []);
});

test("project plugin shadows the same global plugin", async () => {
  const base = fixture("plugin-precedence");
  const adapter = new OpenCodeAdapter({ root: base, home: base });
  const inventory = await adapter.inventory();
  const records = inventory.records.filter((r) => r.name === "foo");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "opencode:plugin:project:foo");
  assert.equal(
    records[0]?.configRefs[0]?.endsWith(".opencode/plugins/foo.ts"),
    true,
  );
  assert.equal(
    records[0]?.configRefs.some((ref) =>
      ref.includes(".config/opencode/plugins"),
    ),
    false,
  );
});

test("plugin-only harness is detected from the global plugin root", async () => {
  const base = fixture("plugin-only");
  const adapter = new OpenCodeAdapter({ root: base, home: base });
  const result = await adapter.detect();
  assert.equal(result.detected, true);
  assert.ok(
    result.evidence.some((entry) =>
      entry.endsWith(".config/opencode/plugins"),
    ),
  );
});

test("local plugin file normalizes without executing it", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("local-plugin") });
  const inventory = await adapter.inventory();
  const record = inventory.records.find((entry) => entry.kind === "plugin");
  assert.ok(record);
  assert.equal(record?.name, "local-plugin");
  assert.equal(record?.id, "opencode:plugin:project:local-plugin");
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

test("installed skill lifecycle uses optional version and local mtime", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("skills-malformed") });
  const inventory = await adapter.inventory();
  const good = inventory.records.find((entry) => entry.name === "good-skill");
  assert.ok(good);
  assert.equal(good?.version, "4.2.0");
  assert.ok(good?.installPath?.endsWith(".opencode/skills/good-skill"));
  assert.equal(good?.sourceRef, good?.installPath);
  assert.equal(good?.lastUpdatedSource, "local");
  const lastUpdated = good?.lastUpdated;
  assert.ok(lastUpdated);
  assert.equal(Number.isNaN(Date.parse(lastUpdated)), false);
  assert.equal(good?.modified, "unknown");
  assert.equal(good?.updateStatus, "unknown");
});

test("installed skill descriptions infer capabilities and project wins", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("inferred-capability") });
  const inventory = await adapter.inventory();
  const skills = inventory.records.filter(
    (entry) => entry.name === "e2e-browser",
  );
  assert.equal(skills.length, 1);
  const [skill] = skills;
  assert.ok(skill?.capabilities.includes("testing.e2e"));
  assert.equal(skill?.version, undefined);
  assert.equal(skill?.id, "opencode:skill:project:e2e-browser");
  assert.equal(
    skill?.configRefs[0]?.endsWith(".opencode/skills/e2e-browser/SKILL.md"),
    true,
  );
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
  const npxServer = inventory.records.find(
    (entry) => entry.kind === "mcp" && entry.name === "npx-server",
  );
  assert.equal(npxServer?.sourceRef, "@acme/opencode-mcp");
  assert.equal(reviewer?.sourceRef, undefined, "node command is not a package");
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

test("applyPlan refuses recipe-only plans with zero mutation", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const plan = adapter.installPlan(candidate(), "unverified");
  await assert.rejects(() => adapter.applyPlan(plan), /recipe-only/);
});

test("rollback restores nothing when nothing was written", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const plan = adapter.installPlan(candidate(), "unverified");
  const result = await adapter.rollback(plan);
  assert.deepEqual(result.restored, []);
});

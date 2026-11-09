import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactEvidenceSchema,
  normalizeCandidate,
  probeArtifact,
  type RawCandidate,
  type SourceQueryPlan,
} from "../src/index.js";

function makeRaw(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    id: "acme-skill",
    name: "Acme Skill",
    artifact: {
      kind: "skill",
      file: "SKILL.md",
      capabilities: ["testing.runner"],
      domains: ["software-development"],
    },
    sourceKind: "community",
    pinnedRef: "1.2.0",
    license: "MIT",
    repositoryUrl: "https://github.com/acme/skill",
    ...overrides,
  };
}

function validEvidence(): Record<string, unknown> {
  return {
    kind: "skill",
    sourceUrl: "https://raw.githubusercontent.com/acme/skill/v1.2.0/SKILL.md",
    resolvedRef: "v1.2.0",
    contentHash: "a".repeat(64),
    license: "MIT",
    retrievedAt: "2026-11-09T00:00:00.000Z",
  };
}

test("a listing alone cannot produce artifact evidence", () => {
  const raw = makeRaw({ artifactProbed: false });
  assert.equal(raw.artifactProbe, undefined);
});

test("artifact evidence requires content hash and resolved ref", () => {
  assert.throws(() => ArtifactEvidenceSchema.parse({ kind: "skill" }));
});

test("valid evidence fills bounded list defaults", () => {
  const parsed = ArtifactEvidenceSchema.parse(validEvidence());
  assert.equal(parsed.kind, "skill");
  assert.deepEqual(parsed.capabilities, []);
  assert.deepEqual(parsed.evidenceSnippets, []);
  const filled = ArtifactEvidenceSchema.parse({
    ...validEvidence(),
    name: "Acme Skill",
    version: "1.2.0",
    capabilities: ["testing.runner"],
    evidenceSnippets: ["name: Acme Skill"],
  });
  assert.equal(filled.name, "Acme Skill");
  assert.deepEqual(filled.capabilities, ["testing.runner"]);
  assert.deepEqual(filled.evidenceSnippets, ["name: Acme Skill"]);
});

test("every required evidence field is enforced", () => {
  const required = [
    "kind",
    "sourceUrl",
    "resolvedRef",
    "contentHash",
    "license",
    "retrievedAt",
  ];
  for (const field of required) {
    const payload = validEvidence();
    delete payload[field];
    assert.throws(() => ArtifactEvidenceSchema.parse(payload), `${field} is required`);
  }
});

test("evidence kind uses the exact ArtifactType values", () => {
  for (const kind of [
    "skill",
    "plugin",
    "mcp-server",
    "hook",
    "command",
    "tool",
  ]) {
    assert.equal(
      ArtifactEvidenceSchema.parse({ ...validEvidence(), kind }).kind,
      kind,
    );
  }
  for (const kind of ["mcp", "package", "agent"]) {
    assert.throws(() => ArtifactEvidenceSchema.parse({ ...validEvidence(), kind }));
  }
});

test("evidence timestamp and source URL must be real", () => {
  assert.throws(() =>
    ArtifactEvidenceSchema.parse({
      ...validEvidence(),
      retrievedAt: "not-a-date",
    }),
  );
  assert.throws(() =>
    ArtifactEvidenceSchema.parse({
      ...validEvidence(),
      sourceUrl: "not a url",
    }),
  );
});

test("evidence presence makes a record probed even when a listing flag says otherwise", () => {
  const artifactProbe = ArtifactEvidenceSchema.parse(validEvidence());
  const raw = makeRaw({ artifactProbed: false, artifactProbe });
  assert.equal(probeArtifact(raw).probed, true);
  assert.equal(normalizeCandidate(raw).artifactProbed, true);
});

test("source query plans carry search terms only", () => {
  const plan: SourceQueryPlan = {
    source: "github",
    queries: ["mcp", "agent-skill"],
  };
  assert.equal(plan.source, "github");
  assert.deepEqual(plan.queries, ["mcp", "agent-skill"]);
});

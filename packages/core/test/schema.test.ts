import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactType,
  CANONICAL_CAPABILITY_IDS,
  CandidateSchema,
  CapabilityRecordSchema,
  HarnessId,
  InstallPlanSchema,
  RecommendationSchema,
  Verdict,
  capabilityId,
} from "../src/index.js";

test("candidate requires pinned immutable ref and license", () => {
  assert.throws(() =>
    CandidateSchema.parse({
      id: "x",
      name: "x",
      artifactType: "skill",
      sources: [],
      pinnedRef: "main",
      license: null,
    }),
  );
});

test("verdict is closed enum", () => {
  assert.equal(Verdict.enum.required, "required");
  // NOTE: brief draft read `Verdict.enum.banana`; plain property access never
  // throws, so the closed-enum assertion is expressed as a failed parse.
  assert.throws(() => Verdict.parse("banana"));
});

test("valid candidate parses", () => {
  const candidate = CandidateSchema.parse({
    id: "superpowers-testing",
    name: "superpowers testing",
    artifactType: "skill",
    sources: ["https://example.com/repo"],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.2.3",
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
  });
  assert.equal(candidate.artifactType, "skill");
});

test("candidate rejects mutable branch ref", () => {
  assert.throws(() =>
    CandidateSchema.parse({
      id: "x",
      name: "x",
      artifactType: "plugin",
      sources: ["https://example.com/repo"],
      useCaseDomains: ["software-development"],
      capabilities: ["testing.runner"],
      license: "MIT",
      pinnedRef: "main",
      installMode: "verified",
      lastVerified: "2026-11-01T00:00:00.000Z",
      provenance: "official",
      risk: "low",
      maintenance: "active",
      auditStatus: "clean",
      popularity: {},
    }),
  );
});

test("harness and artifact enums are closed", () => {
  assert.equal(HarnessId.parse("opencode"), "opencode");
  assert.throws(() => HarnessId.parse("not-a-harness"));
  assert.equal(ArtifactType.parse("skill"), "skill");
  assert.throws(() => ArtifactType.parse("exe"));
});

test("capability record requires harness and context cost class", () => {
  assert.throws(() =>
    CapabilityRecordSchema.parse({
      id: "x",
      name: "x",
      harness: "opencode",
      kind: "skill",
      capabilities: ["testing.runner"],
      enabled: true,
      configRefs: [],
    }),
  );
});

test("install plan requires approval token", () => {
  assert.throws(() =>
    InstallPlanSchema.parse({
      candidateId: "x",
      harness: "opencode",
      operations: [],
      backupRefs: [],
      rollbackOperations: [],
      approvalTokenRequired: false,
    }),
  );
});

test("recommendation carries verdict and overlap", () => {
  const candidate = CandidateSchema.parse({
    id: "c1",
    name: "c1",
    artifactType: "skill",
    sources: ["https://example.com/repo"],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: {},
  });
  const rec = RecommendationSchema.parse({
    candidate,
    harness: "opencode",
    verdict: "required",
    confidence: "high",
    score: 90,
    overlap: 1,
    reasoning: "fills missing capability",
    evidencePointers: ["https://example.com/repo"],
  });
  assert.equal(rec.verdict, "required");
  assert.ok(CANONICAL_CAPABILITY_IDS.includes("design.thumbnail"));
  assert.equal(capabilityId("Design___Thumbnail!!"), "design.thumbnail");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REQUIRED_THRESHOLD,
  decideVerdict,
  scoreCandidate,
  type Recommendation,
} from "../src/index.js";
import type { Candidate } from "../src/index.js";

function strongCandidate(id: string): Candidate {
  return {
    id,
    name: id,
    artifactType: "skill",
    sources: ["https://example.com/repo"],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: "https://example.com/repo",
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
  };
}

function scored(id: string, overrides: Partial<Candidate> = {}): Recommendation {
  return scoreCandidate({
    candidate: { ...strongCandidate(id), ...overrides },
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
}

function weak(): Recommendation {
  return scoreCandidate({
    candidate: {
      ...strongCandidate("weak"),
      provenance: "community",
      risk: "medium",
      maintenance: "stale",
      auditStatus: "unknown",
      installMode: "manual",
      popularity: {},
    },
    installedCapabilities: [],
    profileDomains: ["design.frontend"],
    harness: "opencode",
    useCaseMatch: 0,
    projectSignalMatch: 0,
  });
}

test("default threshold is 55", () => {
  assert.equal(DEFAULT_REQUIRED_THRESHOLD, 55);
});

test("strong top candidate keeps its required verdict", () => {
  assert.equal(decideVerdict({ recommendations: [scored("a")] }), "required");
});

test("empty set is no-good-candidates, never fabricated", () => {
  assert.equal(decideVerdict({ recommendations: [] }), "no-good-candidates");
});

test("top score below threshold is no-good-candidates", () => {
  const top = weak();
  assert.ok(top.score < DEFAULT_REQUIRED_THRESHOLD);
  assert.equal(decideVerdict({ recommendations: [top] }), "no-good-candidates");
});

test("low confidence top candidate is no-good-candidates", () => {
  const top = { ...scored("a"), confidence: "low" as const };
  assert.ok(top.score >= DEFAULT_REQUIRED_THRESHOLD);
  assert.equal(decideVerdict({ recommendations: [top] }), "no-good-candidates");
});

test("no candidate clearing hard gates is no-good-candidates", () => {
  const risky = scored("a", { auditStatus: "critical" });
  assert.equal(risky.verdict, "risky");
  assert.equal(
    decideVerdict({ recommendations: [risky] }),
    "no-good-candidates",
  );
});

test("picks the top score deterministically and honors overrides", () => {
  const good = scored("good");
  const weakRec = weak();
  assert.equal(
    decideVerdict({ recommendations: [weakRec, good] }),
    "required",
  );
  assert.equal(
    decideVerdict({ recommendations: [good], requiredThreshold: good.score + 1 }),
    "no-good-candidates",
  );
});

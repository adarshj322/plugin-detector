import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreCandidate,
  type Candidate,
  type CapabilityRecord,
} from "@plugin-detector/core";

// Provenance and maintenance hard gates in core scoring: risky verdicts that
// no popularity, fit, or confidence signal may override. Registry intake
// (probe) refuses archived/stale raws before they reach scoring; these tests
// pin the scoring layer as defense in depth for directly built candidates.

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "prov-candidate",
    name: "Provenance Candidate",
    artifactType: "skill",
    sources: ["https://example.com/prov"],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: "https://example.com/prov",
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

function score(overrides: Partial<Candidate> = {}) {
  return scoreCandidate({
    candidate: candidate(overrides),
    installedCapabilities: [] as CapabilityRecord[],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
}

test("archived maintenance is risky for every provenance, popularity aside", () => {
  for (const provenance of ["official", "publisher", "community", "unknown"] as const) {
    const result = score({
      provenance,
      maintenance: "archived",
      popularity: { stars: 120000, installs: 2000000, velocity30d: 500 },
    });
    assert.equal(result.verdict, "risky", `provenance=${provenance}`);
    assert.match(result.reasoning, /archived maintenance/);
  }
});

test("unknown provenance with high or critical risk is risky", () => {
  for (const risk of ["high", "critical"] as const) {
    const result = score({ provenance: "unknown", risk });
    assert.equal(result.verdict, "risky", `risk=${risk}`);
    assert.match(result.reasoning, /unknown provenance/);
  }
});

test("critical audit is risky even for an official active candidate", () => {
  const result = score({ auditStatus: "critical" });
  assert.equal(result.verdict, "risky");
  assert.match(result.reasoning, /critical audit/);
});

test("missing license is risky", () => {
  const result = scoreCandidate({
    candidate: { ...candidate(), license: "" },
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("official clean active candidate with a matching gap stays required", () => {
  const result = score({});
  assert.equal(result.verdict, "required");
  assert.equal(result.confidence, "high");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreCandidate,
  type Candidate,
  type CapabilityRecord,
} from "../src/index.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const { popularity, ...rest } = overrides;
  return {
    id: "test-candidate",
    name: "Test Candidate",
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
    popularity: { stars: 100, ...popularity },
    ...rest,
  };
}

function installed(
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    id: "installed-1",
    name: "Installed",
    harness: "opencode",
    kind: "skill",
    capabilities: ["testing.runner"],
    enabled: true,
    configRefs: [],
    usageCount90d: 5,
    contextCostClass: "per-use",
    ...overrides,
  };
}

test("popular candidate that duplicates installed capability is redundant", () => {
  const result = scoreCandidate({
    candidate: candidate({
      capabilities: ["code-review.quality"],
      popularity: { stars: 50000 },
    }),
    installedCapabilities: [
      installed({ capabilities: ["code-review.quality"], usageCount90d: 12 }),
    ],
    profileDomains: ["code-review.quality"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "redundant");
  assert.ok(result.overlap < 1);
});

test("critical audit candidate can never be required", () => {
  const result = scoreCandidate({
    candidate: candidate({
      capabilities: ["testing.runner"],
      auditStatus: "critical",
    }),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("strong novel candidate is required with a full score", () => {
  const result = scoreCandidate({
    candidate: candidate(),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "required");
  assert.equal(result.score, 100);
  assert.equal(result.overlap, 1);
  assert.equal(result.confidence, "high");
});

test("weak candidate is useful-optional, never required", () => {
  const result = scoreCandidate({
    candidate: candidate({
      provenance: "community",
      risk: "medium",
      maintenance: "stale",
      auditStatus: "unknown",
      installMode: "manual",
      popularity: { stars: 0 },
    }),
    installedCapabilities: [],
    profileDomains: ["design.frontend"],
    harness: "opencode",
    useCaseMatch: 0,
    projectSignalMatch: 0,
  });
  assert.equal(result.verdict, "useful-optional");
  assert.ok(result.score < 55);
});

test("unknown provenance with high risk is risky", () => {
  const result = scoreCandidate({
    candidate: candidate({ provenance: "unknown", risk: "high" }),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("archived maintenance is risky", () => {
  const result = scoreCandidate({
    candidate: candidate({ maintenance: "archived" }),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("missing license is risky", () => {
  const result = scoreCandidate({
    candidate: candidate({ license: "" }),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("risky wins over redundant for a duplicated critical-audit capability", () => {
  const result = scoreCandidate({
    candidate: candidate({
      capabilities: ["code-review.quality"],
      auditStatus: "critical",
    }),
    installedCapabilities: [
      installed({ capabilities: ["code-review.quality"] }),
    ],
    profileDomains: ["code-review.quality"],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.equal(result.verdict, "risky");
});

test("disabled installed item overlaps less than an enabled one", () => {
  const base = {
    candidate: candidate({ capabilities: ["code-review.quality"] }),
    profileDomains: ["code-review.quality"],
    harness: "opencode" as const,
    useCaseMatch: 1,
    projectSignalMatch: 1,
  };
  const enabled = scoreCandidate({
    ...base,
    installedCapabilities: [installed({ capabilities: ["code-review.quality"] })],
  });
  const disabled = scoreCandidate({
    ...base,
    installedCapabilities: [
      installed({ capabilities: ["code-review.quality"], enabled: false }),
    ],
  });
  assert.ok(enabled.overlap < disabled.overlap);
  assert.equal(disabled.verdict, "required");
});

test("scoring is deterministic", () => {
  const input = {
    candidate: candidate({ capabilities: ["code-review.quality"] }),
    installedCapabilities: [installed({ capabilities: ["vcs.workflow"] })],
    profileDomains: ["code-review.quality"],
    harness: "opencode" as const,
    useCaseMatch: 0.7,
    projectSignalMatch: 0.3,
  };
  const first = scoreCandidate(input);
  const second = scoreCandidate(input);
  assert.deepEqual(first, second);
  assert.ok(first.score >= 0 && first.score <= 100);
  assert.ok(first.reasoning.length > 0);
  assert.deepEqual(first.evidencePointers, [
    "https://example.com/repo",
  ]);
});

test("adapter compatibility multiplies the score and zero is a hard gate", () => {
  const base = {
    candidate: candidate(),
    installedCapabilities: [],
    profileDomains: ["testing.runner"],
    harness: "opencode" as const,
    useCaseMatch: 1,
    projectSignalMatch: 1,
  };
  const compatible = scoreCandidate({ ...base, compatibility: 1 });
  const partial = scoreCandidate({ ...base, compatibility: 0.5 });
  const incompatible = scoreCandidate({ ...base, compatibility: 0 });
  assert.ok(partial.score < compatible.score, "compatibility must multiply fit");
  assert.equal(incompatible.score, 0);
  assert.equal(incompatible.verdict, "risky");
  assert.match(incompatible.reasoning, /incompatible harness/);
});

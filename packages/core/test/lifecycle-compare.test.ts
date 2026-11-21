import test from "node:test";
import assert from "node:assert/strict";
import {
  compareLifecycle,
  type Candidate,
  type CapabilityRecord,
} from "../src/index.js";

function installed(
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    id: "reviewer",
    name: "reviewer",
    harness: "opencode",
    kind: "skill",
    capabilities: ["code-review.basic"],
    enabled: true,
    configRefs: [],
    contextCostClass: "per-use",
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  const { popularity, ...rest } = overrides;
  return {
    id: "reviewer",
    name: "reviewer",
    artifactType: "skill",
    sources: ["https://example.com/repo"],
    useCaseDomains: ["software-development"],
    capabilities: ["code-review.basic"],
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

function compare(
  current: CapabilityRecord,
  next: Candidate,
  inventory: CapabilityRecord[] = [current],
  overrides: { profileDomains?: string[]; threshold?: number } = {},
) {
  return compareLifecycle({
    installed: current,
    candidate: next,
    installedInventory: inventory,
    profileDomains: overrides.profileDomains ?? [
      "code-review.basic",
      "code-review.security",
    ],
    threshold: overrides.threshold ?? 55,
  });
}

test("current same-version installed tool is kept", () => {
  const row = compare(
    installed({ version: "1.2.0", latestVersion: "1.2.0" }),
    candidate({ pinnedRef: "v1.2.0" }),
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.length > 0);
  assert.deepEqual(row.capabilitiesAdded, []);
});

test("older installed tool with a newer same-tool candidate is upgraded", () => {
  const row = compare(
    installed({ version: "1.2.0" }),
    candidate({
      artifactEvidence: {
        kind: "skill",
        sourceUrl: "https://example.com/repo",
        resolvedRef: "v1.3.0",
        contentHash: "sha256:abc",
        license: "MIT",
        version: "1.3.0",
        capabilities: [],
        evidenceSnippets: [],
        retrievedAt: "2026-11-01T00:00:00.000Z",
      },
    }),
  );
  assert.equal(row.action, "upgrade");
  assert.equal(row.candidateId, "reviewer");
  assert.equal(row.installedVersion, "1.2.0");
  assert.equal(row.latestVersion, "1.3.0");
  assert.deepEqual(row.capabilitiesAdded, []);
});

test("resolver latest version upgrades a same-tool candidate without its own version", () => {
  const row = compare(
    installed({ version: "1.2.0", latestVersion: "1.5.0" }),
    candidate({ pinnedRef: "nightly" }),
  );
  assert.equal(row.action, "upgrade");
  assert.equal(row.candidateId, "reviewer");
  assert.equal(row.latestVersion, "1.5.0");
});

test("derived outdated freshness allows replacement without explicit status", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    version: "1.0.0",
    latestVersion: "2.0.0",
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
      pinnedRef: "v1.0.0",
    }),
    [current],
  );
  assert.equal(row.action, "replace");
  assert.equal(row.candidateId, "deep-review");
});

test("outdated installed tool is replaced by a higher-scoring capability superset", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    version: "1.0.0",
    updateStatus: "outdated",
  });
  const next = candidate({
    id: "deep-review",
    name: "deep-review",
    capabilities: ["code-review.basic", "code-review.security"],
    pinnedRef: "v2.0.0",
  });
  const row = compare(current, next);
  assert.equal(row.action, "replace");
  assert.equal(row.candidateId, "deep-review");
  assert.equal(row.installedVersion, "1.0.0");
  assert.equal(row.latestVersion, "v2.0.0");
  assert.deepEqual(row.capabilitiesAdded, ["code-review.security"]);
  assert.ok(row.reasons.some((reason) => reason.includes("code-review.security")));
});

test("candidate capability already covered by an enabled installed tool is kept", () => {
  const current = installed({ id: "legacy-review", name: "legacy-review" });
  const scanner = installed({
    id: "scanner",
    name: "scanner",
    capabilities: ["code-review.security"],
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
    }),
    [current, scanner],
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.deepEqual(row.capabilitiesAdded, []);
});

test("unknown installed version never upgrades or replaces", () => {
  const row = compare(
    installed({ updateStatus: "unknown" }),
    candidate({ pinnedRef: "v2.0.0" }),
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("unknown")));
});

test("unknown installed version is kept even when a candidate adds a capability", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "unknown",
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
    }),
    [current],
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("unknown")));
});

test("non-semver versions are never compared", () => {
  const row = compare(
    installed({ version: "nightly-2026-11-01" }),
    candidate({ id: "reviewer", pinnedRef: "nightly-2026-11-10" }),
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("cross-kind candidates are never recommended", () => {
  const row = compare(
    installed({ version: "1.0.0", updateStatus: "outdated" }),
    candidate({
      artifactType: "plugin",
      capabilities: ["code-review.basic", "code-review.security"],
      pinnedRef: "v2.0.0",
    }),
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("locally modified installed tool requires review", () => {
  const row = compare(
    installed({ version: "1.0.0", modified: true, updateStatus: "modified" }),
    candidate({ pinnedRef: "v2.0.0" }),
  );
  assert.equal(row.action, "review");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("modified")));
});

test("candidate below the profile threshold is kept", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "outdated",
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
    }),
    [current],
    { threshold: 100 },
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("risky candidate cannot replace an outdated tool", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "outdated",
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
      auditStatus: "critical",
    }),
    [current],
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("current installed tool is kept even when a candidate adds a capability", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "current",
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
    }),
    [current],
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("a capability covered only by a disabled install still counts as added", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "outdated",
  });
  const disabledScanner = installed({
    id: "scanner",
    name: "scanner",
    capabilities: ["code-review.security"],
    enabled: false,
  });
  const row = compare(
    current,
    candidate({
      id: "deep-review",
      name: "deep-review",
      capabilities: ["code-review.basic", "code-review.security"],
    }),
    [current, disabledScanner],
  );
  assert.equal(row.action, "replace");
  assert.deepEqual(row.capabilitiesAdded, ["code-review.security"]);
});

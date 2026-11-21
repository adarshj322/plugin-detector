import test from "node:test";
import assert from "node:assert/strict";
import {
  compareLifecycle,
  dedupeReplacementRows,
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
  overrides: {
    profileDomains?: string[];
    threshold?: number;
    compatibility?: number;
  } = {},
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
    ...(overrides.compatibility === undefined
      ? {}
      : { compatibility: overrides.compatibility }),
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

test("candidate that drops an installed capability cannot replace it", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    capabilities: ["code-review.basic"],
    updateStatus: "outdated",
  });
  const row = compare(
    current,
    candidate({
      id: "deployer",
      name: "deployer",
      capabilities: ["deploy.release"],
    }),
    [current],
    { profileDomains: ["code-review.basic", "deploy.release"] },
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("code-review.basic")));
});

test("a preserved capability can be covered by another enabled install", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    capabilities: ["code-review.basic"],
    updateStatus: "outdated",
  });
  const backup = installed({
    id: "review-backup",
    name: "review-backup",
    capabilities: ["code-review.basic"],
  });
  const row = compare(
    current,
    candidate({
      id: "deployer",
      name: "deployer",
      capabilities: ["deploy.release"],
    }),
    [current, backup],
    { profileDomains: ["code-review.basic", "deploy.release"] },
  );
  assert.equal(row.action, "replace");
  assert.deepEqual(row.capabilitiesAdded, ["deploy.release"]);
});

test("same display name with a different identity is not actionable", () => {
  const current = installed({
    id: "tool-a",
    name: "shared-name",
    updateStatus: "outdated",
  });
  const next = candidate({
    id: "tool-b",
    name: "shared-name",
    capabilities: ["code-review.basic", "code-review.security"],
  });
  const row = compare(current, next);
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("display name")));
});

test("different ids can upgrade when package identity matches", () => {
  const current = installed({
    id: "reviewer-old",
    name: "reviewer-old",
    version: "1.0.0",
    sourceRef: "npm:reviewer@1.0.0",
  });
  const row = compare(
    current,
    candidate({
      id: "reviewer-new",
      name: "reviewer-new",
      packageName: "reviewer",
      pinnedRef: "v2.0.0",
    }),
  );
  assert.equal(row.action, "upgrade");
  assert.equal(row.candidateId, "reviewer-new");
});

test("replacement score respects adapter compatibility", () => {
  const current = installed({
    id: "legacy-review",
    name: "legacy-review",
    updateStatus: "outdated",
  });
  const next = candidate({
    id: "deep-review",
    name: "deep-review",
    capabilities: ["code-review.basic", "code-review.security"],
  });
  const full = compare(current, next, [current], { threshold: 40 });
  assert.equal(full.action, "replace");

  const partial = compare(current, next, [current], {
    threshold: 40,
    compatibility: 0.5,
  });
  assert.equal(partial.action, "keep");
  assert.ok(
    partial.reasons.some((reason) => reason.includes("profile threshold")),
  );
});

test("adapter mcp kind matches mcp-server candidates", () => {
  const current = installed({
    id: "mcp-tool",
    name: "mcp-tool",
    kind: "mcp",
    version: "1.0.0",
  });
  const row = compare(
    current,
    candidate({
      id: "mcp-tool",
      name: "mcp-tool",
      artifactType: "mcp-server",
      pinnedRef: "v2.0.0",
    }),
  );
  assert.equal(row.action, "upgrade");
});

test("same-tool upgrade honors the risk gate: critical audit keeps", () => {
  const row = compare(
    installed({ version: "1.2.0" }),
    candidate({
      auditStatus: "critical",
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
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
  assert.ok(row.reasons.some((reason) => reason.includes("risk gate")));
});

test("same-tool upgrade honors the risk gate: archived maintenance keeps", () => {
  const row = compare(
    installed({ version: "1.2.0" }),
    candidate({
      maintenance: "archived",
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
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("same-tool upgrade honors the risk gate: zero compatibility keeps", () => {
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
    [installed({ version: "1.2.0" })],
    { compatibility: 0 },
  );
  assert.equal(row.action, "keep");
  assert.equal(row.candidateId, undefined);
});

test("configRefs never establish same-tool identity", () => {
  const current = installed({
    id: "reviewer-old",
    name: "reviewer-old",
    version: "1.0.0",
    configRefs: ["/work/configs/reviewer"],
    capabilities: [],
  });
  const row = compare(
    current,
    candidate({
      id: "reviewer-new",
      name: "reviewer-new",
      packageName: "reviewer",
      pinnedRef: "v2.0.0",
      capabilities: [],
    }),
  );
  assert.notEqual(row.action, "upgrade");
});

test("package identity requires a boundary and a non-empty needle", () => {
  const current = installed({
    id: "reviewer-old",
    name: "reviewer-old",
    version: "1.0.0",
    sourceRef: "my-reviewer@1.0.0",
    capabilities: [],
  });
  const boundary = compare(
    current,
    candidate({
      id: "reviewer-new",
      name: "reviewer-new",
      packageName: "review",
      pinnedRef: "v2.0.0",
      capabilities: [],
    }),
  );
  assert.notEqual(boundary.action, "upgrade");

  const empty = compare(
    current,
    candidate({
      id: "reviewer-new",
      name: "reviewer-new",
      packageName: "   ",
      pinnedRef: "v2.0.0",
      capabilities: [],
    }),
  );
  assert.notEqual(empty.action, "upgrade");
});

test("dedupeReplacementRows proposes each replacement candidate once", () => {
  const first = installed({
    id: "reviewer-a",
    name: "reviewer-a",
    capabilities: ["code-review.basic"],
    updateStatus: "outdated",
  });
  const second = installed({
    id: "reviewer-b",
    name: "reviewer-b",
    capabilities: ["code-review.basic"],
    updateStatus: "outdated",
  });
  const next = candidate({
    id: "deep-review",
    name: "deep-review",
    capabilities: ["code-review.basic", "code-review.security"],
  });
  const rows = [
    compare(first, next, [first, second]),
    compare(second, next, [first, second]),
  ];
  assert.equal(rows[0]?.action, "replace");
  assert.equal(rows[1]?.action, "replace");

  const deduped = dedupeReplacementRows([
    rows[0] as (typeof rows)[number],
    { ...(rows[1] as (typeof rows)[number]), recipe: ["remove reviewer-b"] },
  ]);
  assert.equal(deduped[0]?.action, "replace");
  assert.equal(deduped[1]?.action, "keep");
  assert.equal(deduped[1]?.candidateId, undefined);
  assert.equal(
    deduped[1]?.recipe,
    undefined,
    "a demoted row must not carry an executable recipe",
  );
  assert.deepEqual(deduped[1]?.capabilitiesAdded, []);
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

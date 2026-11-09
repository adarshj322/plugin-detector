import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrust,
  normalizeCandidate,
  type RawCandidate,
  type TrustEvidence,
} from "../src/index.js";

const PROBED_AT = "2026-11-01T00:00:00.000Z";

function artifactProbe() {
  return {
    kind: "mcp-server" as const,
    sourceUrl: "https://registry.example.com/acme-thumb/1.4.2",
    resolvedRef: "npm:acme-thumb@1.4.2",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: "acme-thumb",
    capabilities: [],
    evidenceSnippets: ["name: acme-thumb"],
    retrievedAt: PROBED_AT,
  };
}

// Probed raw record from an official publisher org unless overridden.
function rawCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    id: "acme-thumb",
    name: "Acme Thumbnails",
    artifact: {
      kind: "mcp",
      file: "server.json",
      capabilities: ["thumbnails"],
      domains: ["design"],
    },
    artifactProbe: artifactProbe(),
    sourceKind: "official-registry",
    pinnedRef: "1.4.2",
    license: "MIT",
    repositoryUrl: "https://github.com/anthropics/acme-thumb",
    lastVerified: PROBED_AT,
    maintenance: "active",
    auditStatus: "clean",
    ...overrides,
  };
}

function evidence(overrides: Partial<TrustEvidence> = {}): TrustEvidence {
  return {
    maintainerVerified: true,
    activity: "active",
    reviewEvidence: false,
    ...overrides,
  };
}

test("official publisher org with a probed artifact classifies verified", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(candidate.artifactProbed, true);
  assert.equal(candidate.provenance, "publisher");
  assert.equal(classifyTrust(candidate, evidence()), "verified");
});

test("official source with a probed artifact classifies verified", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "standards-body",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(candidate.provenance, "official");
  assert.equal(
    classifyTrust(candidate, evidence({ maintainerVerified: false })),
    "verified",
  );
});

test("community probed repository stays unverified", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(candidate.artifactProbed, true);
  assert.equal(classifyTrust(candidate, evidence()), "unverified");
});

test("official publisher listing without a probed artifact is unverified", () => {
  const candidate = normalizeCandidate(
    rawCandidate({ artifactProbe: undefined, artifactProbed: false }),
  );
  assert.equal(candidate.artifactProbed, false);
  assert.equal(candidate.provenance, "publisher");
  assert.equal(classifyTrust(candidate, evidence()), "unverified");
});

test("publisher provenance requires both policy and maintainer evidence", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(candidate, evidence({ maintainerVerified: false })),
    "unverified",
  );
  const { repositoryUrl: _repo, packageName: _pkg, ...withoutIdentity } =
    candidate;
  assert.equal(
    classifyTrust(
      { ...withoutIdentity, provenance: "publisher" },
      evidence(),
    ),
    "unverified",
    "publisher provenance is not a trust claim by itself",
  );
});

test("artifactProbed must be true even for an official source", () => {
  const candidate = normalizeCandidate(
    rawCandidate({ sourceKind: "official" }),
  );
  const { artifactProbed: _probed, ...unprobed } = candidate;
  assert.equal(classifyTrust(unprobed, evidence()), "unverified");
});

test("archived, stale, critical audit, and closed license block verified", () => {
  const base = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust({ ...base, maintenance: "archived" }, evidence()),
    "unverified",
  );
  assert.equal(
    classifyTrust(base, evidence({ activity: "stale" })),
    "unverified",
  );
  assert.equal(
    classifyTrust(
      normalizeCandidate(rawCandidate({ auditStatus: "critical" })),
      evidence(),
    ),
    "unverified",
  );
  assert.equal(
    classifyTrust(
      normalizeCandidate(rawCandidate({ license: "unknown" })),
      evidence(),
    ),
    "unverified",
    "missing/unrecognized license is not open",
  );
});

test("missing checksum blocks verified", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(candidate, evidence({ checksumPresent: false })),
    "unverified",
  );
});

test("curated requires review evidence on top of a verified base", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(candidate, evidence({ reviewEvidence: true })),
    "curated",
  );
});

test("review evidence alone cannot promote a community candidate", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(
    classifyTrust(candidate, evidence({ reviewEvidence: true })),
    "unverified",
  );
});

test("popularity and stars never promote trust", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/acme/thumb",
      popularity: { stars: 999999, installs: 10 ** 8 },
    }),
  );
  assert.equal(classifyTrust(candidate, evidence()), "unverified");
});

test("drift and shell/exec copy suppress trust", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(candidate, evidence({ drifted: true })),
    "unverified",
  );
  assert.equal(
    classifyTrust(candidate, evidence({ untrustedCopyRisk: true })),
    "unverified",
  );
});

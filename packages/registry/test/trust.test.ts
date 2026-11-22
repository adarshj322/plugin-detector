import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrust,
  detectDrift,
  normalizeCandidate,
  publisherMatchesProbe,
  type RawCandidate,
  type TrustEvidence,
} from "../src/index.js";

const PROBED_AT = "2026-11-01T00:00:00.000Z";

function artifactProbe(sourceUrl?: string) {
  return {
    kind: "mcp-server" as const,
    sourceUrl:
      sourceUrl ?? "https://raw.githubusercontent.com/anthropics/acme-thumb/HEAD/server.json",
    resolvedRef: "HEAD",
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

test("missing artifact evidence is unprobed even with an official repo", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "official",
      artifactProbe: undefined,
      artifactProbed: undefined,
    }),
  );
  assert.equal(candidate.artifactProbed, false);
  assert.equal(classifyTrust(candidate, evidence()), "unverified");
});

test("manifest packageName cannot make a community repo verified", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/acme/evil",
      packageName: "openai",
    }),
  );
  assert.equal(candidate.provenance, "community");
  assert.equal(classifyTrust(candidate, evidence()), "unverified");
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

test("publisher enrichment from unknown is not drift", () => {
  const previous = normalizeCandidate(
    rawCandidate({ license: "unknown", maintenance: "unknown" }),
  );
  const current = normalizeCandidate(
    rawCandidate({ license: "MIT", maintenance: "active" }),
  );
  assert.deepEqual(detectDrift(previous, current), {
    drifted: false,
    reasons: ["no manifest change under the same tag"],
  });
});

test("known license or maintenance changes under one pin still drift", () => {
  const previous = normalizeCandidate(
    rawCandidate({ license: "MIT", maintenance: "active" }),
  );
  const licenseChange = normalizeCandidate(
    rawCandidate({ license: "Apache-2.0", maintenance: "active" }),
  );
  assert.equal(detectDrift(previous, licenseChange).drifted, true);
  const maintenanceChange = normalizeCandidate(
    rawCandidate({ license: "MIT", maintenance: "unknown" }),
  );
  assert.equal(detectDrift(previous, maintenanceChange).drifted, true);
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

test("publisher binding matches the probed GitHub raw owner/repo exactly", () => {
  const matching = normalizeCandidate(rawCandidate());
  assert.equal(publisherMatchesProbe(matching), true);
  assert.equal(classifyTrust(matching, evidence()), "verified");

  const mismatched = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      artifactProbe: artifactProbe(
        "https://raw.githubusercontent.com/evil-mcp/plugin/HEAD/server.json",
      ),
    }),
  );
  assert.equal(mismatched.provenance, "publisher");
  assert.equal(publisherMatchesProbe(mismatched), false);
  assert.equal(classifyTrust(mismatched, evidence()), "unverified");
});

test("publisher binding accepts skills.sh downloads for the claimed repo", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/anthropics/skills",
      artifactProbe: {
        ...artifactProbe(),
        kind: "skill",
        sourceUrl:
          "https://skills.sh/api/download/anthropics/skills/agent-creator",
      },
    }),
  );
  assert.equal(publisherMatchesProbe(candidate), true);
  assert.equal(classifyTrust(candidate, evidence()), "verified");
});

test("publisher binding requires the package scope to match the claimed repo", () => {
  const scoped = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@openai/sdk",
      packageRegistry: "npm",
      artifactProbe: {
        ...artifactProbe("https://registry.npmjs.org/%40openai%2Fsdk"),
        packageName: "@openai/sdk",
      },
    }),
  );
  assert.equal(publisherMatchesProbe(scoped), true);
  assert.equal(classifyTrust(scoped, evidence()), "verified");

  const unscoped = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "evil-mcp",
      packageRegistry: "npm",
      artifactProbe: {
        ...artifactProbe("https://registry.npmjs.org/evil-mcp"),
        packageName: "evil-mcp",
      },
    }),
  );
  assert.equal(unscoped.provenance, "publisher");
  assert.equal(publisherMatchesProbe(unscoped), false);
  assert.equal(classifyTrust(unscoped, evidence()), "unverified");
});

test("publisher binding refuses registry type or PyPI evidence without ownership", () => {
  const wrongRegistry = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@openai/sdk",
      packageRegistry: "npm",
      artifactProbe: artifactProbe("https://pypi.org/pypi/openai-sdk/json"),
    }),
  );
  assert.equal(publisherMatchesProbe(wrongRegistry), false);

  const pypi = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "openai",
      packageRegistry: "pypi",
      artifactProbe: artifactProbe("https://pypi.org/pypi/openai/json"),
    }),
  );
  assert.equal(publisherMatchesProbe(pypi), false);
  assert.equal(classifyTrust(pypi, evidence()), "unverified");
});

test("repo evidence must bind a claimed packageName to the probed artifact", () => {
  const conflictingEvidence = artifactProbe(
    "https://raw.githubusercontent.com/openai/openai-node/HEAD/plugin.json",
  );
  const conflicting = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "evil-mcp",
      artifactProbe: conflictingEvidence,
    }),
  );
  // Listing-supplied package identity is dropped, and the contradiction
  // prevents publisher trust even though the repository evidence matches.
  assert.equal(conflicting.packageName, undefined);
  assert.equal(conflicting.provenance, "community");
  assert.equal(classifyTrust(conflicting, evidence()), "unverified");

  // Defense for a candidate built outside normalize: the package claim still
  // must match evidence.packageName.
  const forged = { ...conflicting, packageName: "evil-mcp" };
  assert.equal(publisherMatchesProbe(forged), false);

  const matchingEvidence = {
    ...conflictingEvidence,
    packageName: "@openai/sdk",
  };
  const matching = normalizeCandidate(
    rawCandidate({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@openai/sdk",
      artifactProbe: matchingEvidence,
    }),
  );
  assert.equal(matching.packageName, "@openai/sdk");
  assert.equal(publisherMatchesProbe(matching), true);
  assert.equal(classifyTrust(matching, evidence()), "verified");
});

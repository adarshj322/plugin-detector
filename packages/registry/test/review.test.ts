import test from "node:test";
import assert from "node:assert/strict";
import { CandidateSchema, type Candidate } from "@plugin-detector/core";
import {
  RegistrySnapshotSchema,
  ReviewReportSchema,
  buildReviewReport,
  type CacheManifest,
  type RegistrySnapshot,
  type TrustClass,
} from "../src/index.js";

const NOW = "2026-11-09T00:00:00.000Z";

function candidate(
  id: string,
  artifactType: "skill" | "mcp-server" = "skill",
  overrides: Partial<Candidate> = {},
): Candidate {
  return CandidateSchema.parse({
    id,
    name: `${id} name`,
    artifactType,
    sources: [`https://example.com/${id}`],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.2.3",
    installMode: "verified",
    lastVerified: NOW,
    artifactEvidence: {
      kind: artifactType,
      sourceUrl: `https://raw.githubusercontent.com/acme/${id}/v1.2.3/artifact.json`,
      resolvedRef: "v1.2.3",
      contentHash: "a".repeat(64),
      license: "Apache-2.0",
      name: `${id} name`,
      capabilities: ["testing.runner"],
      evidenceSnippets: [`name: ${id}`, `version: 1.2.3`],
      retrievedAt: NOW,
    },
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: {},
    ...overrides,
  });
}

function snapshot(
  entries: Array<{
    candidate: Candidate;
    sourceUrl: string;
    trust: TrustClass;
    retrievedAt?: string;
  }>,
): RegistrySnapshot {
  return RegistrySnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: NOW,
    candidates: entries.map((entry) => entry.candidate),
    provenance: entries.map((entry) => ({
      id: entry.candidate.id,
      sourceUrl: entry.sourceUrl,
      retrievedAt: entry.retrievedAt ?? NOW,
      trust: entry.trust,
    })),
  });
}

function manifest(overrides: Partial<CacheManifest> = {}): CacheManifest {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    sources: { "skills-sh": { ok: true, count: 2 } },
    ...overrides,
  };
}

test("review report counts probed, unprobed, rejected, and total records", () => {
  const report = buildReviewReport(
    snapshot([
      {
        candidate: candidate("alpha"),
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
      {
        candidate: candidate("beta", "mcp-server"),
        sourceUrl: "https://registry.modelcontextprotocol.io/v0/servers",
        trust: "curated",
      },
    ]),
    manifest({
      rejected: [
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
        {
          id: "gone-b",
          reason: "install hooks are not allowed",
          sourceUrl: "https://github.com/search",
          rejectedAt: NOW,
          pinnedRef: "main",
        },
      ],
      unprobed: [
        {
          id: "listed",
          reason: "no artifact evidence: listing-only record excluded from snapshot",
          sourceUrl: "https://github.com/search",
          observedAt: NOW,
        },
      ],
    }),
    new Date("2026-11-09T12:00:00.000Z"),
  );

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, "2026-11-09T12:00:00.000Z");
  assert.equal(report.snapshotGeneratedAt, NOW);
  assert.deepEqual(report.counts, {
    total: 5,
    probed: 2,
    preserved: 0,
    unprobed: 1,
    rejected: 2,
    rejectedAlsoPreserved: 0,
  });
});

test("review report carries per-candidate evidence for the reviewer", () => {
  const report = buildReviewReport(
    snapshot([
      {
        candidate: candidate("alpha"),
        sourceUrl: "https://skills.sh/api/search",
        trust: "curated",
      },
    ]),
    null,
  );

  assert.deepEqual(report.candidates, [
    {
      id: "alpha",
      name: "alpha name",
      artifactType: "skill",
      sourceUrl: "https://skills.sh/api/search",
      provenance: "official",
      trust: "curated",
      license: "Apache-2.0",
      pinnedRef: "v1.2.3",
      risk: "low",
      maintenance: "active",
      auditStatus: "clean",
      lastVerified: NOW,
      retrievedAt: NOW,
      preserved: false,
      evidenceSource:
        "https://raw.githubusercontent.com/acme/alpha/v1.2.3/artifact.json",
      evidenceRef: "v1.2.3",
      contentHash: "a".repeat(64),
      evidenceSnippets: ["name: alpha", "version: 1.2.3"],
      capabilities: ["testing.runner"],
    },
  ]);
  assert.deepEqual(report.unprobed, []);
  assert.deepEqual(report.rejected, []);
  assert.deepEqual(report.rejectedGroups, []);
  assert.equal(report.manifestGeneratedAt, null);
  assert.deepEqual(report.sourceHealth, []);
  assert.equal(report.counts.preserved, 0);
  assert.equal(report.counts.rejectedAlsoPreserved, 0);
});

test("review report marks preserved candidates, ages, and source health", () => {
  const later = "2026-11-09T01:00:00.000Z";
  const preserved = candidate("alpha", "skill", {
    risk: "medium",
    maintenance: "stale",
    auditStatus: "warning",
  });
  const fresh = candidate("beta", "skill", {
    lastVerified: later,
  });
  if (fresh.artifactEvidence !== undefined) {
    fresh.artifactEvidence.retrievedAt = later;
  }
  const report = buildReviewReport(
    snapshot([
      {
        candidate: preserved,
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
      {
        candidate: fresh,
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
    ]),
    manifest({
      generatedAt: later,
      sources: {
        "skills-sh": {
          ok: true,
          count: 1,
          partial: true,
          failures: [{ query: "topic:alpha", error: "timeout" }],
        },
        github: { ok: false, error: "502 Bad Gateway" },
      },
      rejected: [
        {
          id: "alpha",
          reason: "ARTIFACT_UNAVAILABLE: timeout",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: later,
        },
      ],
    }),
    new Date(later),
  );

  assert.equal(report.manifestGeneratedAt, later);
  assert.deepEqual(report.sourceHealth, [
    {
      id: "github",
      ok: false,
      error: "502 Bad Gateway",
    },
    {
      id: "skills-sh",
      ok: true,
      count: 1,
      partial: true,
      failures: [{ query: "topic:alpha", error: "timeout" }],
    },
  ]);
  const alpha = report.candidates.find((c) => c.id === "alpha");
  const beta = report.candidates.find((c) => c.id === "beta");
  assert.equal(alpha?.preserved, true);
  assert.equal(alpha?.risk, "medium");
  assert.equal(alpha?.maintenance, "stale");
  assert.equal(alpha?.auditStatus, "warning");
  assert.equal(alpha?.lastVerified, NOW);
  assert.equal(alpha?.retrievedAt, NOW);
  assert.equal(beta?.preserved, false);
  assert.equal(report.counts.preserved, 1);
  assert.equal(report.counts.rejectedAlsoPreserved, 1);
  assert.equal(report.counts.total, 3);
});

test("review report counts records per source URL", () => {
  const report = buildReviewReport(
    snapshot([
      {
        candidate: candidate("alpha"),
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
      {
        candidate: candidate("beta"),
        sourceUrl: "https://github.com/search",
        trust: "verified",
      },
    ]),
    manifest({
      rejected: [
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
      ],
      unprobed: [
        {
          id: "listed",
          reason: "no artifact evidence: listing-only record excluded from snapshot",
          sourceUrl: "https://github.com/search",
          observedAt: NOW,
        },
      ],
    }),
  );

  assert.deepEqual(report.sources, [
    {
      sourceUrl: "https://github.com/search",
      probed: 1,
      unprobed: 1,
      rejected: 0,
    },
    {
      sourceUrl: "https://skills.sh/api/search",
      probed: 1,
      unprobed: 0,
      rejected: 1,
    },
  ]);
});

test("review report groups rejected records by reason and source", () => {
  const report = buildReviewReport(
    snapshot([
      {
        candidate: candidate("alpha"),
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
    ]),
    manifest({
      rejected: [
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
        {
          id: "gone-c",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://github.com/search",
          rejectedAt: NOW,
        },
        {
          id: "gone-d",
          reason: "install hooks are not allowed",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
      ],
    }),
  );

  assert.deepEqual(report.rejectedGroups, [
    {
      reason: "ARTIFACT_MISSING: 404",
      sourceUrl: "https://skills.sh/api/search",
      count: 2,
      ids: ["gone-a"],
    },
    {
      reason: "ARTIFACT_MISSING: 404",
      sourceUrl: "https://github.com/search",
      count: 1,
      ids: ["gone-c"],
    },
    {
      reason: "install hooks are not allowed",
      sourceUrl: "https://skills.sh/api/search",
      count: 1,
      ids: ["gone-d"],
    },
  ]);
  assert.equal(report.rejected.length, 4);
  assert.equal(report.rejected[0]?.at, NOW);
});

test("review report refuses an empty snapshot", () => {
  assert.throws(
    () =>
      buildReviewReport(
        { schemaVersion: 1, generatedAt: NOW, candidates: [], provenance: [] },
        null,
      ),
    /no candidates to review/,
  );
});

test("review report refuses a snapshot candidate without artifact evidence", () => {
  const { artifactEvidence: _evidence, ...unprobed } = candidate("alpha");
  const snap = snapshot([
    {
      candidate: CandidateSchema.parse(unprobed),
      sourceUrl: "https://skills.sh/api/search",
      trust: "verified",
    },
  ]);
  assert.throws(
    () => buildReviewReport(snap, null),
    /"alpha" has no artifact evidence/,
  );
});

test("review report refuses a snapshot candidate without provenance", () => {
  const snap = snapshot([
    {
      candidate: candidate("alpha"),
      sourceUrl: "https://skills.sh/api/search",
      trust: "verified",
    },
  ]);
  snap.provenance = [];
  assert.throws(
    () => buildReviewReport(snap, null),
    /"alpha" has no provenance record/,
  );
});

test("review report validates its own JSON shape", () => {
  const report = buildReviewReport(
    snapshot([
      {
        candidate: candidate("alpha"),
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
    ]),
    manifest({
      rejected: [
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: NOW,
        },
      ],
    }),
  );
  assert.deepEqual(
    ReviewReportSchema.parse(JSON.parse(JSON.stringify(report))),
    report,
  );
  assert.throws(() =>
    ReviewReportSchema.parse({
      ...report,
      counts: { ...report.counts, total: -1 },
    }),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  parseSnapshot,
  normalizeCandidate,
  type RawCandidate,
} from "../src/index.js";

function artifactProbe(id: string = "acme-thumb") {
  return {
    kind: "mcp-server" as const,
    sourceUrl: `https://raw.githubusercontent.com/acme/${id}/HEAD/server.json`,
    resolvedRef: "HEAD",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: id,
    capabilities: [],
    evidenceSnippets: [`name: ${id}`],
    retrievedAt: "2026-11-01T00:00:00.000Z",
  };
}

function rawCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  const id = overrides.id ?? "acme-thumb";
  return {
    id,
    name: "Acme Thumbnails",
    artifact: {
      kind: "mcp",
      file: "server.json",
      capabilities: ["thumbnails"],
      domains: ["design"],
    },
    artifactProbe: artifactProbe(id),
    sourceKind: "official-registry",
    pinnedRef: "1.4.2",
    license: "MIT",
    registryUrl: "https://registry.example.com/acme-thumb",
    lastVerified: "2026-11-01T00:00:00.000Z",
    maintenance: "active",
    auditStatus: "clean",
    ...overrides,
  };
}

const NOW = new Date("2026-11-08T00:00:00.000Z");

test("snapshot is deterministic and timestamped", () => {
  const candidate = normalizeCandidate(rawCandidate());
  const a = buildSnapshot(
    [
      {
        candidate,
        sourceUrl: "https://registry.example.com/list",
        trust: "verified",
      },
    ],
    NOW,
  );
  const b = parseSnapshot(JSON.stringify(a));
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.generatedAt, NOW.toISOString());
});

test("snapshot sorts candidates by stable id", () => {
  const b = normalizeCandidate(rawCandidate({ id: "b-id" }));
  const a = normalizeCandidate(rawCandidate({ id: "a-id" }));
  const snapshot = buildSnapshot(
    [
      { candidate: b, sourceUrl: "https://x.example/s", trust: "unverified" },
      { candidate: a, sourceUrl: "https://x.example/s", trust: "unverified" },
    ],
    NOW,
  );
  assert.deepEqual(
    snapshot.candidates.map((c) => c.id),
    ["a-id", "b-id"],
  );
  assert.deepEqual(
    snapshot.provenance.map((p) => p.id),
    ["a-id", "b-id"],
  );
});

test("snapshot records source url, retrieval time, and trust per candidate", () => {
  const candidate = normalizeCandidate(rawCandidate());
  const snapshot = buildSnapshot(
    [
      {
        candidate,
        sourceUrl: "https://x.example/s",
        retrievedAt: "2026-11-07T00:00:00.000Z",
        trust: "curated",
      },
    ],
    NOW,
  );
  assert.equal(snapshot.provenance[0]?.sourceUrl, "https://x.example/s");
  assert.equal(snapshot.provenance[0]?.retrievedAt, "2026-11-07T00:00:00.000Z");
  assert.equal(snapshot.provenance[0]?.trust, "curated");
});

test("parseSnapshot rejects wrong schema version and bad candidates", () => {
  const candidate = normalizeCandidate(rawCandidate());
  const good = buildSnapshot(
    [{ candidate, sourceUrl: "https://x.example/s", trust: "verified" }],
    NOW,
  );
  assert.throws(() =>
    parseSnapshot(JSON.stringify({ ...good, schemaVersion: 2 })),
  );
  assert.throws(() => parseSnapshot("not json"));
  assert.throws(() =>
    parseSnapshot(
      JSON.stringify({ ...good, candidates: [{ id: "nope" }] }),
    ),
  );
});

test("duplicate ids from two sources dedupe deterministically and merge provenance", () => {
  const community = normalizeCandidate(
    rawCandidate({
      id: "dup-id",
      sourceKind: "community",
      repositoryUrl: "https://github.com/owner/dup",
      registryUrl: undefined,
    }),
  );
  const official = normalizeCandidate(
    rawCandidate({
      id: "dup-id",
      sourceKind: "official-registry",
      registryUrl: "https://registry.example.com/dup",
      repositoryUrl: undefined,
    }),
  );
  const snapshot = buildSnapshot(
    [
      {
        candidate: community,
        sourceUrl: "https://github.com/search",
        trust: "unverified",
      },
      {
        candidate: official,
        sourceUrl: "https://registry.example.com/list",
        trust: "verified",
      },
    ],
    NOW,
  );
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.provenance.length, 1);
  assert.equal(snapshot.provenance[0]?.trust, "verified");
  assert.equal(snapshot.provenance[0]?.sourceUrl, "https://registry.example.com/list");
  const sources = snapshot.candidates[0]?.sources ?? [];
  assert.ok(sources.includes("https://github.com/owner/dup"));
  assert.ok(sources.includes("https://registry.example.com/dup"));
});

test("snapshot carries probed evidence into candidates and survives a round trip", () => {
  const candidate = normalizeCandidate(rawCandidate());
  const snapshot = buildSnapshot(
    [{ candidate, sourceUrl: "https://x.example/s", trust: "unverified" }],
    NOW,
  );
  const evidence = snapshot.candidates[0]?.artifactEvidence;
  assert.ok(evidence, "probed candidate must keep its evidence");
  assert.equal(evidence.contentHash, "a".repeat(64));
  assert.equal(evidence.sourceUrl, "https://raw.githubusercontent.com/acme/acme-thumb/HEAD/server.json");
  assert.equal(snapshot.candidates[0]?.artifactProbed, true);
  assert.deepEqual(parseSnapshot(JSON.stringify(snapshot)), snapshot);
});

test("snapshot excludes candidates without real artifact evidence", () => {
  const probed = normalizeCandidate(rawCandidate({ id: "probed-one" }));
  const listing = normalizeCandidate(
    rawCandidate({
      id: "listing-one",
      artifactProbe: undefined,
      artifactProbed: true,
    }),
  );
  assert.equal(listing.artifactProbed, false);
  const snapshot = buildSnapshot(
    [
      { candidate: listing, sourceUrl: "https://x.example/s", trust: "unverified" },
      { candidate: probed, sourceUrl: "https://x.example/s", trust: "unverified" },
    ],
    NOW,
  );
  assert.deepEqual(snapshot.candidates.map((c) => c.id), ["probed-one"]);
  assert.deepEqual(snapshot.provenance.map((p) => p.id), ["probed-one"]);
});

test("duplicate id precedence is official, then publisher, then community", () => {
  const official = normalizeCandidate(
    rawCandidate({
      id: "dedupe-id",
      sourceKind: "official",
      repositoryUrl: "https://github.com/acme/dedupe",
    }),
  );
  const publisher = normalizeCandidate(
    rawCandidate({
      id: "dedupe-id",
      sourceKind: "community",
      repositoryUrl: "https://github.com/openai/dedupe",
      packageName: "@openai/dedupe",
    }),
  );
  const community = normalizeCandidate(
    rawCandidate({
      id: "dedupe-id",
      sourceKind: "community",
      repositoryUrl: "https://github.com/acme/dedupe",
    }),
  );
  const snapshot = buildSnapshot(
    [
      {
        candidate: community,
        sourceUrl: "https://x.example/community",
        trust: "verified",
      },
      {
        candidate: publisher,
        sourceUrl: "https://x.example/publisher",
        trust: "verified",
      },
      {
        candidate: official,
        sourceUrl: "https://x.example/official",
        trust: "unverified",
      },
    ],
    NOW,
  );
  assert.equal(snapshot.candidates[0]?.id, "dedupe-id");
  assert.equal(snapshot.candidates[0]?.provenance, "official");
  assert.equal(snapshot.provenance[0]?.sourceUrl, "https://x.example/official");
});

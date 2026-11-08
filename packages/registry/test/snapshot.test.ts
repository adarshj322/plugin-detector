import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  parseSnapshot,
  normalizeCandidate,
  type RawCandidate,
} from "../src/index.js";

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

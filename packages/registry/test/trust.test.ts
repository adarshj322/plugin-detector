import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrust,
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

test("official marketplace with pinned version and clean audit classifies verified", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      artifact: { kind: "mcp", file: "server.json" },
      sourceKind: "official-registry",
      pinnedRef: "1.4.2",
      license: "MIT",
      auditStatus: "clean",
    }),
  );
  assert.equal(
    classifyTrust(candidate, { maintainerVerified: true, activity: "active" }),
    "verified",
  );
});

test("in-repo review evidence promotes to curated", () => {
  const candidate = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: true,
      activity: "active",
      reviewEvidence: true,
    }),
    "curated",
  );
});

test("review evidence alone cannot promote an otherwise unverified candidate", () => {
  const candidate = normalizeCandidate(
    rawCandidate({ sourceKind: "community", auditStatus: "unknown" }),
  );
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: false,
      activity: "active",
      reviewEvidence: true,
    }),
    "unverified",
  );
});

test("popularity never promotes trust", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      popularity: { stars: 999999, installs: 10 ** 8 },
    }),
  );
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: false,
      activity: "active",
    }),
    "unverified",
  );
});

test("stale activity, critical audit, or closed license blocks verified", () => {
  const base = normalizeCandidate(rawCandidate());
  assert.equal(
    classifyTrust(base, { maintainerVerified: true, activity: "stale" }),
    "unverified",
  );
  assert.equal(
    classifyTrust(
      normalizeCandidate(rawCandidate({ auditStatus: "critical" })),
      { maintainerVerified: true, activity: "active" },
    ),
    "unverified",
  );
  assert.equal(
    classifyTrust(
      normalizeCandidate(rawCandidate({ license: "Proprietary" })),
      { maintainerVerified: true, activity: "active" },
    ),
    "unverified",
  );
});

test("unverified publisher and missing checksum block verified", () => {
  const publisherUnverified = normalizeCandidate(
    rawCandidate({ sourceKind: "publisher" }),
  );
  assert.equal(
    classifyTrust(publisherUnverified, {
      maintainerVerified: false,
      activity: "active",
    }),
    "unverified",
  );
  const publisher = normalizeCandidate(
    rawCandidate({ sourceKind: "publisher" }),
  );
  assert.equal(
    classifyTrust(publisher, {
      maintainerVerified: true,
      activity: "active",
      checksumPresent: false,
    }),
    "unverified",
  );
});

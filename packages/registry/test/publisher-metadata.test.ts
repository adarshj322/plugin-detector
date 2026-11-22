import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrust,
  enrichPublisherCandidate,
  normalizeCandidate,
  type RawCandidate,
} from "../src/index.js";

const NOW = new Date().toISOString();
const STALE = new Date(Date.now() - 400 * 86_400_000).toISOString();

function artifactProbe(sourceUrl = "https://raw.githubusercontent.com/anthropics/acme-thumb/HEAD/server.json") {
  return {
    kind: "mcp-server" as const,
    sourceUrl,
    resolvedRef: "HEAD",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: "acme-thumb",
    capabilities: [],
    evidenceSnippets: ["name: acme-thumb"],
    retrievedAt: NOW,
  };
}

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
    sourceKind: "community",
    pinnedRef: "1.4.2",
    license: "unknown",
    repositoryUrl: "https://github.com/anthropics/acme-thumb",
    lastVerified: NOW,
    auditStatus: "clean",
    ...overrides,
  };
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      license: { spdx_id: "MIT" },
      pushed_at: NOW,
      stargazers_count: 42,
      archived: false,
      ...overrides,
    },
  };
}

test("enriches an allowlisted publisher license, activity, and stars", async () => {
  const out = await enrichPublisherCandidate(rawCandidate(), {
    get: async () => metadata(),
    cache: new Map(),
  });
  assert.equal(out.license, "MIT");
  assert.equal(out.pushedAt, NOW);
  assert.equal(out.popularity?.stars, 42);
  const candidate = normalizeCandidate(out);
  assert.equal(candidate.maintenance, "active");
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: true,
      activity: "active",
      reviewEvidence: false,
    }),
    "verified",
  );
});

test("does not override an artifact-declared license", async () => {
  const out = await enrichPublisherCandidate(
    rawCandidate({ license: "Complete terms in LICENSE.txt" }),
    { get: async () => metadata(), cache: new Map() },
  );
  assert.equal(out.license, "Complete terms in LICENSE.txt");
  const candidate = normalizeCandidate(out);
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: true,
      activity: "active",
      reviewEvidence: false,
    }),
    "unverified",
  );
});

test("archived repository stays unverified", async () => {
  const out = await enrichPublisherCandidate(rawCandidate(), {
    get: async () => metadata({ archived: true }),
    cache: new Map(),
  });
  assert.equal(out.maintenance, "archived");
  assert.throws(() => normalizeCandidate(out), /archived/);
});

test("stale repository activity stays unverified", async () => {
  const out = await enrichPublisherCandidate(rawCandidate(), {
    get: async () => metadata({ pushed_at: STALE }),
    cache: new Map(),
  });
  const candidate = normalizeCandidate(out);
  assert.equal(candidate.maintenance, "stale");
  assert.equal(
    classifyTrust(candidate, {
      maintainerVerified: true,
      activity: "stale",
      reviewEvidence: false,
    }),
    "unverified",
  );
});

test("non-publisher candidates are not fetched", async () => {
  let calls = 0;
  const out = await enrichPublisherCandidate(
    rawCandidate({ repositoryUrl: "https://github.com/evil/tool" }),
    {
      get: async () => {
        calls += 1;
        return metadata();
      },
      cache: new Map(),
    },
  );
  assert.equal(calls, 0);
  assert.equal(out.license, "unknown");
});

test("metadata failure is non-fatal and leaves the candidate unchanged", async () => {
  const raw = rawCandidate();
  const out = await enrichPublisherCandidate(raw, {
    get: async () => {
      throw new Error("rate limited");
    },
    cache: new Map(),
  });
  assert.deepEqual(out, raw);
});

test("one request is shared by candidates from the same repository", async () => {
  let calls = 0;
  const cache = new Map();
  const get = async () => {
    calls += 1;
    return metadata();
  };
  await enrichPublisherCandidate(rawCandidate({ id: "one" }), { get, cache });
  await enrichPublisherCandidate(rawCandidate({ id: "two" }), { get, cache });
  assert.equal(calls, 1);
});

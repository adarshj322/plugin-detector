import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  loadSnapshot,
  normalizeCandidate,
  refreshSnapshot,
  resolveCacheDir,
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
    maintenance: "active",
    auditStatus: "clean",
    ...overrides,
  };
}

const NOW = new Date("2026-11-08T00:00:00.000Z");
const SOURCE_URL = "https://example.com/source-a";

function fetcherOf(url: string, raws: RawCandidate[] | Error) {
  return {
    id: "source-a",
    url,
    fetch: async () => {
      if (raws instanceof Error) throw raws;
      return { raws };
    },
  };
}

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "pd-cache-"));
}

test("resolveCacheDir honors env override for tests", () => {
  process.env.PLUGIN_DETECTOR_CACHE_DIR = "/tmp/pd-test-override";
  try {
    assert.equal(resolveCacheDir(), "/tmp/pd-test-override");
  } finally {
    delete process.env.PLUGIN_DETECTOR_CACHE_DIR;
  }
  assert.ok(resolveCacheDir().endsWith("plugin-detector"));
});

test("loadSnapshot falls back to bundled snapshot when cache is empty", () => {
  const snapshot = loadSnapshot({ cacheDir: tmpCache() });
  assert.equal(snapshot.schemaVersion, 1);
});

test("older populated cache wins over newer bundled snapshot", () => {
  // Bundled generatedAt (2026-11-08) is newer than this cache seed; the
  // cache must still win so a shipped snapshot never shadows user data.
  const dir = tmpCache();
  const kept = normalizeCandidate(
    rawCandidate({
      id: "cached-one",
      lastVerified: "2026-10-01T00:00:00.000Z",
    }),
  );
  const seed = buildSnapshot(
    [{ candidate: kept, sourceUrl: SOURCE_URL, trust: "unverified" }],
    new Date("2026-10-01T00:00:00.000Z"),
  );
  writeFileSync(join(dir, "registry-snapshot.json"), JSON.stringify(seed));
  const loaded = loadSnapshot({ cacheDir: dir });
  assert.equal(loaded.candidates[0]?.id, "cached-one");
});

test("corrupt cache falls back to bundled snapshot", () => {
  const dir = tmpCache();
  writeFileSync(join(dir, "registry-snapshot.json"), "{not json");
  const loaded = loadSnapshot({ cacheDir: dir });
  assert.equal(loaded.schemaVersion, 1);
});

test("refresh writes snapshot and prefers cache over bundled", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [fetcherOf(SOURCE_URL, [rawCandidate()])],
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshot?.candidates.length, 1);
  const loaded = loadSnapshot({ cacheDir: dir });
  assert.equal(loaded.candidates[0]?.id, "acme-thumb");
  // Refreshed candidates are stamped with the retrieval time.
  assert.equal(loaded.candidates[0]?.lastVerified, NOW.toISOString());
});

test("total network failure exits 2 with zero cache mutation", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [fetcherOf(SOURCE_URL, new Error("boom"))],
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.snapshot, null);
  assert.deepEqual(readdirSync(dir), []);
});

test("partial failure writes refreshed subset and keeps stale lastVerified age", async () => {
  const dir = tmpCache();
  const stale = normalizeCandidate(
    rawCandidate({
      id: "stale-one",
      lastVerified: "2026-10-01T00:00:00.000Z",
    }),
  );
  const staleUrl = "https://example.com/stale-source";
  const seed = buildSnapshot(
    [{ candidate: stale, sourceUrl: staleUrl, trust: "unverified" }],
    new Date("2026-10-01T00:00:00.000Z"),
  );
  writeFileSync(join(dir, "registry-snapshot.json"), JSON.stringify(seed));
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      fetcherOf(SOURCE_URL, [rawCandidate()]),
      fetcherOf(staleUrl, new Error("down")),
    ],
  });
  assert.equal(result.ok, true);
  assert.ok(result.failures[staleUrl]?.includes("down"));
  const ids = (result.snapshot?.candidates.map((c) => c.id) ?? []).sort();
  assert.deepEqual(ids, ["acme-thumb", "stale-one"]);
  const kept = result.snapshot?.candidates.find((c) => c.id === "stale-one");
  // Stale entries are never silently re-stamped as fresh.
  assert.equal(kept?.lastVerified, "2026-10-01T00:00:00.000Z");
});

test("refresh honors limit", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    limit: 1,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({ id: "b-id" }),
        rawCandidate({ id: "a-id" }),
      ]),
    ],
  });
  assert.equal(result.snapshot?.candidates.length, 1);
  assert.equal(result.snapshot?.candidates[0]?.id, "a-id");
});

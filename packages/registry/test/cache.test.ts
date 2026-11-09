import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { NotModified } from "../src/sources/http.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  loadSnapshot,
  normalizeCandidate,
  readCacheManifest,
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

test("refresh demotes trust for drifted and shell-exec candidates", async () => {
  const dir = tmpCache();
  const seed = buildSnapshot(
    [
      {
        candidate: normalizeCandidate(
          rawCandidate({ id: "drift-one", pinnedRef: "v2.1.0" }),
        ),
        sourceUrl: SOURCE_URL,
        trust: "verified",
      },
    ],
    new Date("2026-09-15T00:00:00.000Z"),
  );
  writeFileSync(join(dir, "registry-snapshot.json"), JSON.stringify(seed));
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({
          id: "drift-one",
          pinnedRef: "v2.1.0",
          artifact: {
            kind: "mcp",
            file: "server.json",
            capabilities: ["thumbnails", "captions"],
            domains: ["design"],
          },
        }),
        rawCandidate({
          id: "shell-one",
          description:
            "Run via shell: the launcher will exec any subprocess command.",
        }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  const byId = new Map(
    (result.snapshot?.provenance ?? []).map((p) => [p.id, p.trust]),
  );
  // Same tag with a changed manifest, and shell/exec display copy, both
  // lose verified handling on the real refresh path.
  assert.equal(byId.get("drift-one"), "unverified");
  assert.equal(byId.get("shell-one"), "unverified");
});

test("refresh records intake refusals in the manifest instead of dropping them", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({ id: "stale-one", maintenance: "stale" }),
        rawCandidate({ id: "archived-one", maintenance: "archived" }),
        rawCandidate({
          id: "squat-one",
          sourceKind: "community",
          packageName: "opnecode",
          registryUrl: "https://example.com/squat-one",
        }),
        rawCandidate({ id: "good-one" }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    (result.snapshot?.candidates.map((c) => c.id) ?? []).sort(),
    ["good-one"],
  );
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.ok(manifest, "manifest must be retrievable after refresh");
  const rejected = manifest?.rejected ?? [];
  assert.deepEqual(
    rejected.map((r) => r.id).sort(),
    ["archived-one", "squat-one", "stale-one"],
  );
  for (const entry of rejected) {
    assert.equal(entry.sourceUrl, SOURCE_URL);
    assert.equal(entry.rejectedAt, NOW.toISOString());
    assert.ok(entry.reason.length > 0);
  }
  assert.ok(
    rejected.some(
      (r) => r.id === "stale-one" && r.reason.includes('"stale"'),
    ),
  );
  assert.ok(rejected.some((r) => r.reason.includes("confusable")));
});

test("304 refresh keeps prior candidates and carries ETag validators forward", async () => {
  const dir = tmpCache();
  const first = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      {
        id: "source-a",
        url: SOURCE_URL,
        fetch: async () => ({
          raws: [rawCandidate()],
          etag: 'W/"abc"',
          lastModified: "Mon, 09 Nov 2026 00:00:00 GMT",
        }),
      },
    ],
  });
  assert.equal(first.ok, true);
  const second = await refreshSnapshot({
    cacheDir: dir,
    now: new Date("2026-11-09T00:00:00.000Z"),
    fetchers: [
      {
        id: "source-a",
        url: SOURCE_URL,
        fetch: async () => {
          throw new NotModified(SOURCE_URL);
        },
      },
    ],
  });
  assert.equal(second.ok, true);
  assert.equal(second.snapshot?.candidates[0]?.id, "acme-thumb");
  assert.equal(
    second.snapshot?.candidates[0]?.lastVerified,
    NOW.toISOString(),
    "304 must not re-stamp the candidate as freshly verified",
  );
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.equal(manifest?.sources["source-a"]?.etag, 'W/"abc"');
  assert.equal(
    manifest?.sources["source-a"]?.lastModified,
    "Mon, 09 Nov 2026 00:00:00 GMT",
  );
});

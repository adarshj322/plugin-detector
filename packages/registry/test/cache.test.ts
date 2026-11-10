import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { NotModified, SourceHttpError } from "../src/sources/http.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  extendedQueries,
  GithubProbeError,
  loadSnapshot,
  MAX_EXTRA_QUERIES,
  normalizeCandidate,
  PackageProbeError,
  probeRawCandidate,
  probeSkillsSh,
  readCacheManifest,
  refreshSnapshot,
  resolveCacheDir,
  SkillsShProbeError,
  type RawCandidate,
} from "../src/index.js";

function artifactProbe(
  id: string = "acme-thumb",
  sourceUrl: string = `https://raw.githubusercontent.com/acme/${id}/HEAD/server.json`,
) {
  return {
    kind: "mcp-server" as const,
    sourceUrl,
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

test("refresh verifies an official publisher only when the artifact was probed", async () => {
  const dir = tmpCache();
  const probe = {
    ...artifactProbe(
      "probed-one",
      "https://raw.githubusercontent.com/anthropics/probed-one/HEAD/server.json",
    ),
    packageName: "@anthropic-ai/probed-one",
  };
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({
          id: "probed-one",
          sourceKind: "community",
          repositoryUrl: "https://github.com/anthropics/probed-one",
          packageName: "@anthropic-ai/probed-one",
          artifactProbe: probe,
        }),
        rawCandidate({
          id: "listing-one",
          sourceKind: "community",
          repositoryUrl: "https://github.com/openai/listing-one",
          packageName: "@openai/listing-one",
          artifactProbe: undefined,
          artifactProbed: false,
        }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  const byId = new Map(
    (result.snapshot?.provenance ?? []).map((entry) => [entry.id, entry.trust]),
  );
  assert.equal(byId.get("probed-one"), "verified");
  assert.equal(byId.get("listing-one"), undefined);
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

test("refresh limit bounds probe calls before probing", async () => {
  const dir = tmpCache();
  let probes = 0;
  const raws = Array.from({ length: 10 }, (_, i) =>
    rawCandidate({ id: `bounded-${i}` }),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    limit: 2,
    probe: async (raw) => {
      probes += 1;
      return raw;
    },
    fetchers: [fetcherOf(SOURCE_URL, raws)],
  });
  assert.equal(probes, 2);
  assert.equal(result.snapshot?.candidates.length, 2);
});

test("refresh limit prioritizes popular candidates before probing", async () => {
  const dir = tmpCache();
  const probed: string[] = [];
  const raws = [
    rawCandidate({ id: "low", popularity: { installs: 10 } }),
    rawCandidate({ id: "high", popularity: { installs: 1_000_000 } }),
    rawCandidate({ id: "mid", popularity: { installs: 5_000 } }),
  ];
  await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    limit: 2,
    probe: async (raw) => {
      probed.push(raw.id ?? "unknown");
      return raw;
    },
    fetchers: [fetcherOf(SOURCE_URL, raws)],
  });
  assert.deepEqual(probed, ["high", "mid"]);
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

test("listing-only candidates stay out of the snapshot and surface in the manifest", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw) => raw,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({
          id: "listing-only",
          artifactProbe: undefined,
          artifactProbed: true,
        }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot?.candidates, []);
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.equal(manifest?.unprobed?.length, 1);
  assert.equal(manifest?.unprobed?.[0]?.id, "listing-only");
  assert.equal(manifest?.unprobed?.[0]?.sourceUrl, SOURCE_URL);
  assert.match(manifest?.unprobed?.[0]?.reason ?? "", /no artifact evidence/i);
  assert.deepEqual(manifest?.rejected ?? [], []);
});

test("a transient probe failure keeps the previous probed candidate", async () => {
  const dir = tmpCache();
  const priorVerifiedAt = "2026-10-01T00:00:00.000Z";
  const prior = normalizeCandidate(
    rawCandidate({ id: "keep-me", lastVerified: priorVerifiedAt }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: SOURCE_URL, trust: "unverified" }],
        new Date(priorVerifiedAt),
      ),
    ),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async () => {
      throw new PackageProbeError(
        "acme-thumb",
        "ARTIFACT_UNAVAILABLE",
        "registry unavailable",
      );
    },
    fetchers: [fetcherOf(SOURCE_URL, [rawCandidate({ id: "keep-me" })])],
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot?.candidates.length, 1);
  const kept = result.snapshot?.candidates[0];
  assert.equal(kept?.id, "keep-me");
  assert.equal(kept?.lastVerified, priorVerifiedAt);
  assert.equal(kept?.artifactEvidence?.contentHash, "a".repeat(64));
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.ok(
    (manifest?.rejected ?? []).some(
      (entry) =>
        entry.id === "keep-me" && entry.reason.includes("registry unavailable"),
    ),
  );
});

test("a hard probe rejection removes the previous verified candidate", async () => {
  const dir = tmpCache();
  const prior = normalizeCandidate(
    rawCandidate({ id: "drop-me", lastVerified: "2026-10-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: SOURCE_URL, trust: "verified" }],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async () => {
      throw new GithubProbeError(
        "drop-me",
        "ARTIFACT_MISMATCH",
        "manifest name does not match the listing",
      );
    },
    fetchers: [fetcherOf(SOURCE_URL, [rawCandidate({ id: "drop-me" })])],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot?.candidates, []);
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.ok(
    (manifest?.rejected ?? []).some(
      (entry) => entry.id === "drop-me" && /ARTIFACT_MISMATCH|match/.test(entry.reason),
    ),
  );
  // The old snapshot must not retain the dropped candidate.
  const written = loadSnapshot({ cacheDir: dir });
  assert.deepEqual(written.candidates, []);
});

test("a hard normalize rejection removes the previous verified candidate", async () => {
  const dir = tmpCache();
  const prior = normalizeCandidate(
    rawCandidate({ id: "archived-prior", lastVerified: "2026-10-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: SOURCE_URL, trust: "verified" }],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw) => raw,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({ id: "archived-prior", maintenance: "archived" }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot?.candidates.some((c) => c.id === "archived-prior"), false);
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.ok(
    (manifest?.rejected ?? []).some((entry) => entry.id === "archived-prior"),
  );
});

test("skills.sh 404/410 hard rejection removes a verified prior candidate", async () => {
  for (const status of [404, 410]) {
    const dir = tmpCache();
    const prior = normalizeCandidate(
      rawCandidate({ id: "skill-gone", lastVerified: "2026-10-01T00:00:00.000Z" }),
    );
    writeFileSync(
      join(dir, "registry-snapshot.json"),
      JSON.stringify(
        buildSnapshot(
          [{ candidate: prior, sourceUrl: SOURCE_URL, trust: "verified" }],
          new Date("2026-10-01T00:00:00.000Z"),
        ),
      ),
    );
    const result = await refreshSnapshot({
      cacheDir: dir,
      now: NOW,
      probe: (raw, sourceId) =>
        probeRawCandidate(raw, sourceId, {
          probeSkillsSh: (listingRaw) =>
            probeSkillsSh(listingRaw, async () => {
              throw new SourceHttpError(
                "https://skills.sh/api/download/acme/skill-gone/skill-gone",
                status,
                false,
                `GET failed with status ${status}`,
              );
            }),
        }),
      fetchers: [
        {
          id: "skills-sh",
          url: SOURCE_URL,
          fetch: async () => ({
            raws: [
              rawCandidate({
                id: "skill-gone",
                artifact: {
                  kind: "skill",
                  file: "SKILL.md",
                  artifactId: "skill-gone",
                },
                artifactProbe: undefined,
                artifactProbed: false,
                repositoryUrl: "https://github.com/acme/skill-gone",
                registryUrl: undefined,
              }),
            ],
          }),
        },
      ],
    });
    assert.equal(result.ok, true, String(status));
    assert.deepEqual(result.snapshot?.candidates, [], String(status));
  }
});

test("cross-source hard probe rejection blocks preservation from every path", async () => {
  const scenarios: Array<{
    name: string;
    fetchB: () => Promise<{ raws: RawCandidate[]; partial?: boolean; failures?: Array<{ query: string; error: string }> }>;
  }> = [
    {
      name: "partial",
      fetchB: async () => ({
        raws: [],
        partial: true,
        failures: [{ query: "q", error: "timeout" }],
      }),
    },
    {
      name: "304",
      fetchB: async () => {
        throw new NotModified("https://example.com/source-b");
      },
    },
    {
      name: "failed",
      fetchB: async () => {
        throw new Error("source down");
      },
    },
  ];
  for (const scenario of scenarios) {
    for (const order of ["a-first", "b-first"] as const) {
      const dir = tmpCache();
      const prior = normalizeCandidate(
        rawCandidate({ id: "cross-id", lastVerified: "2026-10-01T00:00:00.000Z" }),
      );
      writeFileSync(
        join(dir, "registry-snapshot.json"),
        JSON.stringify(
          buildSnapshot(
            [
              {
                candidate: prior,
                sourceUrl: "https://example.com/source-b",
                trust: "verified",
              },
            ],
            new Date("2026-10-01T00:00:00.000Z"),
          ),
        ),
      );
      const fetcherA = {
        id: "source-a",
        url: "https://example.com/source-a",
        fetch: async () => ({ raws: [rawCandidate({ id: "cross-id" })] }),
      };
      const fetcherB = {
        id: "source-b",
        url: "https://example.com/source-b",
        fetch: scenario.fetchB,
      };
      const result = await refreshSnapshot({
        cacheDir: dir,
        now: NOW,
        probe: async () => {
          throw new GithubProbeError(
            "cross-id",
            "ARTIFACT_MISMATCH",
            "artifact changed",
          );
        },
        fetchers: order === "a-first" ? [fetcherA, fetcherB] : [fetcherB, fetcherA],
      });
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.snapshot?.candidates,
        [],
        `${scenario.name}/${order}`,
      );
    }
  }
});

test("cross-source normalize hard rejection also blocks preservation", async () => {
  for (const order of ["a-first", "b-first"] as const) {
    const dir = tmpCache();
    const prior = normalizeCandidate(
      rawCandidate({ id: "cross-normalize", lastVerified: "2026-10-01T00:00:00.000Z" }),
    );
    writeFileSync(
      join(dir, "registry-snapshot.json"),
      JSON.stringify(
        buildSnapshot(
          [
            {
              candidate: prior,
              sourceUrl: "https://example.com/source-b",
              trust: "verified",
            },
          ],
          new Date("2026-10-01T00:00:00.000Z"),
        ),
      ),
    );
    const fetcherA = {
      id: "source-a",
      url: "https://example.com/source-a",
      fetch: async () => ({
        raws: [rawCandidate({ id: "cross-normalize", maintenance: "archived" })],
      }),
    };
    const fetcherB = {
      id: "source-b",
      url: "https://example.com/source-b",
      fetch: async () => ({
        raws: [],
        partial: true,
        failures: [{ query: "q", error: "timeout" }],
      }),
    };
    const result = await refreshSnapshot({
      cacheDir: dir,
      now: NOW,
      probe: async (raw) => raw,
      fetchers: order === "a-first" ? [fetcherA, fetcherB] : [fetcherB, fetcherA],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot?.candidates, [], order);
  }
});

test("a hard reject is only overridden by a fresh probe from another source", async () => {
  const dir = tmpCache();
  const prior = normalizeCandidate(
    rawCandidate({ id: "cross-fresh", lastVerified: "2026-10-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: "https://example.com/source-a", trust: "verified" }],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ),
  );
  const hardSource = {
    id: "source-a",
    url: "https://example.com/source-a",
    fetch: async () => ({ raws: [rawCandidate({ id: "cross-fresh" })] }),
  };
  const listingSource = {
    id: "source-b",
    url: "https://example.com/source-b",
    fetch: async () => ({
      raws: [
        rawCandidate({
          id: "cross-fresh",
          artifactProbe: undefined,
          artifactProbed: false,
        }),
      ],
    }),
  };
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw, sourceId) => {
      if (sourceId === "source-a") {
        throw new GithubProbeError("cross-fresh", "ARTIFACT_MISSING", "gone");
      }
      return raw;
    },
    fetchers: [hardSource, listingSource],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot?.candidates, []);

  const freshSource = {
    id: "source-b",
    url: "https://example.com/source-b",
    fetch: async () => ({ raws: [rawCandidate({ id: "cross-fresh" })] }),
  };
  const rerun = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw, sourceId) => {
      if (sourceId === "source-a") {
        throw new GithubProbeError("cross-fresh", "ARTIFACT_MISSING", "gone");
      }
      return {
        ...raw,
        artifactProbe: artifactProbe("cross-fresh"),
      };
    },
    fetchers: [hardSource, freshSource],
  });
  assert.equal(rerun.ok, true);
  assert.equal(rerun.snapshot?.candidates[0]?.id, "cross-fresh");
});

test("probe memo avoids a duplicate fetch within the same source", async () => {
  const dir = tmpCache();
  let calls = 0;
  const duplicate = rawCandidate({
    id: "memo-id",
    artifactProbe: undefined,
    artifactProbed: false,
  });
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw) => {
      calls += 1;
      return { ...raw, artifactProbe: artifactProbe("memo-id") };
    },
    fetchers: [fetcherOf(SOURCE_URL, [duplicate, duplicate])],
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.snapshot?.candidates.length, 1);
});

test("a partial source keeps prior probed candidates alongside fresh ones", async () => {
  const dir = tmpCache();
  const priorVerifiedAt = "2026-10-01T00:00:00.000Z";
  const prior = normalizeCandidate(
    rawCandidate({ id: "kept-partial", lastVerified: priorVerifiedAt }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: SOURCE_URL, trust: "unverified" }],
        new Date(priorVerifiedAt),
      ),
    ),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      {
        id: "source-a",
        url: SOURCE_URL,
        fetch: async () => ({
          raws: [rawCandidate({ id: "fresh-one" })],
          partial: true,
          failures: [{ query: "video", error: "timeout" }],
        }),
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    (result.snapshot?.candidates.map((c) => c.id) ?? []).sort(),
    ["fresh-one", "kept-partial"],
  );
  const kept = result.snapshot?.candidates.find((c) => c.id === "kept-partial");
  assert.equal(kept?.lastVerified, priorVerifiedAt);
  const manifest = readCacheManifest({ cacheDir: dir });
  assert.equal(manifest?.sources["source-a"]?.partial, true);
  assert.ok(
    manifest?.sources["source-a"]?.failures?.some(
      (failure) => failure.query === "video",
    ),
  );
});

test("a fresh probed entry beats a preserved stale verified entry for the same id", async () => {
  const dir = tmpCache();
  const prior = normalizeCandidate(
    rawCandidate({ id: "dedupe-me", lastVerified: "2026-10-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: "https://example.com/source-a", trust: "verified" }],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ),
  );
  const fresh = rawCandidate({
    id: "dedupe-me",
    sourceKind: "community",
    repositoryUrl: "https://github.com/acme/dedupe-me",
    registryUrl: undefined,
  });
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      {
        id: "source-a",
        url: "https://example.com/source-a",
        fetch: async () => ({
          raws: [],
          partial: true,
          failures: [{ query: "q", error: "timeout" }],
        }),
      },
      {
        id: "source-b",
        url: "https://example.com/source-b",
        fetch: async () => ({ raws: [fresh] }),
      },
    ],
  });
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  assert.equal(snapshot?.candidates.length, 1);
  assert.equal(snapshot?.candidates[0]?.id, "dedupe-me");
  assert.equal(snapshot?.provenance[0]?.trust, "unverified");
  assert.equal(snapshot?.provenance[0]?.sourceUrl, "https://example.com/source-b");
});

test("probe concurrency is bounded at four and keeps input order", async () => {
  const dir = tmpCache();
  let active = 0;
  let maxActive = 0;
  const raws = Array.from({ length: 8 }, (_, i) =>
    rawCandidate({
      id: `concurrent-${i}`,
      artifactProbe: undefined,
      artifactProbed: false,
    }),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        ...raw,
        artifactProbe: artifactProbe(String(raw.id)),
      };
    },
    fetchers: [fetcherOf(SOURCE_URL, raws)],
  });
  assert.equal(result.ok, true);
  assert.equal(maxActive, 4);
  assert.deepEqual(
    result.snapshot?.candidates.map((c) => c.id),
    raws.map((raw) => raw.id).sort() as string[],
  );
});

test("refresh passes the source id to the probe dispatcher", async () => {
  const dir = tmpCache();
  const seen: string[] = [];
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    probe: async (raw, sourceId) => {
      seen.push(sourceId);
      return { ...raw, artifactProbe: artifactProbe(String(raw.id)) };
    },
    fetchers: [
      { id: "skills-sh", url: "https://skills.sh/api/search", fetch: async () => ({ raws: [rawCandidate({ id: "s1", artifactProbe: undefined })] }) },
      { id: "github", url: "https://api.github.com/search/repositories", fetch: async () => ({ raws: [rawCandidate({ id: "g1", artifactProbe: undefined })] }) },
      { id: "mcp-registry", url: "https://registry.modelcontextprotocol.io/v0/servers", fetch: async () => ({ raws: [rawCandidate({ id: "m1", artifactProbe: undefined })] }) },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.sort(), ["github", "mcp-registry", "skills-sh"]);
});

test("limit applies after probed/preserved entries are merged", async () => {
  const dir = tmpCache();
  const prior = normalizeCandidate(
    rawCandidate({ id: "a-prior", lastVerified: "2026-10-01T00:00:00.000Z" }),
  );
  writeFileSync(
    join(dir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: prior, sourceUrl: "https://example.com/source-a", trust: "verified" }],
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ),
  );
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    limit: 1,
    fetchers: [
      {
        id: "source-a",
        url: "https://example.com/source-a",
        fetch: async () => ({
          raws: [],
          partial: true,
          failures: [{ query: "q", error: "timeout" }],
        }),
      },
      {
        id: "source-b",
        url: "https://example.com/source-b",
        fetch: async () => ({ raws: [rawCandidate({ id: "b-fresh" })] }),
      },
    ],
  });
  assert.deepEqual(result.snapshot?.candidates.map((c) => c.id), ["a-prior"]);
});

test("listing packageName cannot attach to matching official repo evidence", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [
      fetcherOf(SOURCE_URL, [
        rawCandidate({
          id: "openai-node",
          sourceKind: "community",
          repositoryUrl: "https://github.com/openai/openai-node",
          packageName: "evil-mcp",
          packageRegistry: "npm",
          artifactProbe: artifactProbe(
            "openai-node",
            "https://raw.githubusercontent.com/openai/openai-node/HEAD/plugin.json",
          ),
          registryUrl: undefined,
        }),
      ]),
    ],
  });
  assert.equal(result.ok, true);
  const candidate = result.snapshot?.candidates[0];
  assert.equal(candidate?.id, "openai-node");
  assert.equal(candidate?.packageName, undefined);
  assert.equal(candidate?.provenance, "community");
  assert.equal(result.snapshot?.provenance[0]?.trust, "unverified");
});

test("extra use-case queries extend both searchable sources", () => {
  const plan = extendedQueries(["video", "Agent", "video"]);
  assert.ok(plan.skillsSh.includes("video"));
  assert.ok(plan.github.includes("video"));
  assert.equal(
    plan.skillsSh.filter((query) => query.toLowerCase() === "video").length,
    1,
  );
  assert.equal(
    plan.github.filter((query) => query.toLowerCase() === "video").length,
    1,
  );
  const extras = Array.from({ length: 30 }, (_, i) => `q${i}`);
  const capped = extendedQueries(extras);
  assert.equal(
    capped.skillsSh.filter((query) => /^q\d+$/.test(query)).length,
    MAX_EXTRA_QUERIES,
  );
  assert.equal(
    capped.github.filter((query) => /^q\d+$/.test(query)).length,
    MAX_EXTRA_QUERIES,
  );
  for (let i = 0; i < MAX_EXTRA_QUERIES; i += 1) {
    assert.ok(capped.skillsSh.includes(`q${i}`));
    assert.ok(capped.github.includes(`q${i}`));
  }
  assert.ok(!capped.skillsSh.includes(`q${MAX_EXTRA_QUERIES}`));
  assert.ok(!capped.github.includes(`q${MAX_EXTRA_QUERIES}`));
});

test("refresh forwards extra queries to the default fetcher factory", async () => {
  const dir = tmpCache();
  let seen: readonly string[] = [];
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    extraQueries: ["video"],
    fetcherFactory: (extra) => {
      seen = extra;
      return [fetcherOf(SOURCE_URL, [rawCandidate()])];
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["video"]);
});

test("all sources returning no candidates does not write an empty snapshot", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [fetcherOf(SOURCE_URL, [])],
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.snapshot?.candidates, []);
  assert.equal(result.written, false);
  assert.equal(existsSync(join(dir, "registry-snapshot.json")), false);
  assert.ok(existsSync(join(dir, "registry-manifest.json")));
});

test("probeRawCandidate dispatches by source and preserves package metadata", async () => {
  const mcpRaw: RawCandidate = rawCandidate({
    id: "io.acme/mcp",
    sourceKind: "community",
    repositoryUrl: "https://github.com/acme/mcp",
    packageName: "@acme/mcp",
    packageRegistry: "npm",
    pinnedRef: "2.0.0",
    registryUrl: undefined,
    artifactProbe: undefined,
    artifactProbed: false,
  });
  let seenOptions: Record<string, unknown> | undefined;
  const probed = await probeRawCandidate(mcpRaw, "mcp-registry", {
    probePackage: async (name, version, opts) => {
      seenOptions = opts as Record<string, unknown>;
      assert.equal(name, "@acme/mcp");
      assert.equal(version, "2.0.0");
      return {
        evidence: {
          ...artifactProbe(
            "@acme/mcp",
            "https://registry.npmjs.org/%40acme%2Fmcp",
          ),
          packageName: "@acme/mcp",
        },
        metadata: {
          registry: "npm",
          name: "@acme/mcp",
          version: "2.0.0",
          license: "MIT",
          maintainers: ["Acme Team"],
          repositoryUrl: "https://github.com/acme/mcp",
          deprecated: "use @acme/mcp-next",
        },
      };
    },
  });
  assert.equal(probed.artifactProbed, true);
  assert.equal(probed.packageRegistry, "npm");
  assert.equal(probed.pinnedRef, "2.0.0");
  assert.deepEqual(probed.maintainers, ["Acme Team"]);
  assert.equal(probed.deprecated, "use @acme/mcp-next");
  assert.equal(seenOptions?.["artifactType"], "mcp-server");
  assert.equal(seenOptions?.["expectedRepository"], "https://github.com/acme/mcp");
  const normalized = normalizeCandidate(probed);
  assert.equal(normalized.packageRegistry, "npm");
  assert.equal(normalized.artifactEvidence?.sourceUrl, "https://registry.npmjs.org/%40acme%2Fmcp");
  assert.deepEqual(normalized.maintainers, ["Acme Team"]);
  assert.equal(normalized.deprecated, "use @acme/mcp-next");

  const skillsRaw: RawCandidate = rawCandidate({
    id: "acme/skill",
    artifactProbe: undefined,
    artifactProbed: false,
  });
  let skillsCalled = 0;
  await probeRawCandidate(skillsRaw, "skills-sh", {
    probeSkillsSh: async (raw) => {
      skillsCalled += 1;
      return { ...raw, artifactProbe: artifactProbe("acme-skill") };
    },
  });
  assert.equal(skillsCalled, 1);

  for (const sourceId of ["github", "awesome-lists"]) {
    let githubCalled = 0;
    await probeRawCandidate(skillsRaw, sourceId, {
      probeGithub: async (raw) => {
        githubCalled += 1;
        return { ...raw, artifactProbe: artifactProbe("acme-skill") };
      },
    });
    assert.equal(githubCalled, 1, sourceId);
  }

  let packageCalled = 0;
  await probeRawCandidate(
    { ...mcpRaw, packageName: undefined, packageRegistry: undefined },
    "mcp-registry",
    {
      probeGithub: async (raw) => {
        packageCalled += 1;
        return { ...raw, artifactProbe: artifactProbe("mcp") };
      },
    },
  );
  assert.equal(packageCalled, 1);

  await assert.rejects(
    probeRawCandidate(
      {
        ...mcpRaw,
        repositoryUrl: undefined,
        packageName: undefined,
        packageRegistry: undefined,
        registryUrl: "https://registry.example.com/no-artifact",
      },
      "mcp-registry",
    ),
    /no package or repository identity/,
  );

  await assert.rejects(
    probeRawCandidate(
      { ...mcpRaw, packageRegistry: undefined },
      "mcp-registry",
    ),
    /registry type/,
  );

  let preProbedCalls = 0;
  const already = rawCandidate({ id: "already-probed" });
  const unchanged = await probeRawCandidate(already, "github", {
    probeGithub: async (raw) => {
      preProbedCalls += 1;
      return raw;
    },
  });
  assert.equal(preProbedCalls, 0);
  assert.equal(unchanged.artifactProbe?.contentHash, "a".repeat(64));
});

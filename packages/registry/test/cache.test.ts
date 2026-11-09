import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { NotModified } from "../src/sources/http.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  extendedQueries,
  loadSnapshot,
  MAX_EXTRA_QUERIES,
  normalizeCandidate,
  probeRawCandidate,
  readCacheManifest,
  refreshSnapshot,
  resolveCacheDir,
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
  const probe = artifactProbe(
    "probed-one",
    "https://raw.githubusercontent.com/anthropics/probed-one/HEAD/server.json",
  );
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

test("a failed probe keeps the previous probed candidate and records the reason", async () => {
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
      throw new Error("probe transport down");
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
        entry.id === "keep-me" && entry.reason.includes("probe transport down"),
    ),
  );
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

test("all sources returning no candidates is a valid empty refresh", async () => {
  const dir = tmpCache();
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: NOW,
    fetchers: [fetcherOf(SOURCE_URL, [])],
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.snapshot?.candidates, []);
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
        evidence: artifactProbe(
          "@acme/mcp",
          "https://registry.npmjs.org/%40acme%2Fmcp",
        ),
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

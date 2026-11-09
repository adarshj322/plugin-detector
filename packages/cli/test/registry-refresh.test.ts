import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles } from "@plugin-detector/profiles";
import type { RefreshOptions, RefreshResult } from "@plugin-detector/registry";
import { registryRefresh } from "../src/commands/registry-refresh.js";

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "pd-cli-refresh-"));
}

function emptyResult(): RefreshResult {
  return {
    ok: true,
    exitCode: 0,
    snapshot: {
      schemaVersion: 1,
      generatedAt: "2026-11-09T00:00:00.000Z",
      candidates: [],
      provenance: [],
    },
    failures: {},
    written: true,
  };
}

test("registry refresh --use-case sends the profile signal queries to refresh", async () => {
  const dir = tmpCache();
  const profile = loadProfiles().find((p) => p.id === "software-development");
  assert.ok(profile, "bundled software-development profile must exist");
  let seen: RefreshOptions | undefined;
  const result = await registryRefresh(
    ["--cache-dir", dir, "--use-case", "software-development"],
    {
      refresh: async (opts) => {
        seen = opts;
        return emptyResult();
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seen?.cacheDir, dir);
  assert.deepEqual(seen?.extraQueries, profile.signalQueries);
});

test("registry refresh rejects an unknown use-case without fetching", async () => {
  let called = 0;
  const result = await registryRefresh(
    ["--use-case", "not-a-profile"],
    {
      refresh: async () => {
        called += 1;
        return emptyResult();
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(called, 0);
  assert.match(result.message, /unknown --use-case/);
});

test("registry refresh without --use-case keeps default query behavior", async () => {
  let seen: RefreshOptions | undefined;
  const result = await registryRefresh([], {
    refresh: async (opts) => {
      seen = opts;
      return emptyResult();
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(seen?.extraQueries, undefined);
});

test("registry refresh reports the snapshot candidate count", async () => {
  const result = await registryRefresh([], {
    refresh: async () => emptyResult(),
  });
  assert.equal(result.message, "registry refreshed 0 candidates");
});

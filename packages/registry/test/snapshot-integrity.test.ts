import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANONICAL_CAPABILITY_IDS } from "@plugin-detector/core";
import { parseSnapshot } from "../src/index.js";

// Committed v1.0 seed: this test guards the reviewed snapshot itself, not the
// refresh pipeline. Regenerate with `registry refresh` + `registry review`.
const SNAPSHOT_URL = new URL("../../data/registry-snapshot.json", import.meta.url);
const SEED_GENERATED_AT = "2026-11-08T00:00:00.000Z";
const MUTABLE_REFS = new Set(["0.0.0", "main", "master", "head", "latest"]);
// Reviewed cap raised from 120 for the 2026-11-22 refresh (166 evidence-backed
// candidates). Recommendation output collapses mirror records by name/kind.
const MAX_CANDIDATES = 200;

const snapshot = parseSnapshot(readFileSync(SNAPSHOT_URL, "utf8"));
const canonical = new Set<string>(CANONICAL_CAPABILITY_IDS);

test("committed snapshot is non-empty and refreshed", () => {
  assert.ok(
    snapshot.candidates.length > 0,
    "snapshot has no candidates; run registry refresh before committing",
  );
  assert.ok(
    snapshot.candidates.length <= MAX_CANDIDATES,
    `snapshot has ${snapshot.candidates.length} candidates, over the reviewed cap of ${MAX_CANDIDATES}`,
  );
  assert.notEqual(
    snapshot.generatedAt,
    SEED_GENERATED_AT,
    "snapshot generatedAt is still the empty seed timestamp",
  );
});

test("every candidate is probed, licensed, pinned, and capability-classified", () => {
  for (const candidate of snapshot.candidates) {
    const evidence = candidate.artifactEvidence;
    assert.ok(evidence, `${candidate.id} has no artifactEvidence`);
    assert.equal(candidate.artifactProbed, true, `${candidate.id} is unprobed`);
    assert.ok(evidence.contentHash.length > 0, `${candidate.id} has no content hash`);
    assert.ok(evidence.license.trim().length > 0, `${candidate.id} has no probed license`);
    assert.ok(candidate.license.trim().length > 0, `${candidate.id} has no candidate license`);
    assert.ok(
      !MUTABLE_REFS.has(candidate.pinnedRef.toLowerCase()),
      `${candidate.id} has mutable or placeholder pin "${candidate.pinnedRef}"`,
    );
    assert.ok(
      candidate.capabilities.length > 0,
      `${candidate.id} has no capabilities`,
    );
    for (const capability of candidate.capabilities) {
      assert.ok(
        canonical.has(capability),
        `${candidate.id} capability "${capability}" is not in the canonical taxonomy`,
      );
    }
    assert.ok(
      ["official", "publisher", "community", "unknown"].includes(
        candidate.provenance,
      ),
      `${candidate.id} has invalid provenance "${candidate.provenance}"`,
    );
  }
});

test("candidate ids and provenance ids are unique and aligned", () => {
  const ids = snapshot.candidates.map((candidate) => candidate.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate candidate ids");
  const provenanceIds = snapshot.provenance.map((entry) => entry.id);
  assert.equal(
    new Set(provenanceIds).size,
    provenanceIds.length,
    "duplicate provenance ids",
  );
  assert.deepEqual(
    [...provenanceIds].sort(),
    [...ids].sort(),
    "provenance ids do not exactly cover candidate ids",
  );
  for (const entry of snapshot.provenance) {
    assert.ok(entry.sourceUrl.startsWith("https://"), `${entry.id} source not https`);
    assert.ok(
      ["verified", "curated", "unverified"].includes(entry.trust),
      `${entry.id} has invalid trust "${entry.trust}"`,
    );
  }
});

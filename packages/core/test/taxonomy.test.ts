import test from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_CAPABILITY_IDS, capabilityId } from "../src/index.js";

const REQUIRED_IDS = [
  "testing.runner",
  "testing.e2e",
  "code-review.quality",
  "code-review.security",
  "planning.orchestration",
  "planning.brainstorm",
  "debugging.systematic",
  "vcs.workflow",
  "ci.release",
  "containers.orchestration",
  "docs.writing",
  "design.frontend",
  "design.thumbnail",
  "data.analysis",
  "media.transcode",
  "speech.captions",
  "publishing.delivery",
  "security.dependencies",
  "harness.management",
];

test("taxonomy contains all v1 stable ids", () => {
  for (const id of REQUIRED_IDS) {
    assert.ok(
      (CANONICAL_CAPABILITY_IDS as readonly string[]).includes(id),
      `missing ${id}`,
    );
  }
});

// v1.0 evidence pipeline additions; every canonical ID stays stable.
const EVIDENCE_IDS = [
  "data.database",
  "browser.automation",
  "search.web",
  "cloud.infra",
  "media.video",
  "media.image",
  "collaboration.chat",
  "memory.context",
];

test("taxonomy includes the v1.0 evidence capability ids", () => {
  const ids = CANONICAL_CAPABILITY_IDS as readonly string[];
  for (const id of EVIDENCE_IDS) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.equal(new Set(ids).size, ids.length, "canonical ids must be unique");
});

test("expanded ids resolve to themselves through capabilityId", () => {
  for (const id of EVIDENCE_IDS) {
    assert.equal(capabilityId(id), id);
    // Separator-blind spelling also resolves to the canonical ID.
    assert.equal(capabilityId(id.replace(/\./g, " ")), id);
  }
});

test("capabilityId matches exact ids case-insensitively", () => {
  assert.equal(capabilityId("testing.runner"), "testing.runner");
  assert.equal(capabilityId("Testing.Runner"), "testing.runner");
  assert.equal(capabilityId("code-review.quality"), "code-review.quality");
});

test("capabilityId normalizes separators and punctuation", () => {
  assert.equal(capabilityId("code review quality"), "code-review.quality");
  assert.equal(capabilityId("code_review-quality"), "code-review.quality");
  assert.equal(capabilityId("design___thumbnail!!"), "design.thumbnail");
});

test("capabilityId resolves explicit aliases", () => {
  assert.equal(capabilityId("e2e"), "testing.e2e");
  assert.equal(capabilityId("thumbnails"), "design.thumbnail");
});

test("capabilityId returns null for unknown or empty input", () => {
  assert.equal(capabilityId("banana.peeling"), null);
  assert.equal(capabilityId(""), null);
  assert.equal(capabilityId("code review"), null);
});

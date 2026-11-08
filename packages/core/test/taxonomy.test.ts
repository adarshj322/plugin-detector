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

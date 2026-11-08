import test from "node:test";
import assert from "node:assert/strict";
import { resolveProfile } from "../src/index.js";

test("video editing in an unrelated python repo asks for corroboration instead of overriding", () => {
  const result = resolveProfile({
    declaration: "video-editing",
    projectSignals: ["python-manifest", "pytest"],
  });
  assert.equal(result.status, "contradiction");
  assert.equal(result.requiresQuestion, true);
});

test("corroborated declaration resolves to match without questions", () => {
  const result = resolveProfile({
    declaration: "software-development",
    projectSignals: ["package-manifest", "pytest"],
  });
  assert.equal(result.status, "match");
  assert.equal(result.requiresQuestion, false);
  assert.equal(result.profile?.id, "software-development");
});

test("contradiction never silently overrides the declaration", () => {
  const result = resolveProfile({
    declaration: "video-editing",
    projectSignals: ["python-manifest", "pytest"],
  });
  assert.equal(result.status, "contradiction");
  // The declared profile stays attached; a different profile is never
  // substituted in, so Task 11 can exit needs-clarification.
  assert.equal(result.profile?.id, "video-editing");
  assert.ok(result.conflictingSignals.length > 0);
});

test("explicit negative signals contradict even a corroborated declaration", () => {
  const result = resolveProfile({
    declaration: "video-editing",
    projectSignals: ["premiere-project", "python-manifest"],
  });
  assert.equal(result.status, "contradiction");
  assert.equal(result.requiresQuestion, true);
});

test("no signals either way is partial, not a contradiction", () => {
  const result = resolveProfile({
    declaration: "research-writing",
    projectSignals: [],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.requiresQuestion, false);
});

test("mixed signals leaning elsewhere stay partial", () => {
  const result = resolveProfile({
    declaration: "software-development",
    projectSignals: ["package-manifest", "terraform-root", "kubernetes-manifest"],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.requiresQuestion, false);
});

test("unknown declaration resolves to unknown without questions", () => {
  const result = resolveProfile({
    declaration: "underwater-basket-weaving",
    projectSignals: ["package-manifest"],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.requiresQuestion, false);
  assert.equal(result.profile, null);
});

test("matching is case- and whitespace-insensitive", () => {
  const result = resolveProfile({
    declaration: "Video-Editing",
    projectSignals: ["  Premiere-Project  "],
  });
  assert.equal(result.status, "match");
  assert.equal(result.requiresQuestion, false);
});

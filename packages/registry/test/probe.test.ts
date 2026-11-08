import test from "node:test";
import assert from "node:assert/strict";
import { probeArtifact, type RawCandidate } from "../src/index.js";

function raw(artifact: RawCandidate["artifact"]): RawCandidate {
  return { artifact };
}

test("null artifact is not found", () => {
  const probe = probeArtifact(raw(null));
  assert.equal(probe.found, false);
  assert.ok(probe.reason);
});

test("SKILL.md probes as skill", () => {
  const probe = probeArtifact(raw({ kind: "skill", file: "SKILL.md" }));
  assert.equal(probe.found, true);
  assert.equal(probe.artifactType, "skill");
  assert.ok(probe.evidence.length > 0);
});

test("mcp manifest probes as mcp-server", () => {
  const probe = probeArtifact(raw({ kind: "mcp", file: "server.json" }));
  assert.equal(probe.found, true);
  assert.equal(probe.artifactType, "mcp-server");
});

test("plugin manifest probes as plugin", () => {
  const probe = probeArtifact(raw({ kind: "plugin", file: "plugin.json" }));
  assert.equal(probe.found, true);
  assert.equal(probe.artifactType, "plugin");
});

test("hooks file probes as hook", () => {
  const probe = probeArtifact(raw({ kind: "hook", file: "hooks.json" }));
  assert.equal(probe.found, true);
  assert.equal(probe.artifactType, "hook");
});

test("marketplace artifact id counts as probe evidence", () => {
  const probe = probeArtifact(
    raw({ kind: "tool", file: "tool.json", artifactId: "mkt-123" }),
  );
  assert.equal(probe.found, true);
  assert.equal(probe.artifactType, "tool");
  assert.ok(probe.evidence.some((e) => e.includes("mkt-123")));
});

test("unknown kind with no recognized file is not found", () => {
  const probe = probeArtifact(raw({ kind: "vibes", file: "vibes.txt" }));
  assert.equal(probe.found, false);
  assert.equal(probe.artifactType, undefined);
});

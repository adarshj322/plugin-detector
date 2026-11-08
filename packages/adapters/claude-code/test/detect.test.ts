import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/claude-code", import.meta.url),
);
const home = (name: string): string => path.join(FIXTURES, name, "home");
const project = (name: string): string => path.join(FIXTURES, name, "project");
const adapterFor = (name: string): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter({ root: project(name), home: home(name) });

test("empty harness is not detected", async () => {
  const adapter = adapterFor("empty");
  const result = await adapter.detect();
  assert.equal(result.detected, false);
  assert.equal(result.harness, "claude-code");
});

test("plugin fixture is detected with global config evidence", async () => {
  const adapter = adapterFor("plugins-scopes");
  const result = await adapter.detect();
  assert.equal(result.detected, true);
  assert.ok(result.evidence.some((entry) => entry.endsWith(".claude.json")));
});

test("hooks fixture is detected via project settings evidence", async () => {
  const adapter = adapterFor("hooks-commands");
  const result = await adapter.detect();
  assert.equal(result.detected, true);
  assert.ok(result.evidence.some((entry) => entry.endsWith("settings.json")));
});

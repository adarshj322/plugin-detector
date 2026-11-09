import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/codex", import.meta.url),
);
const home = (name: string): string => path.join(FIXTURES, name, "home");
const project = (name: string): string => path.join(FIXTURES, name, "project");
const adapterFor = (name: string): CodexAdapter =>
  new CodexAdapter({ root: project(name), home: home(name) });

test("empty harness is not detected", async () => {
  const adapter = adapterFor("empty");
  const result = await adapter.detect();
  assert.equal(result.detected, false);
  assert.equal(result.harness, "codex");
});

test("config.toml fixture is detected with config evidence", async () => {
  const adapter = adapterFor("full");
  const result = await adapter.detect();
  assert.equal(result.detected, true);
  assert.ok(result.evidence.some((entry) => entry.endsWith("config.toml")));
});

test("credentials file counts as evidence but is never parsed", async () => {
  const adapter = adapterFor("full");
  const result = await adapter.detect();
  assert.ok(result.evidence.some((entry) => entry.endsWith("auth.json")));
});

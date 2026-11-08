import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter } from "../src/index.js";

const FIXTURES = fileURLToPath(
  new URL("../../../../../fixtures/opencode", import.meta.url),
);
const fixture = (name: string): string => path.join(FIXTURES, name);

test("empty harness is not detected", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("empty") });
  const result = await adapter.detect();
  assert.equal(result.detected, false);
  assert.equal(result.harness, "opencode");
});

test("npm plugin entry is detected with config evidence", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("npm-plugin") });
  const result = await adapter.detect();
  assert.equal(result.detected, true);
  assert.ok(result.evidence.some((entry) => entry.endsWith("opencode.json")));
});

test("local plugin file is detected", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("local-plugin") });
  const result = await adapter.detect();
  assert.equal(result.detected, true);
});

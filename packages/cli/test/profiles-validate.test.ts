import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProfile } from "../src/commands/profiles-validate.js";

async function capture(run: () => Promise<unknown>): Promise<{
  logs: string[];
  errors: string[];
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

const VALID = `id: probe-profile
version: 1
displayName: Probe
description: Probe profile for validation tests.
capabilities:
  - testing.runner
signalQueries:
  - package-manifest
  - tsconfig
  - eslint-config
  - pytest
  - python-manifest
negativeSignals:
  - premiere-project
defaultDomains:
  - coding
expectedValueTiers:
  - time-saved
`;

test("valid profile file exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-validate-"));
  const file = join(dir, "probe.yaml");
  writeFileSync(file, VALID);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await validateProfile([file])).exitCode;
  });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /probe-profile.*valid/);
});

test("invalid profile prints a field table and exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-validate-"));
  const file = join(dir, "bad.yaml");
  writeFileSync(file, "id: bad\nversion: not-a-number\n");
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await validateProfile([file])).exitCode;
  });
  assert.equal(code, 1);
  const text = logs.join("\n");
  assert.match(text, /field.*error/i);
  assert.match(text, /version/);
});

test("missing file exits 1 without network", async () => {
  let code = -1;
  const { errors } = await capture(async () => {
    code = (await validateProfile([join(tmpdir(), "pd-no-such.yaml")])).exitCode;
  });
  assert.equal(code, 1);
  assert.ok(errors.join("\n").length > 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfileFile } from "@plugin-detector/profiles";
import { initProfile } from "../src/commands/profiles-init.js";
import { listProfiles } from "../src/commands/profiles-list.js";
import { main } from "../src/index.js";

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

test("profiles init writes a valid starter profile with a custom threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-profiles-init-"));
  const file = join(dir, "my-workflow.yaml");
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await initProfile([file])).exitCode;
  });
  assert.equal(code, 0);
  const profile = loadProfileFile(file);
  assert.equal(profile.id, "my-workflow");
  assert.equal(profile.requiredThreshold, 10);
  assert.match(logs.join("\n"), /profiles validate/);
  assert.match(logs.join("\n"), /recommend --profile/);
});

test("profiles init refuses to overwrite an existing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-profiles-init-"));
  const file = join(dir, "existing.yaml");
  writeFileSync(file, "do not replace me");
  let code = -1;
  const { errors } = await capture(async () => {
    code = (await initProfile([file])).exitCode;
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /refusing to overwrite/);
  assert.equal(readFileSync(file, "utf8"), "do not replace me");
});

test("profiles list prints built-in ids and display names", async () => {
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await listProfiles()).exitCode;
  });
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.match(text, /software-development\tSoftware Development/);
  assert.match(text, /video-editing\tVideo Editing/);
  assert.match(text, /research-writing\tResearch Writing/);
});

test("main dispatches profiles list", async () => {
  let code = -1;
  const { logs } = await capture(async () => {
    code = await main(["profiles", "list"]);
  });
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /software-development/);
});

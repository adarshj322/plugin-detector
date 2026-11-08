import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { inventory } from "../src/commands/inventory.js";
import { InventoryJsonSchema } from "../src/output.js";

function fixtureTree(): { home: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "pd-inventory-"));
  const home = join(base, "home");
  const root = join(base, "root");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root };
}

function hashTree(dir: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

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

test("empty harness tree yields empty inventories for all four harnesses", async () => {
  const { home, root } = fixtureTree();
  const before = hashTree(home) + hashTree(root);
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--json"]),
  );
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.harnesses.length, 4);
  for (const entry of parsed.facts.harnesses) {
    assert.equal(entry.detected, false);
    assert.deepEqual(entry.records, []);
    assert.equal(entry.enabled, 0);
    assert.equal(entry.disabled, 0);
  }
  assert.equal(hashTree(home) + hashTree(root), before);
});

test("human inventory prints per-harness counts without touching the tree", async () => {
  const { home, root } = fixtureTree();
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ plugin: ["opencode-test-plugin"] }),
  );
  const before = hashTree(home) + hashTree(root);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await inventory(["--home", home, "--root", root])).exitCode;
  });
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.match(text, /facts:/);
  assert.match(text, /opencode/);
  assert.match(text, /enabled=1/);
  assert.match(text, /opencode\.json/);
  assert.equal(hashTree(home) + hashTree(root), before);
});

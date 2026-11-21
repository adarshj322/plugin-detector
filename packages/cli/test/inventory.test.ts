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

test("inventory stays offline unless --check-updates is explicit", async () => {
  const { home, root } = fixtureTree();
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ plugin: ["opencode-test-plugin@1.2.3"] }),
  );
  let calls = 0;
  const resolveLatest = async (): Promise<null> => {
    calls += 1;
    return null;
  };
  const before = hashTree(home) + hashTree(root);
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--json"], { resolveLatest }),
  );
  assert.equal(calls, 0, "the default inventory path must not resolve versions");
  assert.equal(hashTree(home) + hashTree(root), before);
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  const record = parsed.facts.harnesses
    .flatMap((h) => h.records)
    .find((r) => r.kind === "plugin");
  assert.equal(record?.latestVersion, undefined);
});

test("--check-updates attaches latest evidence to every resolvable record", async () => {
  const { home, root } = fixtureTree();
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ plugin: ["opencode-test-plugin@1.2.3"] }),
  );
  const seen: string[] = [];
  const resolveLatest = async (input: {
    sourceRef?: string | undefined;
  }): Promise<{ version: string; sourceUrl: string }> => {
    seen.push(input.sourceRef ?? "");
    return {
      version: "2.0.0",
      sourceUrl: "https://registry.npmjs.org/opencode-test-plugin",
    };
  };
  const { logs } = await capture(() =>
    inventory(
      ["--home", home, "--root", root, "--check-updates", "--json"],
      { resolveLatest },
    ),
  );
  assert.deepEqual(seen, ["opencode-test-plugin@1.2.3"]);
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  const record = parsed.facts.harnesses
    .flatMap((h) => h.records)
    .find((r) => r.kind === "plugin");
  assert.equal(record?.latestVersion, "2.0.0");
  assert.equal(
    record?.latestSource,
    "https://registry.npmjs.org/opencode-test-plugin",
  );
  assert.equal(record?.updateStatus, "unknown");
});

test("--check-updates reports upstream versions in human output", async () => {
  const { home, root } = fixtureTree();
  writeFileSync(
    join(root, "opencode.json"),
    JSON.stringify({ plugin: ["opencode-test-plugin@1.2.3"] }),
  );
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--check-updates"], {
      resolveLatest: async () => ({
        version: "2.0.0",
        sourceUrl: "https://registry.npmjs.org/opencode-test-plugin",
      }),
    }),
  );
  assert.match(logs.join("\n"), /latest=2\.0\.0/);
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

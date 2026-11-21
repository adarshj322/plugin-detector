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
import type { CapabilityRecord } from "@plugin-detector/core";
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
    inventory(["--home", home, "--root", root, "--json"], {
      externalTools: () => [],
    }),
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
    inventory(["--home", home, "--root", root, "--json"], {
      resolveLatest,
      externalTools: () => [],
    }),
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
      { resolveLatest, externalTools: () => [] },
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
      externalTools: () => [],
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
    code = (
      await inventory(["--home", home, "--root", root], {
        externalTools: () => [],
      })
    ).exitCode;
  });
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.match(text, /facts:/);
  assert.match(text, /opencode/);
  assert.match(text, /enabled=1/);
  assert.match(text, /opencode\.json/);
  assert.equal(hashTree(home) + hashTree(root), before);
});

function externalGitRecord(): CapabilityRecord {
  return {
    id: "external:cli:git",
    name: "git",
    harness: "unknown",
    kind: "cli",
    capabilities: ["vcs.workflow"],
    enabled: true,
    configRefs: [],
    contextCostClass: "zero",
    version: "2.43.0",
    sourceRef: "PATH:git",
    installPath: "/usr/bin/git",
  };
}

test("inventory merges curated external CLI records", async () => {
  const { home, root } = fixtureTree();
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--json"], {
      externalTools: () => [externalGitRecord()],
    }),
  );
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  const external = parsed.facts.harnesses.find(
    (entry) => entry.harness === "external",
  );
  assert.ok(external, "external CLI group is present");
  assert.equal(external.detected, true);
  assert.deepEqual(external.records, [externalGitRecord()]);
});

test("--skip-external bypasses the curated CLI probe", async () => {
  const { home, root } = fixtureTree();
  let called = 0;
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--skip-external", "--json"], {
      externalTools: () => {
        called += 1;
        return [externalGitRecord()];
      },
    }),
  );
  assert.equal(called, 0);
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(
    parsed.facts.harnesses.some((entry) => entry.harness === "external"),
    false,
  );
});

test("--check-updates leaves PATH-sourced CLIs to manual review", async () => {
  const { home, root } = fixtureTree();
  const seen: string[] = [];
  const { logs } = await capture(() =>
    inventory(["--home", home, "--root", root, "--check-updates", "--json"], {
      resolveLatest: async (input) => {
        seen.push(input.sourceRef ?? "");
        return null;
      },
      externalTools: () => [externalGitRecord()],
    }),
  );
  const parsed = InventoryJsonSchema.parse(JSON.parse(logs.join("\n")));
  const record = parsed.facts.harnesses
    .flatMap((entry) => entry.records)
    .find((entry) => entry.kind === "cli");
  assert.deepEqual(seen, []);
  assert.equal(record?.latestVersion, undefined);
  assert.equal(record?.updateStatus, undefined);
});

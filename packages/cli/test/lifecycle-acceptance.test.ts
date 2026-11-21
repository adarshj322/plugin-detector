import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { buildSnapshot } from "@plugin-detector/registry";
import type { Candidate, CapabilityRecord } from "@plugin-detector/core";
import { recommend } from "../src/commands/recommend.js";
import { RecommendJsonSchema } from "../src/output.js";

const SUPERPOWERS_CAPS = [
  "planning.brainstorm",
  "testing.runner",
  "debugging.systematic",
  "code-review.quality",
  "vcs.workflow",
];

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    name: `Candidate ${id}`,
    artifactType: "plugin",
    sources: [`https://github.com/acme/${id}`],
    useCaseDomains: ["software-development"],
    capabilities: ["code-review.quality"],
    license: "MIT",
    pinnedRef: "v2.0.0",
    repositoryUrl: `https://github.com/acme/${id}`,
    packageName: id,
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    artifactProbed: true,
    artifactEvidence: {
      kind: "plugin",
      sourceUrl: `https://github.com/acme/${id}`,
      resolvedRef: "v2.0.0",
      contentHash: "a".repeat(64),
      license: "MIT",
      name: id,
      version: "2.0.0",
      capabilities: [],
      evidenceSnippets: [`name: ${id}`],
      retrievedAt: "2026-11-01T00:00:00.000Z",
    },
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
    ...overrides,
  };
}

const SUPERPOWERS_CLONE = candidate("superpowers-clone", {
  name: "superpowers-clone",
  capabilities: SUPERPOWERS_CAPS,
});

const NEW_REVIEW = candidate("new-review", {
  name: "new-review",
  capabilities: ["code-review.quality", "code-review.security"],
});

const DATA_TOOL = candidate("data-tool", {
  name: "data-tool",
  artifactType: "tool",
  capabilities: ["data.analysis", "docs.writing"],
});

// Same curated shape as detectExternalTools: host PATH entry, unknown harness,
// `cli` kind. No candidate artifact type is `cli`, so it can never be replaced.
const EXTERNAL_JQ: CapabilityRecord = {
  id: "external:cli:jq",
  name: "jq",
  harness: "unknown",
  kind: "cli",
  capabilities: ["data.analysis"],
  enabled: true,
  configRefs: [],
  contextCostClass: "zero",
  version: "1.7",
  sourceRef: "PATH:jq",
  installPath: "/usr/bin/jq",
};

interface Fixture {
  home: string;
  root: string;
  cache: string;
}

function setup(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "pd-lifecycle-acceptance-"));
  const home = join(base, "home");
  const root = join(base, "root");
  const cache = join(base, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return { home, root, cache };
}

function writeInstalledPlugin(
  root: string,
  name: string,
  version: string,
): void {
  const dir = join(root, ".opencode", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version }),
  );
}

function writeSnapshot(cache: string, candidates: Candidate[]): void {
  const snapshot = buildSnapshot(
    candidates.map((entry) => ({
      candidate: entry,
      sourceUrl: entry.sources[0] ?? "",
    })),
    new Date("2026-11-08T00:00:00.000Z"),
  );
  writeFileSync(join(cache, "registry-snapshot.json"), JSON.stringify(snapshot));
}

function harnessFixture(env: Fixture): void {
  writeFileSync(
    join(env.root, "opencode.json"),
    JSON.stringify({ plugin: ["superpowers@1.0.0", "code-review@1.0.0"] }),
  );
  writeInstalledPlugin(env.root, "superpowers", "1.0.0");
  writeInstalledPlugin(env.root, "code-review", "1.0.0");
  writeSnapshot(env.cache, [SUPERPOWERS_CLONE, NEW_REVIEW, DATA_TOOL]);
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

async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = origLog;
  }
  return logs;
}

function baseArgs(env: Fixture): string[] {
  return [
    "--use-case",
    "software-development",
    "--signal",
    "package-manifest",
    "--signal",
    "pytest",
    "--cache-dir",
    env.cache,
    "--home",
    env.home,
    "--root",
    env.root,
  ];
}

const resolveLatest = async (input: {
  sourceRef?: string | undefined;
}): Promise<{ version: string; sourceUrl: string } | null> =>
  input.sourceRef?.startsWith("code-review@")
    ? { version: "1.1.0", sourceUrl: "https://example.com/code-review" }
    : null;

async function runAcceptance(
  env: Fixture,
): Promise<ReturnType<typeof RecommendJsonSchema.parse>> {
  const logs = await capture(() =>
    recommend([...baseArgs(env), "--check-updates", "--json"], {
      resolveLatest,
      externalTools: () => [EXTERNAL_JQ],
    }),
  );
  return RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
}

test("acceptance: installed superpowers beats a same-capability clone", async () => {
  const env = setup();
  harnessFixture(env);
  const parsed = await runAcceptance(env);
  const lifecycle = parsed.facts.lifecycle ?? [];
  const row = lifecycle.find(
    (entry) => entry.installedId === "opencode:plugin:project:superpowers",
  );
  assert.equal(row?.action, "keep");
  assert.equal(row?.candidateId, undefined);
  assert.equal(row?.recipe, undefined);
  assert.ok((row?.reasons.length ?? 0) > 0);

  const clone = parsed.facts.recommendations.find(
    (entry) => entry.candidateId === SUPERPOWERS_CLONE.id,
  );
  assert.equal(clone?.verdict, "redundant");
});

test("acceptance: older review plugin is replaced only by a superset", async () => {
  const env = setup();
  harnessFixture(env);
  const parsed = await runAcceptance(env);
  const lifecycle = parsed.facts.lifecycle ?? [];
  const row = lifecycle.find(
    (entry) => entry.installedId === "opencode:plugin:project:code-review",
  );
  assert.equal(row?.action, "replace");
  assert.equal(row?.candidateId, NEW_REVIEW.id);
  assert.deepEqual(row?.capabilitiesAdded, ["code-review.security"]);
  assert.ok(
    row?.recipe !== undefined && row.recipe.length > 0,
    "replace row carries a print-only recipe",
  );
  assert.ok(
    row.recipe.some((step) => step.includes("remove")),
    "the recipe removes the old plugin first",
  );

  // Only the superset candidate claims a replacement; the clone stays keep.
  assert.deepEqual(
    lifecycle
      .filter((entry) => entry.action === "replace")
      .map((entry) => [entry.installedId, entry.candidateId]),
    [["opencode:plugin:project:code-review", NEW_REVIEW.id]],
  );
});

test("acceptance: curated external CLI stays keep with no candidate", async () => {
  const env = setup();
  harnessFixture(env);
  const parsed = await runAcceptance(env);
  const lifecycle = parsed.facts.lifecycle ?? [];
  const external = lifecycle.filter((entry) =>
    entry.installedId.startsWith("external:cli:"),
  );
  assert.equal(external.length, 1);
  assert.equal(external[0]?.installedId, "external:cli:jq");
  assert.equal(external[0]?.action, "keep");
  assert.equal(external[0]?.candidateId, undefined);
  assert.equal(external[0]?.recipe, undefined);
  assert.equal(external[0]?.installedVersion, "1.7");
  assert.ok(
    external[0]?.reasons.some((reason) => reason.includes("installed kind cli")),
    "a tool candidate cannot replace a CLI artifact",
  );
});

test("acceptance: the fixture run writes nothing", async () => {
  const env = setup();
  harnessFixture(env);
  const before = [hashTree(env.home), hashTree(env.root), hashTree(env.cache)];
  await runAcceptance(env);
  assert.deepEqual(
    [hashTree(env.home), hashTree(env.root), hashTree(env.cache)],
    before,
  );
});

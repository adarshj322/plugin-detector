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
import { buildSnapshot } from "@plugin-detector/registry";
import type { Candidate } from "@plugin-detector/core";
import { recommend } from "../src/commands/recommend.js";
import { RecommendJsonSchema } from "../src/output.js";

const PROFILE_CAPS = [
  "testing.runner",
  "testing.e2e",
  "code-review.quality",
  "code-review.security",
  "debugging.systematic",
  "vcs.workflow",
  "docs.writing",
];

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    name: `Candidate ${id}`,
    artifactType: "skill",
    sources: [`https://example.com/${id}`],
    useCaseDomains: ["software-development"],
    capabilities: [PROFILE_CAPS[Number(id.slice(-1)) ?? 0] ?? "testing.runner"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: `https://example.com/${id}`,
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
    ...overrides,
  };
}

function setup(): { home: string; root: string; cache: string } {
  const base = mkdtempSync(join(tmpdir(), "pd-recommend-"));
  const home = join(base, "home");
  const root = join(base, "root");
  const cache = join(base, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return { home, root, cache };
}

function writeSnapshot(cache: string, candidates: Candidate[]): void {
  const snapshot = buildSnapshot(
    candidates.map((c) => ({ candidate: c, sourceUrl: c.sources[0] ?? "" })),
    new Date("2026-11-08T00:00:00.000Z"),
  );
  writeFileSync(join(cache, "registry-snapshot.json"), JSON.stringify(snapshot));
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

function baseArgs(env: { home: string; root: string; cache: string }): string[] {
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

test("seven eligible candidates emit at most five, sorted, with zero writes", async () => {
  const env = setup();
  writeSnapshot(
    env.cache,
    Array.from({ length: 7 }, (_, i) => candidate(`cand-${i + 1}`)),
  );
  const before = hashTree(env.home) + hashTree(env.root) + hashTree(env.cache);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await recommend([...baseArgs(env), "--json"])).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.recommendations.length, 5);
  const scores = parsed.facts.recommendations.map((r) => r.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  for (const rec of parsed.facts.recommendations) {
    assert.notEqual(rec.verdict, "risky");
    assert.ok(rec.evidencePointers.length > 0);
  }
  assert.equal(parsed.facts.verdict, "required");
  assert.equal(hashTree(env.home) + hashTree(env.root) + hashTree(env.cache), before);
});

test("empty snapshot emits the exact no-good-candidates verdict", async () => {
  const env = setup();
  writeSnapshot(env.cache, []);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await recommend([...baseArgs(env), "--json"])).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.verdict, "no-good-candidates");
  assert.deepEqual(parsed.facts.recommendations, []);
  assert.match(logs.join("\n"), /No good candidates found\./);
});

test("contradiction exits 3 with needs-clarification and no candidates", async () => {
  const env = setup();
  writeSnapshot(env.cache, [candidate("cand-1")]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await recommend([
        "--use-case",
        "video-editing",
        "--signal",
        "python-manifest",
        "--signal",
        "pytest",
        "--cache-dir",
        env.cache,
        "--home",
        env.home,
        "--root",
        env.root,
        "--json",
      ])
    ).exitCode;
  });
  assert.equal(code, 3);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.profileStatus, "contradiction");
  assert.deepEqual(parsed.facts.recommendations, []);
  assert.ok(!logs.join("\n").includes("cand-1"));
});

test("unknown use case exits 2 listing valid ids", async () => {
  const env = setup();
  let code = -1;
  const { errors } = await capture(async () => {
    code = (await recommend(["--use-case", "nope", "--home", env.home])).exitCode;
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /software-development/);
});

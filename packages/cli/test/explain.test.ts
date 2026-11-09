import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "@plugin-detector/registry";
import type { Candidate } from "@plugin-detector/core";
import { explain } from "../src/commands/explain.js";
import { ExplainJsonSchema } from "../src/output.js";

function setup(): { home: string; root: string; cache: string } {
  const base = mkdtempSync(join(tmpdir(), "pd-explain-"));
  const home = join(base, "home");
  const root = join(base, "root");
  const cache = join(base, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return { home, root, cache };
}

const CANDIDATE: Candidate = {
  id: "cand-explain",
  name: "Explain Candidate",
  artifactType: "skill",
  sources: ["https://example.com/cand-explain"],
  useCaseDomains: ["software-development"],
  capabilities: ["testing.runner"],
  license: "MIT",
  pinnedRef: "v2.1.0",
  repositoryUrl: "https://example.com/cand-explain",
  installMode: "verified",
  lastVerified: "2026-11-01T00:00:00.000Z",
  provenance: "official",
  risk: "low",
  maintenance: "active",
  auditStatus: "clean",
  popularity: { stars: 42 },
  rawUntrustedCopy: "SECRET-UNTRUSTED-MARKER buy now!!!",
};

function writeSnapshot(cache: string): void {
  const snapshot = buildSnapshot(
    [{ candidate: CANDIDATE, sourceUrl: "https://example.com/cand-explain" }],
    new Date("2026-11-08T00:00:00.000Z"),
  );
  writeFileSync(join(cache, "registry-snapshot.json"), JSON.stringify(snapshot));
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

test("explain prints pinned ref, trust, components, overlap, risk, and age", async () => {
  const env = setup();
  writeSnapshot(env.cache);
  // Installed record sharing the candidate capability, for overlap output.
  mkdirSync(join(env.root, ".opencode", "skills", "testing-runner"), {
    recursive: true,
  });
  writeFileSync(
    join(env.root, ".opencode", "skills", "testing-runner", "SKILL.md"),
    "---\nname: testing-runner\ndescription: t\n---\n# t\n",
  );
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await explain([
        "cand-explain",
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
  assert.equal(code, 0);
  const parsed = ExplainJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.pinnedRef, "v2.1.0");
  assert.equal(parsed.facts.trust, "unverified");
  assert.ok(parsed.facts.score.score >= 0);
  assert.ok(parsed.facts.overlapRecords.length > 0);
  const text = logs.join("\n");
  for (const needle of [
    "v2.1.0",
    "https://example.com/cand-explain",
    "relevance",
    "testing.runner",
    "low",
    "2026-11-08",
  ]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  assert.ok(!text.includes("SECRET-UNTRUSTED-MARKER"));
});

test("rawUntrustedCopy appears only with --show-untrusted behind a warning", async () => {
  const env = setup();
  writeSnapshot(env.cache);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await explain([
        "cand-explain",
        "--cache-dir",
        env.cache,
        "--home",
        env.home,
        "--root",
        env.root,
        "--show-untrusted",
      ])
    ).exitCode;
  });
  assert.equal(code, 0);
  const text = logs.join("\n");
  assert.match(text, /WARNING.*untrusted/i);
  assert.ok(text.includes("SECRET-UNTRUSTED-MARKER"));
});

test("unknown candidate id exits 1", async () => {
  const env = setup();
  writeSnapshot(env.cache);
  let code = -1;
  await capture(async () => {
    code = (
      await explain(["missing-id", "--cache-dir", env.cache, "--home", env.home])
    ).exitCode;
  });
  assert.equal(code, 1);
});

test("explain surfaces a risky verdict for a hard-gated candidate", async () => {
  const env = setup();
  const risky = { ...CANDIDATE, auditStatus: "critical" as const };
  const snapshot = buildSnapshot(
    [{ candidate: risky, sourceUrl: "https://example.com/cand-explain" }],
    new Date("2026-11-08T00:00:00.000Z"),
  );
  writeFileSync(
    join(env.cache, "registry-snapshot.json"),
    JSON.stringify(snapshot),
  );
  const { logs } = await capture(() =>
    explain([
      "cand-explain",
      "--cache-dir",
      env.cache,
      "--home",
      env.home,
      "--root",
      env.root,
      "--json",
    ]),
  );
  const parsed = ExplainJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.verdict, "risky");
});

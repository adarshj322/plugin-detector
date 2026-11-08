import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CursorAdapter } from "@plugin-detector/cursor";
import { scoreCandidate } from "@plugin-detector/core";
import { OpenCodeAdapter } from "@plugin-detector/opencode";
import {
  buildSnapshot,
  loadSnapshot,
  normalizeCandidate,
  refreshSnapshot,
  type RawCandidate,
} from "@plugin-detector/registry";
import {
  formatRedTeamReport,
  runRedTeamFixtures,
  type RedTeamResult,
} from "../src/red-team.js";

// Resolves to fixtures/red-team both from src (ts) and dist (js).
const FIXTURE_ROOT = fileURLToPath(new URL("../../../../fixtures/red-team", import.meta.url));

function byName(results: RedTeamResult[], fixture: string): RedTeamResult {
  const found = results.find((result) => result.fixture === fixture);
  assert.ok(found, `missing fixture result for ${fixture}`);
  return found;
}

test("no hostile fixture yields a required automatic install", () => {
  const results = runRedTeamFixtures({ fixtureRoot: FIXTURE_ROOT });
  assert.ok(results.length >= 10, `expected 10 fixtures, saw ${results.length}`);
  const offenders = results.filter((result) => result.outcome === "actionable");
  assert.deepEqual(
    offenders.map((result) => result.fixture),
    [],
    `actionable fixtures:\n${formatRedTeamReport(offenders)}`,
  );
  console.log(formatRedTeamReport(results));
});

test("intake rejects injection, squats, confusion, hooks, archived, and stale", () => {
  const results = runRedTeamFixtures({ fixtureRoot: FIXTURE_ROOT });
  for (const fixture of [
    "prompt-injection-readme.json",
    "typo-squat.json",
    "dependency-confusion.json",
    "malicious-postinstall.json",
    "archived-popular.json",
    "stale-audit.json",
  ]) {
    assert.equal(byName(results, fixture).outcome, "rejected", fixture);
  }
  assert.match(
    byName(results, "prompt-injection-readme.json").notes.join("\n"),
    /prompt-injection/,
  );
  assert.match(
    byName(results, "malicious-postinstall.json").notes.join("\n"),
    /install hook/,
  );
});

test("silent drift re-flags for re-review instead of auto-installing", () => {
  const results = runRedTeamFixtures({ fixtureRoot: FIXTURE_ROOT });
  for (const fixture of ["repo-renamed.json", "capability-drift.json"]) {
    const result = byName(results, fixture);
    assert.equal(result.outcome, "contained", fixture);
    assert.equal(result.drifted, true, fixture);
    assert.ok((result.driftReasons ?? []).length > 0, fixture);
    assert.equal(result.trust, "unverified", fixture);
    assert.equal(result.installKind, "recipe", fixture);
  }
  assert.match(
    (byName(results, "repo-renamed.json").driftReasons ?? []).join("\n"),
    /repositoryUrl/,
  );
  assert.match(
    (byName(results, "capability-drift.json").driftReasons ?? []).join("\n"),
    /capabilities changed/,
  );
});

test("shell/exec copy suppresses trusted handling to recipe-only", () => {
  const results = runRedTeamFixtures({ fixtureRoot: FIXTURE_ROOT });
  const result = byName(results, "mcp-shell-exec.json");
  assert.equal(result.outcome, "contained");
  assert.equal(result.trust, "unverified");
  assert.equal(result.installKind, "recipe");
});

test("impossible Cursor auto-install claim stays recipe-only", async () => {
  const results = runRedTeamFixtures({ fixtureRoot: FIXTURE_ROOT });
  const result = byName(results, "cursor-auto-install-claim.json");
  assert.equal(result.outcome, "contained");
  assert.equal(result.installKind, "recipe");
  const adapter = new CursorAdapter();
  const raw = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "cursor-auto-install-claim.json"), "utf8"),
  ) as { raw: RawCandidate };
  const candidate = normalizeCandidate(raw.raw);
  const plan = adapter.installPlan(candidate, result.trust ?? "unverified");
  assert.ok(plan.operations.every((op) => op.kind === "recipe"));
  await assert.rejects(adapter.applyPlan(plan), /unverified/);
});

test("prompt-injection text never reaches scoring", () => {
  const injected = readFileSync(
    join(FIXTURE_ROOT, "prompt-injection-readme.md"),
    "utf8",
  );
  assert.match(injected, /ignore all previous instructions/i);
  const raw = JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "prompt-injection-readme.json"), "utf8"),
  ) as RawCandidate;
  const clean = normalizeCandidate({ ...raw, readme: "Scaffold fast unit tests." });
  const base = scoreCandidate({
    candidate: clean,
    installedCapabilities: [],
    profileDomains: [...clean.capabilities],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  const tainted = scoreCandidate({
    candidate: { ...clean, rawUntrustedCopy: `[untrusted display-only] ${injected}` },
    installedCapabilities: [],
    profileDomains: [...clean.capabilities],
    harness: "opencode",
    useCaseMatch: 1,
    projectSignalMatch: 1,
  });
  assert.deepEqual(
    { verdict: tainted.verdict, score: tainted.score, reasoning: tainted.reasoning },
    { verdict: base.verdict, score: base.score, reasoning: base.reasoning },
  );
  assert.ok(!tainted.reasoning.includes("evil.example"));
  assert.ok(!tainted.reasoning.toLowerCase().includes("ignore all previous instructions"));
  assert.ok(!tainted.evidencePointers.join("\n").includes("evil.example"));
});

test("refresh path demotes drifted/shell-exec trust and yields recipe-only plans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-redteam-refresh-"));
  const sourceUrl = "https://example.com/redteam-source";
  const seedRaw: RawCandidate = {
    id: "rt-refresh-drift",
    name: "Refresh Drifter",
    artifact: {
      kind: "skill",
      file: "SKILL.md",
      capabilities: ["testing.runner"],
      domains: ["software-development"],
    },
    sourceKind: "official-registry",
    pinnedRef: "v2.1.0",
    license: "MIT",
    registryUrl: "https://example.com/rt-refresh-drift",
    maintenance: "active",
    auditStatus: "clean",
  };
  const seed = buildSnapshot(
    [
      {
        candidate: normalizeCandidate(seedRaw),
        sourceUrl,
        trust: "verified",
      },
    ],
    new Date("2026-09-15T00:00:00.000Z"),
  );
  writeFileSync(join(dir, "registry-snapshot.json"), JSON.stringify(seed));
  const drifted: RawCandidate = {
    ...seedRaw,
    artifact: {
      kind: "skill",
      file: "SKILL.md",
      capabilities: ["testing.runner", "debugging.systematic"],
      domains: ["software-development"],
    },
  };
  const shellExec: RawCandidate = {
    ...seedRaw,
    id: "rt-refresh-shell",
    description:
      "Run via shell: the launcher will exec any subprocess command.",
  };
  const result = await refreshSnapshot({
    cacheDir: dir,
    now: new Date("2026-11-08T00:00:00.000Z"),
    fetchers: [
      {
        id: "redteam-source",
        url: sourceUrl,
        fetch: async () => ({ raws: [drifted, shellExec] }),
      },
    ],
  });
  assert.equal(result.ok, true);
  const snapshot = loadSnapshot({ cacheDir: dir });
  const adapter = new OpenCodeAdapter();
  for (const id of ["rt-refresh-drift", "rt-refresh-shell"]) {
    const candidate = snapshot.candidates.find((c) => c.id === id);
    assert.ok(candidate, `candidate ${id} must survive refresh`);
    const trust = snapshot.provenance.find((p) => p.id === id)?.trust;
    assert.equal(trust, "unverified", id);
    const plan = adapter.installPlan(candidate, trust);
    assert.ok(
      plan.operations.every((op) => op.kind === "recipe"),
      `${id} must stay recipe-only`,
    );
  }
});

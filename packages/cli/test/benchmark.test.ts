import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmark,
  formatBenchmarkReport,
  gateBenchmark,
  loadBenchmarkFixtures,
  runBenchmark,
  scoreWorkflow,
  type BenchmarkSummary,
} from "../src/commands/benchmark.js";
import { main } from "../src/index.js";

// Resolves to fixtures/benchmark both from src (ts) and dist (js).
const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../../fixtures/benchmark", import.meta.url),
);

// The benchmark must run offline against fixture corpora only: point every
// cache location at an empty tmp dir so any registry/network read would fail.
function isolateOffline(): void {
  const base = mkdtempSync(join(tmpdir(), "pd-bench-offline-"));
  mkdirSync(join(base, "cache"), { recursive: true });
  process.env.PLUGIN_DETECTOR_CACHE_DIR = join(base, "cache");
  process.env.XDG_CACHE_HOME = join(base, "xdg");
}

test("loads 30 labeled workflows across six domains", () => {
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  assert.equal(workflows.length, 30);
  const perDomain = new Map<string, number>();
  for (const workflow of workflows) {
    perDomain.set(workflow.domain, (perDomain.get(workflow.domain) ?? 0) + 1);
    assert.ok(workflow.rationale.length > 0, `${workflow.id} needs rationale`);
    assert.ok(
      workflow.requiredCapabilities.length > 0,
      `${workflow.id} needs required capabilities`,
    );
    assert.ok(
      workflow.unacceptableIds.length > 0,
      `${workflow.id} needs unacceptable ids`,
    );
    assert.ok(
      workflow.candidates.length >= 6,
      `${workflow.id} needs a corpus with distractors`,
    );
  }
  assert.deepEqual(
    [...perDomain.entries()].sort(),
    [
      ["data-analysis", 5],
      ["design-frontend", 5],
      ["devops-infrastructure", 5],
      ["research-writing", 5],
      ["software-development", 5],
      ["video-editing", 5],
    ],
  );
  assert.ok(baseline.candidates.length >= 10, "baseline needs a frozen pool");
});

test("engine precision beats the popularity baseline with no offenders", () => {
  isolateOffline();
  const summary = runBenchmark({ fixturesDir: FIXTURE_ROOT });
  assert.equal(summary.workflows.length, 30);
  assert.equal(summary.offenderCount, 0);
  for (const result of summary.workflows) {
    assert.deepEqual(
      result.offenders,
      [],
      `${result.id} offenders: ${JSON.stringify(result.offenders)}`,
    );
    assert.deepEqual(result.missingRequired, [], `${result.id} missing required`);
    assert.deepEqual(result.missingRedundant, [], `${result.id} missing redundant`);
    assert.ok(
      result.beatBaseline,
      `${result.id}: engine ${result.precisionAt5} vs baseline ${result.baselinePrecisionAt5}`,
    );
  }
  assert.ok(
    summary.meanPrecisionAt5 >= 0.8,
    `mean precision ${summary.meanPrecisionAt5}`,
  );
});

test("gate fails when a low-value candidate is returned as required", () => {
  const clean: BenchmarkSummary = {
    workflows: [],
    meanPrecisionAt5: 1,
    meanBaselinePrecisionAt5: 0.2,
    offenderCount: 0,
  };
  assert.equal(gateBenchmark(clean, { failOnLowValue: true }).exitCode, 0);
  assert.equal(gateBenchmark(clean, { failOnLowValue: false }).exitCode, 0);
  const offender: BenchmarkSummary = {
    workflows: [
      {
        id: "sw-demo",
        domain: "software-development",
        precisionAt5: 0.8,
        baselinePrecisionAt5: 0.4,
        beatBaseline: true,
        offenders: [
          { candidateId: "pop-render-farm", reason: "popular-but-irrelevant" },
        ],
        top: [],
        missingRequired: [],
        missingRedundant: [],
      },
    ],
    meanPrecisionAt5: 0.8,
    meanBaselinePrecisionAt5: 0.4,
    offenderCount: 1,
  };
  assert.equal(gateBenchmark(offender, { failOnLowValue: true }).exitCode, 1);
  assert.equal(gateBenchmark(offender, { failOnLowValue: false }).exitCode, 0);
  const baselineLoss: BenchmarkSummary = {
    workflows: [
      {
        id: "sw-demo",
        domain: "software-development",
        precisionAt5: 0.2,
        baselinePrecisionAt5: 0.4,
        beatBaseline: false,
        offenders: [],
        top: [],
        missingRequired: [],
        missingRedundant: [],
      },
    ],
    meanPrecisionAt5: 0.2,
    meanBaselinePrecisionAt5: 0.4,
    offenderCount: 0,
  };
  assert.equal(gateBenchmark(baselineLoss, { failOnLowValue: true }).exitCode, 1);
});

test("verdicts are capability-based, not id-memorized", () => {
  isolateOffline();
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  const original = workflows.find((w) => w.id === "sw-node-api");
  assert.ok(original, "sw-node-api fixture must exist");
  const before = scoreWorkflow(original, baseline.candidates);
  const anonymized = {
    ...original,
    candidates: original.candidates.map((c, i) => ({ ...c, id: `anon-${i}` })),
    unacceptableIds: [],
    expectedRequiredIds: [],
    expectedRedundantIds: [],
  };
  const after = scoreWorkflow(anonymized, baseline.candidates);
  assert.equal(after.precisionAt5, before.precisionAt5);
  assert.deepEqual(
    after.top.map((t) => t.verdict).sort(),
    before.top.map((t) => t.verdict).sort(),
  );
  assert.deepEqual(
    after.top.map((t) => t.score).sort((a, b) => b - a),
    before.top.map((t) => t.score).sort((a, b) => b - a),
  );
});

test("benchmark command reports precision and gates on low value", async () => {
  isolateOffline();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  try {
    assert.equal(
      (await benchmark(["--fixtures", FIXTURE_ROOT])).exitCode,
      0,
    );
    assert.equal(
      (await benchmark(["--fixtures", FIXTURE_ROOT, "--fail-on-low-value"]))
        .exitCode,
      0,
    );
    assert.equal((await benchmark(["--fixtures", "/nonexistent-dir"])).exitCode, 2);
    assert.equal((await benchmark(["--bogus"])).exitCode, 2);
  } finally {
    console.log = origLog;
  }
  assert.match(logs.join("\n"), /precision@5/);
});

test("index routes the benchmark command offline", async () => {
  isolateOffline();
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  let code: number;
  try {
    code = await main([
      "benchmark",
      "--fixtures",
      FIXTURE_ROOT,
      "--fail-on-low-value",
    ]);
  } finally {
    console.log = origLog;
  }
  assert.equal(code, 0);
  assert.match(logs.join("\n"), /mean-precision@5/);
});

test("runner flags an unacceptable required candidate and the gate fails it", () => {
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  const original = workflows.find((w) => w.id === "sw-node-api");
  assert.ok(original, "sw-node-api fixture must exist");
  // Mark a candidate the engine legitimately scores as "required" as
  // unacceptable: the runner must surface it as an offender, not pass silently.
  const tampered = { ...original, unacceptableIds: ["sw-api-tests"] };
  const result = scoreWorkflow(tampered, baseline.candidates);
  assert.ok(
    result.offenders.some((o) => o.candidateId === "sw-api-tests"),
    `offenders: ${JSON.stringify(result.offenders)}`,
  );
  const summary: BenchmarkSummary = {
    workflows: [result],
    meanPrecisionAt5: result.precisionAt5,
    meanBaselinePrecisionAt5: result.baselinePrecisionAt5,
    offenderCount: result.offenders.length,
  };
  const gated = gateBenchmark(summary, { failOnLowValue: true });
  assert.equal(gated.exitCode, 1);
  assert.ok(gated.failures.some((f) => f.includes("sw-api-tests")));
});

test("report and gate print every offending recommendation", () => {
  const summary: BenchmarkSummary = {
    workflows: [
      {
        id: "sw-node-api",
        domain: "software-development",
        precisionAt5: 0.8,
        baselinePrecisionAt5: 0.2,
        beatBaseline: true,
        offenders: [
          {
            candidateId: "pop-render-farm",
            reason: "popular-but-irrelevant candidate returned as required",
          },
          {
            candidateId: "pop-caption-pro",
            reason:
              "low-value candidate with no relevant capability returned as required",
          },
        ],
        top: [],
        missingRequired: [],
        missingRedundant: [],
      },
    ],
    meanPrecisionAt5: 0.8,
    meanBaselinePrecisionAt5: 0.2,
    offenderCount: 2,
  };
  const report = formatBenchmarkReport(summary);
  assert.match(report, /pop-render-farm/);
  assert.match(report, /pop-caption-pro/);
  const failures = gateBenchmark(summary, { failOnLowValue: true }).failures;
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => /pop-render-farm|pop-caption-pro/.test(f)));
});

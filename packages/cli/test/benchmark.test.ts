import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmark,
  formatBenchmarkReport,
  gateBenchmark,
  loadBenchmarkFixtures,
  MEAN_PRECISION_FLOOR,
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

// Realistic regression corpus for the CLI-level gate test: a mega-star
// candidate shares a domain capability (so it is genuinely scored `required`)
// yet is labeled unacceptable. This exercises the offender gate through real
// scoring rather than by tampering a label. Built by a test, not shipped.
const REGRESSION_YAML = `# Regression workflow (built by a test, not a shipped fixture).
id: regression-pop-fit
domain: software-development
declaration: software-development
signals:
  - package-manifest
  - tsconfig
installed: []
candidates:
  - id: core-test-runner
    capabilities:
      - testing.runner
    stars: 4000
  - id: core-review
    capabilities:
      - code-review.quality
    stars: 3000
  - id: core-debug
    capabilities:
      - debugging.systematic
    stars: 2000
  - id: pop-fit-impostor
    capabilities:
      - testing.runner
    stars: 180000
  - id: pop-render-farm
    capabilities:
      - media.transcode
    stars: 120000
  - id: pop-caption-pro
    capabilities:
      - speech.captions
    stars: 95000
requiredCapabilities:
  - testing.runner
  - code-review.quality
  - debugging.systematic
optionalCapabilities: []
expectedRequiredIds:
  - core-test-runner
  - core-review
  - core-debug
expectedRedundantIds: []
expectedOptionalIds: []
unacceptableIds:
  - pop-fit-impostor
rationale: A mega-star candidate shares a domain capability but is low-value, so the gate must refuse to recommend it as required.
`;

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
  // Controller ruling: 30 workflows is canonical; no seventh fixture per
  // domain is added by this fix round.
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
    assert.deepEqual(result.missingOptional, [], `${result.id} missing optional`);
    assert.ok(
      result.beatBaseline,
      `${result.id}: engine ${result.precisionAt5} vs baseline ${result.baselinePrecisionAt5}`,
    );
    assert.ok(
      result.precisionAt5 > result.baselinePrecisionAt5,
      `${result.id}: beat must be strict >`,
    );
  }
  assert.ok(
    summary.meanPrecisionAt5 >= MEAN_PRECISION_FLOOR,
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
        missingOptional: [],
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
        missingOptional: [],
      },
    ],
    meanPrecisionAt5: 0.2,
    meanBaselinePrecisionAt5: 0.4,
    offenderCount: 0,
  };
  assert.equal(gateBenchmark(baselineLoss, { failOnLowValue: true }).exitCode, 1);
});

test("gate enforces the mean floor and strict beat, not just offenders", () => {
  const degenerate: BenchmarkSummary = {
    workflows: [
      {
        id: "degenerate",
        domain: "software-development",
        precisionAt5: 0.5,
        baselinePrecisionAt5: 0.5,
        beatBaseline: true,
        offenders: [],
        top: [],
        missingRequired: [],
        missingRedundant: [],
        missingOptional: [],
      },
    ],
    meanPrecisionAt5: 0.5,
    meanBaselinePrecisionAt5: 0.5,
    offenderCount: 0,
  };
  const gated = gateBenchmark(degenerate, { failOnLowValue: true });
  assert.equal(gated.exitCode, 1, "a degenerate engine must not pass");
  assert.ok(gated.failures.some((f) => /floor/.test(f)), "mean floor failure");
  assert.ok(
    gated.failures.some((f) => /not above baseline/.test(f)),
    "a tie is not a beat",
  );

  // Even with the mean above the floor, a workflow that merely ties the
  // baseline must fail (strict > recomputed inside the gate).
  const tie: BenchmarkSummary = {
    workflows: [
      {
        id: "tie",
        domain: "software-development",
        precisionAt5: 0.9,
        baselinePrecisionAt5: 0.9,
        beatBaseline: true,
        offenders: [],
        top: [],
        missingRequired: [],
        missingRedundant: [],
        missingOptional: [],
      },
    ],
    meanPrecisionAt5: 0.9,
    meanBaselinePrecisionAt5: 0.9,
    offenderCount: 0,
  };
  assert.equal(gateBenchmark(tie, { failOnLowValue: true }).exitCode, 1);
  assert.equal(gateBenchmark(tie, { failOnLowValue: false }).exitCode, 0);
  assert.equal(MEAN_PRECISION_FLOOR, 0.8);
});

test("verdicts are capability-based, not id-memorized (all 30 workflows)", () => {
  isolateOffline();
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  assert.equal(workflows.length, 30);
  for (const original of workflows) {
    const before = scoreWorkflow(original, baseline.candidates);
    const anonymized = {
      ...original,
      candidates: original.candidates.map((c, i) => ({ ...c, id: `anon-${i}` })),
      unacceptableIds: [],
      expectedRequiredIds: [],
      expectedRedundantIds: [],
      expectedOptionalIds: [],
    };
    const after = scoreWorkflow(anonymized, baseline.candidates);
    assert.equal(after.precisionAt5, before.precisionAt5, `${original.id} precision`);
    assert.deepEqual(
      after.top.map((t) => t.verdict).sort(),
      before.top.map((t) => t.verdict).sort(),
      `${original.id} verdicts`,
    );
    assert.deepEqual(
      after.top.map((t) => t.score).sort((a, b) => b - a),
      before.top.map((t) => t.score).sort((a, b) => b - a),
      `${original.id} scores`,
    );
  }
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
        missingOptional: [],
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

test("scoreWorkflow rejects a corpus that cannot fill precision@5", () => {
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  const sample = workflows[0] as (typeof workflows)[number];
  assert.throws(
    () =>
      scoreWorkflow(
        { ...sample, candidates: sample.candidates.slice(0, 4) },
        baseline.candidates,
      ),
    /at least 5 non-risky candidates/,
  );
});

test("gate fails when an expected useful-optional verdict is missing", () => {
  const summary: BenchmarkSummary = {
    workflows: [
      {
        id: "sw-optional",
        domain: "software-development",
        precisionAt5: 1,
        baselinePrecisionAt5: 0,
        beatBaseline: true,
        offenders: [],
        top: [],
        missingRequired: [],
        missingRedundant: [],
        missingOptional: ["opt-1"],
      },
    ],
    meanPrecisionAt5: 1,
    meanBaselinePrecisionAt5: 0,
    offenderCount: 0,
  };
  const gated = gateBenchmark(summary, { failOnLowValue: true });
  assert.equal(gated.exitCode, 1);
  assert.ok(gated.failures.some((failure) => failure.includes("opt-1")));
  assert.equal(gateBenchmark(summary, { failOnLowValue: false }).exitCode, 0);
});

test("expected useful-optional labels are validated by the runner", () => {
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  const withOptional = workflows.filter((w) => w.expectedOptionalIds.length > 0);
  assert.ok(
    withOptional.length >= 3,
    "a meaningful subset of fixtures must carry optional labels",
  );
  for (const workflow of withOptional) {
    const result = scoreWorkflow(workflow, baseline.candidates);
    assert.deepEqual(
      result.missingOptional,
      [],
      `${workflow.id} expected-optional candidates must score useful-optional`,
    );
  }
  // Tamper: give the optional candidate a required (profile) capability so it
  // is no longer useful-optional; the runner must report it as a miss.
  const sample = withOptional[0] as (typeof withOptional)[number];
  const optId = sample.expectedOptionalIds[0] as string;
  const tampered = {
    ...sample,
    candidates: sample.candidates.map((c) =>
      c.id === optId
        ? { ...c, capabilities: [sample.requiredCapabilities[0] as string] }
        : c,
    ),
  };
  const result = scoreWorkflow(tampered, baseline.candidates);
  assert.ok(
    result.missingOptional.includes(optId),
    "tampered optional candidate must be reported as a miss",
  );
});

test("realistic regression: installed-duplicate is redundant, gate flags it if overlap regresses", () => {
  const { workflows, baseline } = loadBenchmarkFixtures(FIXTURE_ROOT);
  const original = workflows.find((w) => w.id === "sw-redundant-git");
  assert.ok(original, "sw-redundant-git fixture must exist");
  const dupId = "sw-git-pop-helper";
  assert.ok(
    original.unacceptableIds.includes(dupId),
    "fixture must carry the high-popularity regression candidate",
  );
  assert.ok(
    original.expectedRedundantIds.includes(dupId),
    "fixture must expect that candidate redundant",
  );

  // Correct behavior: the high-popularity candidate shares a domain
  // capability but duplicates an installed equivalent, so it is `redundant`,
  // never `required`, and the gate stays clean.
  const correct = scoreWorkflow(original, baseline.candidates);
  assert.deepEqual(correct.missingRedundant, [], "duplicate must score redundant");
  assert.deepEqual(correct.offenders, [], "redundant duplicate is not an offender");

  // Regression: the installed equivalent is no longer detected (overlap gate
  // regresses), so the same candidate is now scored `required` and unacceptable.
  const regressed = scoreWorkflow({ ...original, installed: [] }, baseline.candidates);
  assert.ok(
    regressed.offenders.some((o) => o.candidateId === dupId),
    `offenders: ${JSON.stringify(regressed.offenders)}`,
  );
  const summary: BenchmarkSummary = {
    workflows: [regressed],
    meanPrecisionAt5: regressed.precisionAt5,
    meanBaselinePrecisionAt5: regressed.baselinePrecisionAt5,
    offenderCount: regressed.offenders.length,
  };
  const gated = gateBenchmark(summary, { failOnLowValue: true });
  assert.equal(gated.exitCode, 1);
  assert.ok(gated.failures.some((f) => f.includes(dupId)));
});

test("CLI-level gate fails on a realistic regression and prints the offender", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-bench-cli-"));
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "));
  };
  try {
    mkdirSync(join(dir, "workflows"), { recursive: true });
    mkdirSync(join(dir, "baselines"), { recursive: true });
    writeFileSync(
      join(dir, "baselines", "popular-repo.json"),
      readFileSync(join(FIXTURE_ROOT, "baselines", "popular-repo.json")),
    );
    writeFileSync(join(dir, "workflows", "regression.yaml"), REGRESSION_YAML);
    const code = (await benchmark(["--fixtures", dir, "--fail-on-low-value"])).exitCode;
    assert.equal(code, 1);
  } finally {
    console.log = origLog;
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  }
  const output = `${logs.join("\n")}\n${errors.join("\n")}`;
  assert.match(output, /offenders=pop-fit-impostor/);
  assert.match(output, /fail:.*pop-fit-impostor/);
});

test("gate fails on missing required and redundant labels, not only optional", () => {
  const missing: BenchmarkSummary = {
    workflows: [
      {
        id: "missing",
        domain: "software-development",
        precisionAt5: 0.9,
        baselinePrecisionAt5: 0.2,
        beatBaseline: true,
        offenders: [],
        top: [],
        missingRequired: ["core-test-runner"],
        missingRedundant: ["sw-git-pop-helper"],
        missingOptional: [],
      },
    ],
    meanPrecisionAt5: 0.9,
    meanBaselinePrecisionAt5: 0.2,
    offenderCount: 0,
  };
  const gated = gateBenchmark(missing, { failOnLowValue: true });
  assert.equal(gated.exitCode, 1);
  assert.ok(gated.failures.some((f) => /expected required/.test(f)));
  assert.ok(gated.failures.some((f) => /expected redundant/.test(f)));
});

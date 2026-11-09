import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  scoreCandidateSet,
  type Candidate,
  type CapabilityRecord,
} from "@plugin-detector/core";
import { resolveProfile } from "@plugin-detector/profiles";

// Recommendation benchmark gate (Task 15). Scores every labeled workflow in
// fixtures/benchmark against the real scorer (scoreCandidate) using only the
// fixture corpus — never the registry cache or the network — and compares
// the engine top-5 against a frozen popularity-only baseline on the same
// fixtures. Labels are capability-based: true positives are counted by
// capability overlap, never by id equality, so the engine cannot pass by
// memorizing fixture ids (see the id-shuffle test in benchmark.test.ts).

const CandidateSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  stars: z.number().int().nonnegative().optional(),
});
export type BenchmarkCandidateSpec = z.infer<typeof CandidateSpecSchema>;

const InstalledSpecSchema = z.object({
  id: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
});
export type BenchmarkInstalledSpec = z.infer<typeof InstalledSpecSchema>;

const WorkflowSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  declaration: z.string().min(1),
  signals: z.array(z.string().min(1)),
  installed: z.array(InstalledSpecSchema).optional().default([]),
  candidates: z.array(CandidateSpecSchema).min(1),
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  optionalCapabilities: z.array(z.string().min(1)).optional().default([]),
  expectedRequiredIds: z.array(z.string().min(1)).optional().default([]),
  expectedRedundantIds: z.array(z.string().min(1)).optional().default([]),
  expectedOptionalIds: z.array(z.string().min(1)).optional().default([]),
  unacceptableIds: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
});
export type BenchmarkWorkflow = z.infer<typeof WorkflowSchema>;

const BaselineSchema = z.object({
  frozenAt: z.string().min(1),
  note: z.string().min(1),
  candidates: z.array(CandidateSpecSchema).min(1),
});
export type BenchmarkBaseline = z.infer<typeof BaselineSchema>;

export interface WorkflowTop {
  candidateId: string;
  verdict: string;
  score: number;
}

export interface WorkflowOffender {
  candidateId: string;
  reason: string;
}

export interface WorkflowResult {
  id: string;
  domain: string;
  precisionAt5: number;
  baselinePrecisionAt5: number;
  beatBaseline: boolean;
  offenders: WorkflowOffender[];
  top: WorkflowTop[];
  missingRequired: string[];
  missingRedundant: string[];
  missingOptional: string[];
}

export interface BenchmarkSummary {
  workflows: WorkflowResult[];
  meanPrecisionAt5: number;
  meanBaselinePrecisionAt5: number;
  offenderCount: number;
}

// Minimal strict YAML-subset parser for the fixture shape only: top-level
// `key: value` pairs, nested maps, and lists of scalars or single-level maps
// (`- key: value` plus further-indented `key: value` lines). Two-space
// indent, spaces only, `#` full-line comments. Anything else throws —
// fixtures are authored to this shape, and the loader reports the file and
// line so mis-authored labels fail loudly instead of scoring silently.
type YamlNode = string | number | YamlNode[] | { [key: string]: YamlNode };

function parseScalar(raw: string, source: string, lineNo: number): YamlNode {
  const value = raw.trim();
  // Fixtures declare empty lists inline (`installed: []`); the strict subset
  // otherwise sees only block lists. Anything non-empty fails loudly below.
  if (value === "[]") return [];
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.length === 0) throw new Error(`${source}:${lineNo}: empty scalar`);
  return value;
}

interface Line {
  indent: number;
  text: string;
  lineNo: number;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) throw new Error(`benchmark:${i + 1}: tabs not supported`);
    const indent = line.length - line.trimStart().length;
    lines.push({ indent, text: line.trim(), lineNo: i + 1 });
  }
  return lines;
}

function parseBlock(lines: Line[], at: number, indent: number): { node: YamlNode; next: number } {
  if (at >= lines.length || (lines[at]?.indent ?? 0) < indent) {
    throw new Error(`benchmark:${lines[Math.max(0, at - 1)]?.lineNo ?? 0}: expected block`);
  }
  if (lines[at]?.text.startsWith("-") === true) {
    return parseList(lines, at, indent);
  }
  return parseMap(lines, at, indent);
}

function parseList(lines: Line[], at: number, indent: number): { node: YamlNode[]; next: number } {
  const items: YamlNode[] = [];
  let i = at;
  while (i < lines.length && lines[i]?.indent === indent && lines[i]?.text.startsWith("-") === true) {
    const line = lines[i] as Line;
    const rest = line.text.slice(1).trim();
    if (rest.length === 0) {
      const child = parseBlock(lines, i + 1, indent + 2);
      items.push(child.node);
      i = child.next;
    } else {
      const colon = rest.indexOf(":");
      if (colon > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
        const map: { [key: string]: YamlNode } = {};
        const key = rest.slice(0, colon).trim();
        const value = rest.slice(colon + 1).trim();
        if (key.length === 0) throw new Error(`benchmark:${line.lineNo}: empty key`);
        if (value.length === 0) {
          const child = parseBlock(lines, i + 1, indent + 2);
          map[key] = child.node;
          i = child.next;
        } else {
          map[key] = parseScalar(value, "benchmark", line.lineNo);
          i += 1;
          while (i < lines.length) {
            const cont = lines[i] as Line;
            if (cont.indent !== indent + 2 || cont.text.startsWith("-")) break;
            const c = cont.text.indexOf(":");
            if (c < 0) throw new Error(`benchmark:${cont.lineNo}: expected "key: value"`);
            const ck = cont.text.slice(0, c).trim();
            const cv = cont.text.slice(c + 1).trim();
            if (ck.length === 0) throw new Error(`benchmark:${cont.lineNo}: empty key`);
            if (ck in map) throw new Error(`benchmark:${cont.lineNo}: duplicate key ${ck}`);
            if (cv.length === 0) {
              const child = parseBlock(lines, i + 1, indent + 4);
              map[ck] = child.node;
              i = child.next;
            } else {
              map[ck] = parseScalar(cv, "benchmark", cont.lineNo);
              i += 1;
            }
          }
        }
        items.push(map);
      } else {
        items.push(parseScalar(rest, "benchmark", line.lineNo));
        i += 1;
      }
    }
  }
  return { node: items, next: i };
}

function parseMap(lines: Line[], at: number, indent: number): { node: { [key: string]: YamlNode }; next: number } {
  const map: { [key: string]: YamlNode } = {};
  let i = at;
  while (i < lines.length && lines[i]?.indent === indent && !(lines[i]?.text.startsWith("-") === true)) {
    const line = lines[i] as Line;
    const colon = line.text.indexOf(":");
    if (colon < 0) throw new Error(`benchmark:${line.lineNo}: expected "key: value"`);
    const key = line.text.slice(0, colon).trim();
    const value = line.text.slice(colon + 1).trim();
    if (key.length === 0) throw new Error(`benchmark:${line.lineNo}: empty key`);
    if (key in map) throw new Error(`benchmark:${line.lineNo}: duplicate key ${key}`);
    if (value.length === 0) {
      const child = parseBlock(lines, i + 1, indent + 2);
      map[key] = child.node;
      i = child.next;
    } else {
      map[key] = parseScalar(value, "benchmark", line.lineNo);
      i += 1;
    }
  }
  return { node: map, next: i };
}

export function parseBenchmarkYaml(text: string): unknown {
  const lines = toLines(text);
  if (lines.length === 0) throw new Error("benchmark: empty document");
  const { node, next } = parseMap(lines, 0, 0);
  if (next !== lines.length) {
    throw new Error(`benchmark:${lines[next]?.lineNo ?? 0}: unexpected content`);
  }
  return node;
}

function toCandidate(spec: BenchmarkCandidateSpec, domain: string): Candidate {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    artifactType: "skill",
    sources: [`https://example.com/${spec.id}`],
    useCaseDomains: [domain],
    capabilities: [...spec.capabilities],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: `https://github.com/example/${spec.id}`,
    installMode: "verified",
    lastVerified: "2026-11-08T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: spec.stars ?? 100 },
  };
}

function toRecord(spec: BenchmarkInstalledSpec): CapabilityRecord {
  return {
    id: spec.id,
    name: spec.id,
    harness: "opencode",
    kind: "plugin",
    capabilities: [...spec.capabilities],
    enabled: true,
    configRefs: [],
    contextCostClass: "per-use",
  };
}

function truePositive(
  capabilities: string[],
  required: Set<string>,
): boolean {
  return capabilities.some((c) => required.has(c));
}

function isOffender(
  candidateId: string,
  verdict: string,
  capabilities: string[],
  workflow: BenchmarkWorkflow,
  relevant: Set<string>,
): string | null {
  if (verdict !== "required") return null;
  if (workflow.unacceptableIds.includes(candidateId)) {
    return "popular-but-irrelevant candidate returned as required";
  }
  if (!capabilities.some((c) => relevant.has(c))) {
    return "low-value candidate with no relevant capability returned as required";
  }
  return null;
}

export function scoreWorkflow(
  workflow: BenchmarkWorkflow,
  baseline: BenchmarkCandidateSpec[],
): WorkflowResult {
  const resolution = resolveProfile({
    declaration: workflow.declaration,
    projectSignals: [...workflow.signals],
  });
  if (resolution.profile === null || resolution.status === "contradiction") {
    throw new Error(
      `${workflow.id}: signals contradict declaration "${workflow.declaration}"`,
    );
  }
  const profile = resolution.profile;
  const matched = new Set(resolution.matchedSignals.map((s) => s.toLowerCase()));
  const projectSignalMatch =
    profile.signalQueries.length === 0
      ? 0
      : profile.signalQueries.filter((q) => matched.has(q.toLowerCase())).length /
        profile.signalQueries.length;
  const profileCaps = new Set<string>(profile.capabilities);
  const installed = workflow.installed.map(toRecord);
  const required = new Set(workflow.requiredCapabilities);
  const relevant = new Set([
    ...workflow.requiredCapabilities,
    ...workflow.optionalCapabilities,
  ]);

  const scoreAll = (specs: BenchmarkCandidateSpec[], domain: string) => {
    const candidates = specs.map((spec) => toCandidate(spec, domain));
    const recs = scoreCandidateSet(candidates, {
      installedCapabilities: installed,
      profileDomains: [...profile.capabilities],
      harness: "unknown",
      projectSignalMatch,
      useCaseMatchFor: (candidate) =>
        candidate.capabilities.length === 0
          ? 0
          : candidate.capabilities.filter((c) => profileCaps.has(c)).length /
            candidate.capabilities.length,
    });
    return candidates.map((candidate, i) => ({
      candidate,
      rec: recs[i] as (typeof recs)[number],
    }));
  };

  const scored = scoreAll(workflow.candidates, workflow.domain);
  scored.sort((a, b) =>
    b.rec.score === a.rec.score
      ? a.candidate.id < b.candidate.id
        ? -1
        : 1
      : b.rec.score - a.rec.score,
  );
  const top = scored.filter((s) => s.rec.verdict !== "risky").slice(0, 5);
  // precision@5 has a fixed denominator. Treat a corpus that cannot fill the
  // top five as a fixture error instead of silently scoring against a
  // different denominator.
  if (top.length < 5) {
    throw new Error(
      `${workflow.id}: precision@5 requires at least 5 non-risky candidates (found ${top.length})`,
    );
  }
  const offenders: WorkflowOffender[] = [];
  let hits = 0;
  for (const entry of top) {
    if (entry.rec.verdict === "required" && truePositive(entry.candidate.capabilities, required)) {
      hits += 1;
    }
    const reason = isOffender(
      entry.candidate.id,
      entry.rec.verdict,
      entry.candidate.capabilities,
      workflow,
      relevant,
    );
    if (reason !== null) offenders.push({ candidateId: entry.candidate.id, reason });
  }
  const precisionAt5 = hits / 5;

  // Popularity-only baseline: rank the frozen pool by raw stars with no fit
  // filtering, then score the same way for a like-for-like precision@5.
  const rankedBaseline = [...baseline].sort(
    (a, b) => (b.stars ?? 100) - (a.stars ?? 100),
  );
  if (rankedBaseline.length < 5) {
    throw new Error(
      `${workflow.id}: baseline pool needs at least 5 candidates (found ${rankedBaseline.length})`,
    );
  }
  const baselineTop = scoreAll(rankedBaseline.slice(0, 5), workflow.domain);
  let baselineHits = 0;
  for (const entry of baselineTop) {
    if (
      entry.rec.verdict !== "risky" &&
      entry.rec.verdict === "required" &&
      truePositive(entry.candidate.capabilities, required)
    ) {
      baselineHits += 1;
    }
  }
  const baselinePrecisionAt5 = baselineHits / 5;

  const requiredVerdicts = new Set(
    scored.filter((s) => s.rec.verdict === "required").map((s) => s.candidate.id),
  );
  const redundantVerdicts = new Set(
    scored.filter((s) => s.rec.verdict === "redundant").map((s) => s.candidate.id),
  );
  const optionalVerdicts = new Set(
    scored.filter((s) => s.rec.verdict === "useful-optional").map((s) => s.candidate.id),
  );
  return {
    id: workflow.id,
    domain: workflow.domain,
    precisionAt5,
    baselinePrecisionAt5,
    // A tie is not a beat.
    beatBaseline: precisionAt5 > baselinePrecisionAt5,
    offenders,
    top: top.map((s) => ({
      candidateId: s.candidate.id,
      verdict: s.rec.verdict,
      score: s.rec.score,
    })),
    missingRequired: workflow.expectedRequiredIds.filter((id) => !requiredVerdicts.has(id)),
    missingRedundant: workflow.expectedRedundantIds.filter((id) => !redundantVerdicts.has(id)),
    missingOptional: workflow.expectedOptionalIds.filter((id) => !optionalVerdicts.has(id)),
  };
}

export function loadBenchmarkFixtures(fixturesDir: string): {
  workflows: BenchmarkWorkflow[];
  baseline: BenchmarkBaseline;
} {
  const workflowsDir = join(fixturesDir, "workflows");
  const baselinePath = join(fixturesDir, "baselines", "popular-repo.json");
  if (!existsSync(workflowsDir)) {
    throw new Error(`no workflows directory: ${workflowsDir}`);
  }
  if (!existsSync(baselinePath)) {
    throw new Error(`no baseline file: ${baselinePath}`);
  }
  const workflows = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const raw = parseBenchmarkYaml(readFileSync(join(workflowsDir, f), "utf8"));
      try {
        return WorkflowSchema.parse(raw);
      } catch (error) {
        throw new Error(
          `${f}: invalid workflow: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  const baseline = BaselineSchema.parse(
    JSON.parse(readFileSync(baselinePath, "utf8")),
  );
  return { workflows, baseline };
}

export function runBenchmark({ fixturesDir }: { fixturesDir: string }): BenchmarkSummary {
  const { workflows, baseline } = loadBenchmarkFixtures(fixturesDir);
  const results = workflows.map((w) => scoreWorkflow(w, baseline.candidates));
  const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    workflows: results,
    meanPrecisionAt5: mean(results.map((r) => r.precisionAt5)),
    meanBaselinePrecisionAt5: mean(results.map((r) => r.baselinePrecisionAt5)),
    offenderCount: results.reduce((n, r) => n + r.offenders.length, 0),
  };
}

// Enforced inside the CLI gate, not only in a unit assertion.
export const MEAN_PRECISION_FLOOR = 0.8;

export function gateBenchmark(
  summary: BenchmarkSummary,
  { failOnLowValue }: { failOnLowValue: boolean },
): { exitCode: number; failures: string[] } {
  if (!failOnLowValue) return { exitCode: 0, failures: [] };
  const failures: string[] = [];
  for (const result of summary.workflows) {
    for (const offender of result.offenders) {
      failures.push(`${result.id}: low-value ${offender.candidateId} (${offender.reason})`);
    }
    for (const id of result.missingRequired) {
      failures.push(
        `${result.id}: expected required candidate ${id} did not receive that verdict`,
      );
    }
    for (const id of result.missingRedundant) {
      failures.push(
        `${result.id}: expected redundant candidate ${id} did not receive that verdict`,
      );
    }
    for (const id of result.missingOptional) {
      failures.push(
        `${result.id}: expected useful-optional candidate ${id} did not receive that verdict`,
      );
    }
    // Recompute strict > here rather than trusting a possibly-stale
    // beatBaseline flag: a tie must never count as a beat.
    if (!(result.precisionAt5 > result.baselinePrecisionAt5)) {
      failures.push(
        `${result.id}: engine precision@5 ${result.precisionAt5.toFixed(2)} not above baseline ${result.baselinePrecisionAt5.toFixed(2)}`,
      );
    }
  }
  if (summary.meanPrecisionAt5 < MEAN_PRECISION_FLOOR) {
    failures.push(
      `mean precision@5 ${summary.meanPrecisionAt5.toFixed(3)} below ${MEAN_PRECISION_FLOOR.toFixed(3)} floor`,
    );
  }
  return { exitCode: failures.length === 0 ? 0 : 1, failures };
}

export function formatBenchmarkReport(summary: BenchmarkSummary): string {
  const lines = summary.workflows.map(
    (r) =>
      `${r.id} [${r.domain}] precision@5=${r.precisionAt5.toFixed(2)} ` +
      `baseline=${r.baselinePrecisionAt5.toFixed(2)} ${r.beatBaseline ? "beat" : "FAIL"}` +
      (r.offenders.length === 0
        ? ""
        : ` offenders=${r.offenders.map((o) => o.candidateId).join(",")}`),
  );
  lines.push(
    `workflows=${summary.workflows.length} ` +
      `mean-precision@5=${summary.meanPrecisionAt5.toFixed(3)} ` +
      `mean-baseline=${summary.meanBaselinePrecisionAt5.toFixed(3)} ` +
      `offenders=${summary.offenderCount}`,
  );
  return lines.join("\n");
}

export interface BenchmarkResult {
  exitCode: number;
}

export async function benchmark(argv: string[]): Promise<BenchmarkResult> {
  let fixtures = "fixtures/benchmark";
  let failOnLowValue = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fail-on-low-value") {
      failOnLowValue = true;
    } else if (arg === "--fixtures" && i + 1 < argv.length) {
      fixtures = argv[i + 1] as string;
      i += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  const fixturesDir = resolve(fixtures);
  let summary: BenchmarkSummary;
  try {
    summary = runBenchmark({ fixturesDir });
  } catch (error) {
    console.error(
      `benchmark failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 2 };
  }
  console.log(formatBenchmarkReport(summary));
  const gated = gateBenchmark(summary, { failOnLowValue });
  for (const failure of gated.failures) console.error(`fail: ${failure}`);
  return { exitCode: gated.exitCode };
}

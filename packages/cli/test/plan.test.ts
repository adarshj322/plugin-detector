import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../src/commands/plan.js";
import { approve } from "../src/commands/approve.js";
import { install } from "../src/commands/install.js";
import { ApproveJsonSchema, PlanJsonSchema } from "../src/output.js";
import {
  CandidateSchema,
  InstallPlanSchema,
  planHash,
  type Candidate,
} from "@plugin-detector/core";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";

interface SnapshotInput {
  candidate: Candidate;
  trust: "verified" | "curated" | "unverified";
}

let savedState: string | undefined;
let base: string;
let home: string;
let root: string;
let cacheDir: string;
let outFile: string;

function candidate(
  id: string,
  artifactType: "plugin" | "command" = "plugin",
): Candidate {
  return CandidateSchema.parse({
    id,
    name: id.toUpperCase(),
    artifactType,
    sources: [`https://example.com/${id}`],
    useCaseDomains: ["software-development"],
    capabilities: ["vcs.workflow"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: `https://github.com/example/${id}`,
    packageName: `@ex/${id}`,
    installMode: "verified",
    lastVerified: "2026-11-08T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
  });
}

function writeSnapshot(entries: SnapshotInput[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const at = "2026-11-08T00:00:00.000Z";
  writeFileSync(
    join(cacheDir, "registry-snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: at,
      candidates: entries.map((entry) => entry.candidate),
      provenance: entries.map((entry) => ({
        id: entry.candidate.id,
        sourceUrl: entry.candidate.sources[0],
        retrievedAt: at,
        trust: entry.trust,
      })),
    }),
  );
}

function planArgs(id: string): string[] {
  return [
    "--candidate",
    id,
    "--harness",
    "opencode",
    "--cache-dir",
    cacheDir,
    "--home",
    home,
    "--root",
    root,
    "--json",
  ];
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

beforeEach(() => {
  savedState = process.env[STATE_ENV];
  base = mkdtempSync(join(tmpdir(), "pd-cli-plan-"));
  process.env[STATE_ENV] = join(base, "state");
  home = join(base, "home");
  root = join(base, "root");
  cacheDir = join(base, "cache");
  outFile = join(base, "plan.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeSnapshot([
    { candidate: candidate("c1"), trust: "verified" },
    { candidate: candidate("u1", "command"), trust: "verified" },
    { candidate: candidate("x1"), trust: "unverified" },
    { candidate: candidate("k1"), trust: "curated" },
  ]);
});

afterEach(() => {
  if (savedState === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = savedState;
});

test("plan emits a full write plan for a verified candidate", async () => {
  const { logs, errors } = await capture(() =>
    plan([...planArgs("c1"), "--out", outFile]),
  );
  assert.deepEqual(errors, []);
  const payload = PlanJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown);
  assert.equal(payload.facts.status, "write");
  assert.equal(payload.facts.trust, "verified");
  assert.equal(payload.facts.candidateId, "c1");
  assert.equal(payload.facts.planHash, planHash(payload.facts.plan));
  assert.ok(payload.facts.plan.operations.length > 0);
  assert.ok(payload.facts.plan.backupRefs.length > 0);
  assert.ok(
    payload.facts.nextSteps.some((step) =>
      step.startsWith(`approve --candidate c1 --plan ${payload.facts.planHash}`),
    ),
    "next steps must hand off the exact approve command",
  );
  const written = InstallPlanSchema.parse(
    JSON.parse(readFileSync(outFile, "utf8")) as unknown,
  );
  assert.deepEqual(written, payload.facts.plan);
});

test("plan prints a recipe and writes no plan for an unverified candidate", async () => {
  const { logs } = await capture(() =>
    plan([...planArgs("x1"), "--out", outFile]),
  );
  const payload = PlanJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown);
  assert.equal(payload.facts.status, "recipe");
  assert.equal(payload.facts.trust, "unverified");
  assert.ok(payload.facts.plan.operations.every((op) => op.kind === "recipe"));
  assert.ok(payload.facts.recipe?.includes("Manual install"));
  assert.ok(!existsSync(outFile), "recipe plans must not be written as install plans");
});

test("plan treats curated candidates as recipe-only", async () => {
  const { logs } = await capture(() => plan(planArgs("k1")));
  const payload = PlanJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown);
  assert.equal(payload.facts.status, "recipe");
  assert.equal(payload.facts.trust, "curated");
});

test("plan rejects unknown candidates and invalid harnesses", async () => {
  const unknown = await capture(() => plan(planArgs("nope")));
  assert.equal(unknown.logs.length, 0);
  assert.ok(unknown.errors.some((line) => line.includes("unknown candidate")));

  assert.equal(
    (await plan(["--candidate", "c1", "--harness", "auto", "--cache-dir", cacheDir]))
      .exitCode,
    2,
  );
  assert.equal(
    (await plan(["--harness", "opencode", "--cache-dir", cacheDir])).exitCode,
    2,
  );
});

test("plan writes a plan that approve accepts and install applies", async () => {
  await capture(() => plan([...planArgs("c1"), "--out", outFile]));
  const approved = await capture(() =>
    approve(["--candidate", "c1", "--plan-file", outFile, "--json"]),
  );
  const token = ApproveJsonSchema.parse(
    JSON.parse(approved.logs.join("\n")) as unknown,
  ).facts.token;
  const installed = await capture(() =>
    install([
      "--plan-file",
      outFile,
      "--candidate",
      "c1",
      "--harness",
      "opencode",
      "--cache-dir",
      cacheDir,
      "--home",
      home,
      "--root",
      root,
      "--approval-token",
      token,
    ]),
  );
  assert.equal(installed.errors.length, 0);
  const merged = JSON.parse(
    readFileSync(join(root, "opencode.json"), "utf8"),
  ) as { plugin: string[] };
  assert.deepEqual(merged.plugin, ["@ex/c1"]);
});

test("plan re-derives identical hashes across invocations", async () => {
  const first = await capture(() => plan(planArgs("c1")));
  const second = await capture(() => plan(planArgs("c1")));
  const hashOf = (logs: string[]): string =>
    PlanJsonSchema.parse(JSON.parse(logs.join("\n")) as unknown).facts.planHash;
  assert.equal(hashOf(first.logs), hashOf(second.logs));
});

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
import { buildSnapshot } from "@plugin-detector/registry";
import { CandidateSchema, type Candidate } from "@plugin-detector/core";
import { plan } from "../src/commands/plan.js";
import { approve } from "../src/commands/approve.js";
import { install } from "../src/commands/install.js";
import { rollback } from "../src/commands/rollback.js";
import { ApproveJsonSchema, RollbackJsonSchema } from "../src/output.js";

const STATE_ENV = "PLUGIN_DETECTOR_STATE_DIR";

let savedState: string | undefined;
let home: string;
let root: string;
let cacheDir: string;
let planFile: string;
let configPath: string;
const preimage = '{"plugin":["@ex/old"]}\n';

function candidate(): Candidate {
  return CandidateSchema.parse({
    id: "rb1",
    name: "Rollback One",
    artifactType: "plugin",
    sources: ["https://example.com/rb1"],
    useCaseDomains: ["software-development"],
    capabilities: ["vcs.workflow"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: "https://github.com/example/rb1",
    packageName: "@ex/rb1",
    installMode: "verified",
    lastVerified: "2026-11-08T00:00:00.000Z",
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 100 },
  });
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
  const base = mkdtempSync(join(tmpdir(), "pd-cli-rollback-"));
  process.env[STATE_ENV] = join(base, "state");
  home = join(base, "home");
  root = join(base, "root");
  cacheDir = join(base, "cache");
  planFile = join(base, "plan.json");
  configPath = join(root, "opencode.json");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(configPath, preimage);
  const at = "2026-11-08T00:00:00.000Z";
  writeFileSync(
    join(cacheDir, "registry-snapshot.json"),
    JSON.stringify(
      buildSnapshot(
        [{ candidate: candidate(), sourceUrl: "https://example.com/rb1", trust: "verified" }],
        new Date(at),
      ),
    ),
  );
});

afterEach(() => {
  if (savedState === undefined) delete process.env[STATE_ENV];
  else process.env[STATE_ENV] = savedState;
});

test("rollback restores the preimage recorded by an applied plan", async () => {
  const args = [
    "--candidate",
    "rb1",
    "--harness",
    "opencode",
    "--cache-dir",
    cacheDir,
    "--home",
    home,
    "--root",
    root,
  ];
  await capture(() => plan([...args, "--out", planFile]));
  const approved = await capture(() =>
    approve(["--candidate", "rb1", "--plan-file", planFile, "--json"]),
  );
  const token = ApproveJsonSchema.parse(
    JSON.parse(approved.logs.join("\n")) as unknown,
  ).facts.token;
  const installed = await capture(() =>
    install([...args, "--plan-file", planFile, "--approval-token", token]),
  );
  assert.equal(installed.errors.length, 0);
  assert.notEqual(readFileSync(configPath, "utf8"), preimage);

  const rolled = await capture(() =>
    rollback(["--plan-file", planFile, "--home", home, "--root", root, "--json"]),
  );
  assert.deepEqual(rolled.errors, []);
  const payload = RollbackJsonSchema.parse(
    JSON.parse(rolled.logs.join("\n")) as unknown,
  );
  assert.equal(payload.facts.candidateId, "rb1");
  assert.ok(payload.facts.restored.includes(configPath));
  assert.equal(readFileSync(configPath, "utf8"), preimage);
  assert.ok(!existsSync(configPath) === false);
});

test("rollback requires a plan file", async () => {
  assert.equal((await rollback(["--json"])).exitCode, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  MANIFEST_FILENAME,
  ReviewReportSchema,
  SNAPSHOT_FILENAME,
} from "@plugin-detector/registry";
import { CandidateSchema } from "@plugin-detector/core";
import { registryReview } from "../src/commands/registry-review.js";
import { main } from "../src/index.js";

const AT = "2026-11-09T00:00:00.000Z";

function tmpCache(): string {
  return mkdtempSync(join(tmpdir(), "pd-cli-review-"));
}

function candidate() {
  return CandidateSchema.parse({
    id: "alpha",
    name: "Alpha Skill",
    artifactType: "skill",
    sources: ["https://example.com/alpha"],
    useCaseDomains: ["software-development"],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.2.3",
    installMode: "verified",
    lastVerified: AT,
    artifactEvidence: {
      kind: "skill",
      sourceUrl: "https://raw.githubusercontent.com/acme/alpha/v1.2.3/SKILL.md",
      resolvedRef: "v1.2.3",
      contentHash: "a".repeat(64),
      license: "Apache-2.0",
      name: "Alpha Skill",
      capabilities: ["testing.runner"],
      evidenceSnippets: ["name: alpha"],
      retrievedAt: AT,
    },
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: {},
  });
}

function writeSnapshot(dir: string): void {
  const snapshot = buildSnapshot(
    [
      {
        candidate: candidate(),
        sourceUrl: "https://skills.sh/api/search",
        trust: "verified",
      },
    ],
    new Date(AT),
  );
  writeFileSync(join(dir, SNAPSHOT_FILENAME), JSON.stringify(snapshot));
}

function writeManifest(dir: string): void {
  writeFileSync(
    join(dir, MANIFEST_FILENAME),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: AT,
      sources: { "skills-sh": { ok: true, count: 1 } },
      rejected: [
        {
          id: "gone-a",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: AT,
        },
        {
          id: "gone-b",
          reason: "ARTIFACT_MISSING: 404",
          sourceUrl: "https://skills.sh/api/search",
          rejectedAt: AT,
        },
      ],
      unprobed: [
        {
          id: "listed",
          reason: "no artifact evidence: listing-only record excluded from snapshot",
          sourceUrl: "https://github.com/search",
          observedAt: AT,
        },
      ],
    }),
  );
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

test("registry review --json prints a validated report and writes nothing", async () => {
  const dir = tmpCache();
  writeSnapshot(dir);
  writeManifest(dir);
  const before = readdirSync(dir).sort();
  const snapshotBefore = readFileSync(join(dir, SNAPSHOT_FILENAME), "utf8");
  const manifestBefore = readFileSync(join(dir, MANIFEST_FILENAME), "utf8");

  const { logs, errors } = await capture(() =>
    registryReview(["--cache-dir", dir, "--json"]),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.equal(
    readFileSync(join(dir, SNAPSHOT_FILENAME), "utf8"),
    snapshotBefore,
  );
  assert.equal(
    readFileSync(join(dir, MANIFEST_FILENAME), "utf8"),
    manifestBefore,
  );
  const report = ReviewReportSchema.parse(
    JSON.parse(logs.join("\n")) as unknown,
  );
  assert.deepEqual(report.counts, {
    total: 4,
    probed: 1,
    unprobed: 1,
    rejected: 2,
  });
  assert.equal(report.candidates[0]?.id, "alpha");
});

test("registry review --out writes only the report file", async () => {
  const dir = tmpCache();
  writeSnapshot(dir);
  writeManifest(dir);
  const before = readdirSync(dir).sort();
  const out = join(dir, "review.json");

  const jsonRun = await capture(() =>
    registryReview(["--cache-dir", dir, "--json"]),
  );
  const expected = ReviewReportSchema.parse(
    JSON.parse(jsonRun.logs.join("\n")) as unknown,
  );

  const { errors } = await capture(() =>
    registryReview(["--cache-dir", dir, "--json", "--out", out]),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(readdirSync(dir).sort(), [...before, "review.json"].sort());
  const written = ReviewReportSchema.parse(
    JSON.parse(readFileSync(out, "utf8")) as unknown,
  );
  assert.deepEqual(
    { ...written, generatedAt: expected.generatedAt },
    expected,
    "the written report must match stdout except for its generation time",
  );
});

test("registry review text output lists evidence and is not a certification", async () => {
  const dir = tmpCache();
  writeSnapshot(dir);
  writeManifest(dir);

  const { logs, errors } = await capture(() =>
    registryReview(["--cache-dir", dir]),
  );

  assert.deepEqual(errors, []);
  const text = logs.join("\n");
  assert.match(text, /1 probed, 1 unprobed, 2 rejected/);
  assert.match(text, /alpha \(Alpha Skill\) \[skill\] trust=verified/);
  assert.match(text, /license: Apache-2\.0/);
  assert.match(text, /pin: v1\.2\.3/);
  assert.match(text, /evidence: https:\/\/raw\.githubusercontent\.com\/acme\/alpha/);
  assert.match(text, /snippet: name: alpha/);
  assert.match(text, /rejected-groups:/);
  assert.match(text, /2x ARTIFACT_MISSING: 404/);
  assert.match(text, /not a certification/);
});

test("registry review exits 1 when no snapshot is available", async () => {
  const dir = tmpCache();
  const { logs, errors } = await capture(() =>
    registryReview(["--cache-dir", dir, "--json"]),
  );
  assert.deepEqual(logs, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /no candidates to review/);
});

test("registry review exits 1 when the cached snapshot is invalid", async () => {
  const dir = tmpCache();
  writeFileSync(join(dir, SNAPSHOT_FILENAME), "{not json");
  writeManifest(dir);
  const { logs, errors } = await capture(() =>
    registryReview(["--cache-dir", dir, "--json"]),
  );
  assert.deepEqual(logs, []);
  assert.match(errors[0] ?? "", /registry review failed/);
});

test("registry review exits 1 when the manifest is invalid", async () => {
  const dir = tmpCache();
  writeSnapshot(dir);
  writeFileSync(join(dir, MANIFEST_FILENAME), "{not json");
  const { logs, errors } = await capture(() =>
    registryReview(["--cache-dir", dir, "--json"]),
  );
  assert.deepEqual(logs, []);
  assert.match(errors[0] ?? "", /registry review failed/);
});

test("registry review exits 2 on usage errors", async () => {
  const unknown = await capture(() => registryReview(["--nope"]));
  assert.match(unknown.errors[0] ?? "", /unknown argument/);

  const missingOut = await capture(() => registryReview(["--out"]));
  assert.match(missingOut.errors[0] ?? "", /unknown argument/);
});

test("main dispatches registry review", async () => {
  const dir = tmpCache();
  writeSnapshot(dir);
  let code = -1;
  const { logs, errors } = await capture(async () => {
    code = await main(["registry", "review", "--cache-dir", dir, "--json"]);
  });
  assert.deepEqual(errors, []);
  assert.equal(code, 0);
  const report = ReviewReportSchema.parse(
    JSON.parse(logs.join("\n")) as unknown,
  );
  assert.equal(report.snapshotGeneratedAt, AT);
});

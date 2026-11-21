import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "@plugin-detector/registry";
import type { Candidate, CapabilityRecord } from "@plugin-detector/core";
import {
  explain,
  type ExplainDeps,
  type ExplainResult,
} from "../src/commands/explain.js";
import {
  ExplainJsonSchema,
  InstalledExplainJsonSchema,
} from "../src/output.js";

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
  artifactProbed: true,
  artifactEvidence: {
    kind: "skill",
    sourceUrl: "https://example.com/cand-explain/SKILL.md",
    resolvedRef: "v2.1.0",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: "Explain Candidate",
    capabilities: [],
    evidenceSnippets: ["name: Explain Candidate"],
    retrievedAt: "2026-11-01T00:00:00.000Z",
  },
  provenance: "official",
  risk: "low",
  maintenance: "active",
  auditStatus: "clean",
  popularity: { stars: 42 },
  rawUntrustedCopy: "SECRET-UNTRUSTED-MARKER buy now!!!",
};

function writeSnapshot(cache: string, candidates: Candidate[] = [CANDIDATE]): void {
  const snapshot = buildSnapshot(
    candidates.map((candidate) => ({
      candidate,
      sourceUrl: candidate.sources[0] ?? "",
    })),
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

// Unit fixtures stay host-independent; the external CLI probe is injected by
// the dedicated test below and by production without explicit deps.
function runExplain(
  args: string[],
  deps: ExplainDeps = {},
): Promise<ExplainResult> {
  return explain(args, { externalTools: () => [], ...deps });
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
      await runExplain([
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
  assert.equal(parsed.facts.kind, "candidate");
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
      await runExplain([
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
      await runExplain(["missing-id", "--cache-dir", env.cache, "--home", env.home])
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
    runExplain([
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

const INSTALLED_ID = "opencode:skill:project:old-review";

const REPLACEMENT: Candidate = {
  ...CANDIDATE,
  id: "new-review",
  name: "new-review",
  capabilities: ["code-review.quality", "code-review.security"],
  pinnedRef: "v2.0.0",
  artifactEvidence: {
    ...(CANDIDATE.artifactEvidence as NonNullable<
      Candidate["artifactEvidence"]
    >),
    name: "new-review",
    resolvedRef: "v2.0.0",
    version: "2.0.0",
  },
};

function writeInstalledReview(root: string): void {
  const dir = join(root, ".opencode", "skills", "old-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: old-review\nversion: 1.0.0\ncapabilities: [code-review.quality]\n---\n# old-review\n",
  );
}

test("explain accepts an installed artifact id and shows lifecycle evidence", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REPLACEMENT]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await runExplain(
        [
          INSTALLED_ID,
          "--cache-dir",
          env.cache,
          "--home",
          env.home,
          "--root",
          env.root,
          "--check-updates",
          "--json",
        ],
        {
          resolveLatest: async () => ({
            version: "1.1.0",
            sourceUrl: "https://example.com/latest",
          }),
        },
      )
    ).exitCode;
  });
  assert.equal(code, 0);
  const parsed = InstalledExplainJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.kind, "installed");
  assert.equal(parsed.facts.installedId, INSTALLED_ID);
  assert.equal(parsed.facts.artifactKind, "skill");
  assert.equal(parsed.facts.installedVersion, "1.0.0");
  assert.equal(parsed.facts.latestVersion, "2.0.0");
  assert.equal(parsed.facts.updateStatus, "unknown");
  assert.equal(parsed.facts.action, "replace");
  assert.equal(parsed.facts.candidateId, "new-review");
  assert.deepEqual(parsed.facts.capabilitiesAdded, ["code-review.security"]);
  assert.ok(parsed.facts.reasons.length > 0);
});

test("explain text shows installed version, latest, status and action", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REPLACEMENT]);
  const { logs } = await capture(() =>
    runExplain(
      [
        INSTALLED_ID,
        "--cache-dir",
        env.cache,
        "--home",
        env.home,
        "--root",
        env.root,
        "--check-updates",
      ],
      {
        resolveLatest: async () => ({
          version: "1.1.0",
          sourceUrl: "https://example.com/latest",
        }),
      },
    ),
  );
  const text = logs.join("\n");
  for (const needle of [
    `installed: ${INSTALLED_ID}`,
    "installed-version: 1.0.0",
    "latest-version: 2.0.0",
    "update-status: unknown",
    "action: replace",
    "candidate: new-review",
    "capabilities-added: code-review.security",
    "reason:",
  ]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
});

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

test("explain resolves a curated external CLI and shows version plus keep", async () => {
  const env = setup();
  writeSnapshot(env.cache);
  const deps: ExplainDeps = { externalTools: () => [EXTERNAL_JQ] };

  let code = -1;
  const json = await capture(async () => {
    code = (
      await runExplain(
        [
          "external:cli:jq",
          "--cache-dir",
          env.cache,
          "--home",
          env.home,
          "--root",
          env.root,
          "--json",
        ],
        deps,
      )
    ).exitCode;
  });
  assert.equal(code, 0);
  const parsed = InstalledExplainJsonSchema.parse(
    JSON.parse(json.logs.join("\n")),
  );
  assert.equal(parsed.facts.kind, "installed");
  assert.equal(parsed.facts.installedId, "external:cli:jq");
  assert.equal(parsed.facts.harness, "unknown");
  assert.equal(parsed.facts.artifactKind, "cli");
  assert.equal(parsed.facts.installedVersion, "1.7");
  assert.equal(parsed.facts.action, "keep");
  assert.equal(parsed.facts.candidateId, undefined);

  const text = await capture(() =>
    runExplain(
      [
        "external:cli:jq",
        "--cache-dir",
        env.cache,
        "--home",
        env.home,
        "--root",
        env.root,
      ],
      deps,
    ),
  );
  assert.match(text.logs.join("\n"), /installed: external:cli:jq/);
  assert.match(text.logs.join("\n"), /installed-version: 1\.7/);
  assert.match(text.logs.join("\n"), /action: keep/);
});

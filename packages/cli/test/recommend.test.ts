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
import type { Candidate, CapabilityRecord } from "@plugin-detector/core";
import {
  recommend,
  type RecommendDeps,
  type RecommendResult,
} from "../src/commands/recommend.js";
import { buildAdapters } from "../src/commands/inventory.js";
import { buildLifecycleRows } from "../src/lifecycle.js";
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
    artifactProbed: true,
    artifactEvidence: {
      kind: "skill",
      sourceUrl: `https://example.com/${id}/SKILL.md`,
      resolvedRef: "v1.0.0",
      contentHash: "a".repeat(64),
      license: "MIT",
      name: `Candidate ${id}`,
      capabilities: [],
      evidenceSnippets: [`name: Candidate ${id}`],
      retrievedAt: "2026-11-01T00:00:00.000Z",
    },
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

// Unit fixtures stay host-independent; the real probe is injected only by the
// acceptance test. Production recommends without explicit deps.
function runRecommend(
  args: string[],
  deps: RecommendDeps = {},
): Promise<RecommendResult> {
  return recommend(args, { externalTools: () => [], ...deps });
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
    code = (await runRecommend([...baseArgs(env), "--json"])).exitCode;
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

test("mirror candidates with the same name keep one top-5 slot", async () => {
  const env = setup();
  const duplicated = candidate("dup-a");
  const mirror = candidate("dup-b", {
    name: duplicated.name,
    capabilities: ["testing.runner", "code-review.quality"],
  });
  writeSnapshot(env.cache, [
    duplicated,
    mirror,
    ...Array.from({ length: 4 }, (_, i) => candidate(`cand-${i + 2}`)),
  ]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await runRecommend([...baseArgs(env), "--json"])).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.recommendations.length, 5);
  const names = parsed.facts.recommendations.map((r) => r.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.equal(
    parsed.facts.recommendations.filter(
      (r) => r.name === duplicated.name,
    ).length,
    1,
  );
});

test("empty snapshot emits the exact no-good-candidates verdict", async () => {
  const env = setup();
  writeSnapshot(env.cache, []);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (await runRecommend([...baseArgs(env), "--json"])).exitCode;
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
      await runRecommend([
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
    code = (await runRecommend(["--use-case", "nope", "--home", env.home])).exitCode;
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /software-development/);
});

test("adapter compatibility zero hard-gates and never returns required", async () => {
  const env = setup();
  writeSnapshot(env.cache, [
    candidate("cand-1", { artifactType: "tool" }),
    candidate("cand-2"),
  ]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await runRecommend([...baseArgs(env), "--harness", "opencode", "--json"])
    ).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.ok(
    parsed.facts.recommendations.every((r) => r.candidateId !== "cand-1"),
    "incompatible tool must be excluded from the recommendation set",
  );
  assert.ok(
    parsed.facts.recommendations.every((r) => r.verdict !== "required" || r.candidateId !== "cand-1"),
  );
});

test("source-declared unprobed candidates are excluded from recommendations", async () => {
  const env = setup();
  const { artifactEvidence: _evidence, ...unprobed } = candidate("cand-1");
  writeSnapshot(env.cache, [
    { ...unprobed, artifactProbed: false },
    candidate("cand-2"),
  ]);
  const { logs } = await capture(() =>
    runRecommend([...baseArgs(env), "--json"]),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.ok(parsed.facts.recommendations.every((r) => r.candidateId !== "cand-1"));
});

test("legacy verified snapshots without artifact evidence are not recommended", async () => {
  const env = setup();
  const { artifactEvidence: _evidence, ...legacy } = candidate("cand-legacy");
  writeFileSync(
    join(env.cache, "registry-snapshot.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-11-08T00:00:00.000Z",
      candidates: [legacy],
      provenance: [
        {
          id: legacy.id,
          sourceUrl: legacy.sources[0],
          retrievedAt: "2026-11-08T00:00:00.000Z",
          trust: "verified",
        },
      ],
    }),
  );
  const { logs } = await capture(() =>
    runRecommend([...baseArgs(env), "--json"]),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.ok(
    parsed.facts.recommendations.every((r) => r.candidateId !== "cand-legacy"),
  );
});

function customProfileYaml(id: string, threshold: number): string {
  return `id: ${id}
version: 1
displayName: Custom Profile
description: Custom profile for CLI tests.
capabilities:
  - docs.writing
signalQueries:
  - package-manifest
  - pytest
  - project-readme
  - docs-site
  - style-guide
negativeSignals:
  - media-editing-project
defaultDomains:
  - writing
expectedValueTiers:
  - time-saved
requiredThreshold: ${threshold}
`;
}

test("recommend --profile selects the custom profile and applies its threshold", async () => {
  const env = setup();
  const file = join(env.home, "custom.yaml");
  writeFileSync(file, customProfileYaml("custom-docs", 10));
  writeSnapshot(env.cache, [candidate("cand-1")]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await runRecommend([
        "--profile",
        file,
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
        "--json",
      ])
    ).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.useCase, "custom-docs");
  assert.equal(parsed.facts.verdict, "required");
  assert.equal(parsed.facts.recommendations.length, 1);
  assert.ok(
    (parsed.facts.recommendations[0]?.score ?? 100) < 55,
    "required verdict must come from the custom threshold, not the default",
  );
});

test("recommend custom profile wins over a built-in profile with the same id", async () => {
  const env = setup();
  const file = join(env.home, "override.yaml");
  // The custom profile has the same id and a matching capability, but omits
  // the built-in's `tsconfig` signal. Passing only `tsconfig` therefore
  // resolves `partial`; the built-in would resolve `match`.
  writeFileSync(
    file,
    customProfileYaml("software-development", 10).replace(
      "  - docs.writing",
      "  - testing.e2e",
    ),
  );
  writeSnapshot(env.cache, [candidate("cand-1")]);
  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await runRecommend([
        "--profile",
        file,
        "--signal",
        "tsconfig",
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
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.useCase, "software-development");
  assert.equal(parsed.facts.profileStatus, "partial");
});

test("recommend rejects conflicting --use-case and --profile", async () => {
  const env = setup();
  const file = join(env.home, "custom.yaml");
  writeFileSync(file, customProfileYaml("custom-docs", 10));
  let code = -1;
  const { errors } = await capture(async () => {
    code = (
      await runRecommend([
        "--use-case",
        "software-development",
        "--profile",
        file,
        "--home",
        env.home,
      ])
    ).exitCode;
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /conflicts with --profile/);
});

test("recommend exits 1 for a missing or invalid profile", async () => {
  const env = setup();
  let missingCode = -1;
  const missing = await capture(async () => {
    missingCode = (
      await runRecommend([
        "--profile",
        join(env.home, "absent.yaml"),
        "--home",
        env.home,
      ])
    ).exitCode;
  });
  assert.equal(missingCode, 1);
  assert.match(missing.errors.join("\n"), /cannot read profile/);

  const badFile = join(env.home, "bad.yaml");
  writeFileSync(badFile, "id: bad\nversion: nope\n");
  let invalidCode = -1;
  const invalid = await capture(async () => {
    invalidCode = (
      await runRecommend(["--profile", badFile, "--home", env.home])
    ).exitCode;
  });
  assert.equal(invalidCode, 1);
  assert.match(invalid.errors.join("\n"), /invalid profile/);
});

test("recommend rejects a mistyped profile key instead of using the default threshold", async () => {
  const env = setup();
  const file = join(env.home, "typo.yaml");
  writeFileSync(
    file,
    customProfileYaml("typo-profile", 10).replace(
      "requiredThreshold: 10",
      "requiredThreshhold: 10",
    ),
  );
  let code = -1;
  const { errors } = await capture(async () => {
    code = (
      await runRecommend(["--profile", file, "--home", env.home])
    ).exitCode;
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /invalid profile/);
  assert.match(errors.join("\n"), /requiredThreshhold/);
});

function writeInstalledSkill(
  root: string,
  dir: string,
  frontmatter: string,
): void {
  const skillDir = join(root, ".opencode", "skills", dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\n${frontmatter}\n---\n# ${dir}\n`,
  );
}

function writeInstalledPlugin(root: string, name: string, version: string): void {
  const pluginDir = join(root, ".opencode", "plugins", name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name, version }),
  );
}

function lifecycleFixtures(env: { root: string }): void {
  writeInstalledSkill(
    env.root,
    "old-review",
    "name: old-review\nversion: 1.0.0\ncapabilities: [code-review.quality]",
  );
  writeInstalledSkill(
    env.root,
    "keep-skill",
    "name: keep-skill\nversion: 2.0.0\ncapabilities: [testing.runner]",
  );
  writeInstalledPlugin(env.root, "cand-upgrade", "1.0.0");
}

function lifecycleCandidates(): Candidate[] {
  return [
    candidate("cand-upgrade", {
      name: "cand-upgrade",
      artifactType: "plugin",
      packageName: "cand-upgrade",
      capabilities: [],
      pinnedRef: "v1.1.0",
      artifactEvidence: {
        ...(candidate("cand-upgrade").artifactEvidence as NonNullable<
          Candidate["artifactEvidence"]
        >),
        kind: "plugin",
        name: "cand-upgrade",
        version: "1.1.0",
      },
    }),
    candidate("new-review", {
      name: "new-review",
      artifactType: "skill",
      capabilities: ["code-review.quality", "code-review.security"],
      pinnedRef: "v2.0.0",
      artifactEvidence: {
        ...(candidate("new-review").artifactEvidence as NonNullable<
          Candidate["artifactEvidence"]
        >),
        kind: "skill",
        name: "new-review",
        version: "2.0.0",
      },
    }),
    candidate("keep-cand", {
      name: "keep-cand",
      artifactType: "skill",
      capabilities: ["testing.runner"],
      pinnedRef: "v1.0.0",
    }),
  ];
}

test("lifecycle rows stay separate from the top-5 recommendations", async () => {
  const env = setup();
  // Both runs must resolve the same harness; the empty directory only makes
  // the harness detectable.
  mkdirSync(join(env.root, ".opencode"), { recursive: true });
  writeSnapshot(
    env.cache,
    Array.from({ length: 7 }, (_, i) => candidate(`cand-${i + 1}`)),
  );
  const baseline = await capture(() =>
    runRecommend([...baseArgs(env), "--json"]),
  );
  const baselineParsed = RecommendJsonSchema.parse(
    JSON.parse(baseline.logs.join("\n")),
  );

  // A capability-free plugin cannot change overlap or redundancy scoring.
  writeInstalledPlugin(env.root, "acme", "1.0.0");
  const { logs } = await capture(() =>
    runRecommend([...baseArgs(env), "--json"]),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));

  assert.deepEqual(
    parsed.facts.recommendations,
    baselineParsed.facts.recommendations,
  );
  assert.equal(parsed.facts.recommendations.length, 5);
  assert.equal(parsed.facts.lifecycle?.length, 1);
  assert.equal(parsed.facts.lifecycle?.[0]?.action, "keep");
});

test("lifecycle JSON reports replace, upgrade and keep with print-only recipes", async () => {
  const env = setup();
  lifecycleFixtures(env);
  writeSnapshot(env.cache, lifecycleCandidates());
  const resolveLatest = async (): Promise<{
    version: string;
    sourceUrl: string;
  }> => ({ version: "1.1.0", sourceUrl: "https://example.com/latest" });

  let code = -1;
  const { logs } = await capture(async () => {
    code = (
      await runRecommend([...baseArgs(env), "--check-updates", "--json"], {
        resolveLatest,
      })
    ).exitCode;
  });
  assert.equal(code, 0);
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.ok(parsed.facts.lifecycle !== undefined);
  const byId = new Map(
    (parsed.facts.lifecycle ?? []).map((row) => [row.installedId, row]),
  );

  const replaced = byId.get("opencode:skill:project:old-review");
  assert.equal(replaced?.action, "replace");
  assert.equal(replaced?.candidateId, "new-review");
  assert.deepEqual(replaced?.capabilitiesAdded, ["code-review.security"]);
  assert.equal(replaced?.latestVersion, "2.0.0");
  assert.ok((replaced?.reasons.length ?? 0) > 0);

  const upgraded = byId.get("opencode:plugin:project:cand-upgrade");
  assert.equal(upgraded?.action, "upgrade");
  assert.equal(upgraded?.installedVersion, "1.0.0");
  assert.equal(upgraded?.latestVersion, "1.1.0");

  assert.equal(
    byId.get("opencode:skill:project:keep-skill")?.action,
    "keep",
  );
  assert.equal(
    byId.get("opencode:skill:project:keep-skill")?.latestVersion,
    "1.1.0",
    "keep rows keep upstream latest evidence",
  );
  assert.ok(
    replaced?.recipe?.some((step) => step.includes("remove")),
    "replace rows carry a removal recipe",
  );
  assert.ok(
    upgraded?.recipe !== undefined,
    "upgrade rows carry an install recipe",
  );
  assert.equal(
    byId.get("opencode:skill:project:keep-skill")?.recipe,
    undefined,
    "keep rows carry no recipe",
  );
});

test("lifecycle text output names the installed section and actions", async () => {
  const env = setup();
  lifecycleFixtures(env);
  writeSnapshot(env.cache, lifecycleCandidates());
  const { logs } = await capture(() =>
    runRecommend([...baseArgs(env), "--check-updates"], {
      resolveLatest: async () => ({
        version: "1.1.0",
        sourceUrl: "https://example.com/latest",
      }),
    }),
  );
  const text = logs.join("\n");
  assert.match(text, /installed lifecycle:/);
  assert.match(text, /opencode:skill:project:old-review \[replace\]/);
  assert.match(text, /opencode:plugin:project:cand-upgrade \[upgrade\]/);
  assert.match(text, /opencode:skill:project:keep-skill \[keep\]/);
});

test("lifecycle text summarizes keep rows without candidate or update evidence", async () => {
  const env = setup();
  writeInstalledPlugin(env.root, "acme", "1.0.0");
  writeSnapshot(env.cache, [candidate("cand-1")]);

  const json = await capture(() =>
    runRecommend([...baseArgs(env), "--json"]),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(json.logs.join("\n")));
  assert.equal(
    parsed.facts.lifecycle?.[0]?.installedId,
    "opencode:plugin:project:acme",
    "JSON keeps every installed row",
  );

  const text = await capture(() => runRecommend([...baseArgs(env)]));
  const output = text.logs.join("\n");
  assert.ok(!output.includes("opencode:plugin:project:acme"));
  assert.match(output, /1 unchanged installed artifact row\(s\) omitted/);
});

test("lifecycle compatibility comes from each installed record's harness", () => {
  const adapters = buildAdapters("/nonexistent/home", "/nonexistent/root");
  const next = candidate("review-hook", {
    name: "review-hook",
    artifactType: "hook",
    capabilities: ["code-review.quality", "code-review.security"],
    pinnedRef: "v2.0.0",
  });
  const record = (harness: "claude-code" | "opencode"): CapabilityRecord => ({
    id: `${harness}:hook:project:review`,
    name: "review",
    harness,
    kind: "hook",
    capabilities: ["code-review.quality"],
    enabled: true,
    configRefs: [],
    contextCostClass: "per-session",
    version: "1.0.0",
    updateStatus: "outdated",
  });
  const records = [record("claude-code"), record("opencode")];
  const rows = buildLifecycleRows(
    records,
    [{ candidate: next, score: 42 }],
    {
      installedInventory: records,
      profileDomainsFor: () => [
        "code-review.quality",
        "code-review.security",
      ],
      threshold: 40,
      compatibilityFor: (installedRecord, candidateForRecord) =>
        adapters
          .find((adapter) => adapter.harness === installedRecord.harness)
          ?.compatibility(candidateForRecord),
    },
  );
  // Claude scores the hook at 0.7 (42 >= 40); opencode at 0.5 (30 < 40).
  assert.equal(
    rows.find((row) => row.installedId.startsWith("claude-code:"))?.action,
    "replace",
  );
  assert.equal(
    rows.find((row) => row.installedId.startsWith("opencode:"))?.action,
    "keep",
  );
});

test("one candidate never produces both an upgrade and a replace plan", async () => {
  const env = setup();
  writeInstalledSkill(
    env.root,
    "cand-dup",
    "name: cand-dup\nversion: 1.0.0\ncapabilities: [testing.runner]",
  );
  writeInstalledSkill(
    env.root,
    "old-review",
    "name: old-review\nversion: 1.0.0\ncapabilities: [code-review.quality]",
  );
  writeSnapshot(env.cache, [
    candidate("cand-dup", {
      name: "cand-dup",
      artifactType: "skill",
      packageName: "cand-dup",
      capabilities: ["code-review.quality", "code-review.security"],
      pinnedRef: "v2.0.0",
      artifactEvidence: {
        ...(candidate("cand-dup").artifactEvidence as NonNullable<
          Candidate["artifactEvidence"]
        >),
        kind: "skill",
        name: "cand-dup",
        version: "2.0.0",
      },
    }),
  ]);
  const { logs } = await capture(() =>
    runRecommend([...baseArgs(env), "--check-updates", "--json"], {
      resolveLatest: async () => ({
        version: "1.1.0",
        sourceUrl: "https://example.com/latest",
      }),
    }),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  const lifecycle = parsed.facts.lifecycle ?? [];
  const claims = lifecycle.filter((row) => row.candidateId === "cand-dup");
  assert.equal(claims.length, 1);
  assert.equal(claims[0]?.action, "replace");
  assert.equal(
    claims[0]?.installedId,
    "opencode:skill:project:old-review",
    "replace wins over upgrade for the same candidate",
  );
  assert.ok(
    claims[0]?.reasons.some(
      (reason) =>
        reason.includes("also upgrades") &&
        reason.includes("opencode:skill:project:cand-dup"),
    ),
    "the surviving replace row explains the folded upgrade",
  );

  const demoted = lifecycle.find(
    (row) => row.installedId === "opencode:skill:project:cand-dup",
  );
  assert.equal(demoted?.action, "keep");
  assert.equal(demoted?.candidateId, undefined);
  assert.equal(demoted?.latestVersion, undefined);
  assert.equal(demoted?.recipe, undefined);
  assert.deepEqual(demoted?.capabilitiesAdded, []);
  assert.ok(
    demoted?.reasons.some((reason) => reason.includes("already proposed")),
  );
});

test("recommend resolves latest versions only with --check-updates", async () => {
  const env = setup();
  writeSnapshot(env.cache, []);
  writeFileSync(
    join(env.root, "opencode.json"),
    JSON.stringify({ plugin: ["left-pad@1.0.0"] }),
  );
  const seen: string[] = [];
  const resolveLatest = async (input: {
    sourceRef?: string | undefined;
  }): Promise<{ version: string; sourceUrl: string }> => {
    seen.push(input.sourceRef ?? "");
    return { version: "1.1.0", sourceUrl: "https://npm.example/left-pad" };
  };

  let code = -1;
  await capture(async () => {
    code = (await runRecommend([...baseArgs(env), "--json"], { resolveLatest }))
      .exitCode;
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [], "the default recommendation path must stay offline");

  const flagged = await capture(async () => {
    code = (
      await runRecommend([...baseArgs(env), "--check-updates", "--json"], {
        resolveLatest,
      })
    ).exitCode;
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ["left-pad@1.0.0"]);
  assert.match(flagged.logs.join("\n"), /"verdict"/);
});

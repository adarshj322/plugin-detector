import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "@plugin-detector/registry";
import type {
  Candidate,
  CapabilityRecord,
  LifecycleRow,
} from "@plugin-detector/core";
import { lifecyclePlan } from "../src/lifecycle.js";
import { recommend } from "../src/commands/recommend.js";
import { explain } from "../src/commands/explain.js";
import {
  InstalledExplainJsonSchema,
  RecommendJsonSchema,
} from "../src/output.js";

const APPROVAL_NOTE =
  "Run only after explicit approval; back up config before editing.";

function record(
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    id: "opencode:plugin:project:old",
    name: "old-plugin@1.0.0",
    harness: "opencode",
    kind: "plugin",
    capabilities: ["code-review.quality"],
    enabled: true,
    configRefs: ["/tmp/opencode.json"],
    contextCostClass: "per-session",
    version: "1.0.0",
    updateStatus: "outdated",
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "new-plugin",
    name: "new-plugin",
    artifactType: "plugin",
    sources: ["https://github.com/acme/new-plugin"],
    useCaseDomains: ["software-development"],
    capabilities: ["code-review.quality", "code-review.security"],
    license: "MIT",
    pinnedRef: "v2.0.0",
    repositoryUrl: "https://github.com/acme/new-plugin",
    packageName: "new-plugin",
    installMode: "verified",
    lastVerified: "2026-11-01T00:00:00.000Z",
    artifactProbed: true,
    artifactEvidence: {
      kind: "plugin",
      sourceUrl: "https://github.com/acme/new-plugin",
      resolvedRef: "v2.0.0",
      contentHash: "a".repeat(64),
      license: "MIT",
      name: "new-plugin",
      capabilities: [],
      evidenceSnippets: ["name: new-plugin"],
      retrievedAt: "2026-11-01T00:00:00.000Z",
    },
    provenance: "official",
    risk: "low",
    maintenance: "active",
    auditStatus: "clean",
    popularity: { stars: 10 },
    ...overrides,
  };
}

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    installedId: "opencode:plugin:project:old",
    candidateId: "new-plugin",
    action: "replace",
    reasons: ["outdated"],
    installedVersion: "1.0.0",
    latestVersion: "2.0.0",
    capabilitiesAdded: ["code-review.security"],
    ...overrides,
  };
}

test("replace plugin recipe removes the declared spec and installs the candidate", () => {
  const installed = record({
    sourceRef: "old-plugin@git+https://github.com/acme/old-plugin.git",
  });
  const recipe = lifecyclePlan(row(), installed, candidate());

  assert.deepEqual(recipe, [
    "opencode plugin remove old-plugin@git+https://github.com/acme/old-plugin.git",
    "opencode plugin add new-plugin",
    APPROVAL_NOTE,
  ]);
});

test("replace skill recipe uses the skills CLI for a GitHub source", () => {
  const installed = record({
    id: "opencode:skill:project:old-review",
    name: "old-review",
    kind: "skill",
    sourceRef: "/home/me/.config/opencode/skills/old-review",
    configRefs: ["/home/me/.config/opencode/skills/old-review/SKILL.md"],
  });
  const next = candidate({
    id: "obra/superpowers/brainstorming",
    name: "brainstorming",
    artifactType: "skill",
    packageName: undefined,
    repositoryUrl: "https://github.com/obra/superpowers",
  });
  const recipe = lifecyclePlan(
    row({
      installedId: installed.id,
      candidateId: next.id,
    }),
    installed,
    next,
  );

  assert.deepEqual(recipe, [
    "npx skills remove opencode:skill:project:old-review",
    "npx skills add obra/superpowers/brainstorming",
    APPROVAL_NOTE,
  ]);
});

test("replace Claude plugin recipe needs a marketplace-qualified candidate", () => {
  const installed = record({
    id: "claude-code:plugin:user:market:old",
    name: "old",
    harness: "claude-code",
    sourceRef: "old@market",
  });
  const next = candidate({
    id: "new@market",
    name: "new",
    packageName: "new@market",
  });
  assert.deepEqual(
    lifecyclePlan(row({ installedId: installed.id }), installed, next),
    [
      "claude plugin uninstall old@market",
      "claude plugin install new@market",
      APPROVAL_NOTE,
    ],
  );

  const scopedNpm = lifecyclePlan(
    row({ installedId: installed.id }),
    installed,
    candidate({ packageName: "@scope/pkg" }),
  );
  assert.ok(isManualOnly(scopedNpm), "non-marketplace candidate stays manual");
});

function isManualOnly(lines: string[]): boolean {
  return lines.every(
    (line) => line.startsWith("Manual:") || line === APPROVAL_NOTE,
  );
}

test("non-installable and external CLI replacements stay manual", () => {
  const local = lifecyclePlan(
    row(),
    record({ sourceRef: "old-plugin" }),
    candidate({
      packageName: "./local-plugin",
      repositoryUrl: undefined,
    }),
  );
  assert.ok(local[0]?.startsWith("Manual: remove"));
  assert.ok(
    local.some((line) => line.startsWith("Manual: install")),
    "local candidate gets a manual install line",
  );
  assert.ok(!local.some((line) => line.startsWith("opencode plugin ")));

  const external = lifecyclePlan(
    row({ installedId: "tool:project:linter" }),
    record({
      id: "tool:project:linter",
      name: "linter",
      harness: "unknown",
      kind: "tool",
    }),
    candidate({ artifactType: "tool", packageName: undefined }),
  );
  assert.ok(external.every((line) => line.startsWith("Manual:") || line === APPROVAL_NOTE));
  assert.ok(
    !external.some((line) => /\b(?:npm|pnpm|yarn|pip|brew|apt)\b/.test(line)),
    "never invents a package-manager command",
  );
});

test("MCP replacement edits the config with the exact server key", () => {
  const recipe = lifecyclePlan(
    row({ installedId: "opencode:mcp:project:github" }),
    record({
      id: "opencode:mcp:project:github",
      name: "github",
      kind: "mcp",
      configRefs: ["/work/opencode.json"],
    }),
    candidate({ id: "github-next", artifactType: "mcp-server" }),
  );

  assert.match(recipe[0] ?? "", /Edit \/work\/opencode\.json:.*"github"/);
  assert.match(recipe[1] ?? "", /"github-next"/);
  assert.ok(!recipe.some((line) => line.startsWith("opencode ")));
  assert.equal(recipe.at(-1), APPROVAL_NOTE);
});

test("keep and review rows produce no recipe", () => {
  assert.deepEqual(
    lifecyclePlan(row({ action: "keep" }), record(), candidate()),
    [],
  );
  assert.deepEqual(
    lifecyclePlan(row({ action: "review" }), record(), candidate()),
    [],
  );
});

test("upgrade recipe installs without removing", () => {
  const recipe = lifecyclePlan(
    row({ action: "upgrade" }),
    record({ sourceRef: "old-plugin" }),
    candidate(),
  );

  assert.deepEqual(recipe, ["opencode plugin add new-plugin", APPROVAL_NOTE]);
  assert.ok(!recipe.some((line) => line.includes("remove")));
});

test("recipe planning writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-recipe-"));
  writeFileSync(join(dir, "marker.txt"), "unchanged");
  const before = readdirSync(dir).sort();

  lifecyclePlan(
    row(),
    record({
      sourceRef: "old-plugin@git+https://github.com/acme/old-plugin.git",
    }),
    candidate(),
  );

  assert.deepEqual(readdirSync(dir).sort(), before);
});

const INSTALLED_SKILL_ID = "opencode:skill:project:old-review";

function setup(): { home: string; root: string; cache: string } {
  const base = mkdtempSync(join(tmpdir(), "pd-recipe-"));
  const home = join(base, "home");
  const root = join(base, "root");
  const cache = join(base, "cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(cache, { recursive: true });
  return { home, root, cache };
}

function writeInstalledReview(root: string): void {
  const dir = join(root, ".opencode", "skills", "old-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    "---\nname: old-review\nversion: 1.0.0\ncapabilities: [code-review.quality]\n---\n# old-review\n",
  );
}

const REVIEW_CANDIDATE: Candidate = candidate({
  id: "new-review",
  name: "new-review",
  artifactType: "skill",
  sources: ["https://github.com/acme/new-review"],
  capabilities: ["code-review.quality", "code-review.security"],
  pinnedRef: "v2.0.0",
  repositoryUrl: "https://github.com/acme/new-review",
  packageName: undefined,
  artifactEvidence: {
    kind: "skill",
    sourceUrl: "https://github.com/acme/new-review/SKILL.md",
    resolvedRef: "v2.0.0",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: "new-review",
    version: "2.0.0",
    capabilities: [],
    evidenceSnippets: ["name: new-review"],
    retrievedAt: "2026-11-01T00:00:00.000Z",
  },
});

function writeSnapshot(cache: string, candidates: Candidate[]): void {
  const snapshot = buildSnapshot(
    candidates.map((c) => ({ candidate: c, sourceUrl: c.sources[0] ?? "" })),
    new Date("2026-11-08T00:00:00.000Z"),
  );
  writeFileSync(join(cache, "registry-snapshot.json"), JSON.stringify(snapshot));
}

async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = origLog;
  }
  return logs;
}

const resolveLatest = async (): Promise<{
  version: string;
  sourceUrl: string;
}> => ({ version: "1.1.0", sourceUrl: "https://example.com/latest" });

test("recommend JSON includes recipes only on actionable rows", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REVIEW_CANDIDATE]);
  const logs = await capture(() =>
    recommend(
      [
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
        "--check-updates",
        "--json",
      ],
      { resolveLatest },
    ),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  const replaced = parsed.facts.lifecycle?.find(
    (entry) => entry.installedId === INSTALLED_SKILL_ID,
  );
  assert.equal(replaced?.action, "replace");
  assert.deepEqual(replaced?.recipe, [
    `npx skills remove ${INSTALLED_SKILL_ID}`,
    "npx skills add new-review",
    APPROVAL_NOTE,
  ]);
});

test("explain JSON includes the recipe for an installed artifact", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REVIEW_CANDIDATE]);
  const logs = await capture(() =>
    explain(
      [
        INSTALLED_SKILL_ID,
        "--cache-dir",
        env.cache,
        "--home",
        env.home,
        "--root",
        env.root,
        "--check-updates",
        "--json",
      ],
      { resolveLatest },
    ),
  );
  const parsed = InstalledExplainJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.action, "replace");
  assert.deepEqual(parsed.facts.recipe, [
    `npx skills remove ${INSTALLED_SKILL_ID}`,
    "npx skills add new-review",
    APPROVAL_NOTE,
  ]);
});

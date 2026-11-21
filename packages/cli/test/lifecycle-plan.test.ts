import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
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
    id: "opencode:plugin:global:old",
    name: "old-plugin@1.0.0",
    harness: "opencode",
    kind: "plugin",
    capabilities: ["code-review.quality"],
    enabled: true,
    configRefs: ["/home/me/.config/opencode/opencode.json"],
    contextCostClass: "per-session",
    version: "1.0.0",
    sourceRef: "old-plugin@1.0.0",
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
    installedId: "opencode:plugin:global:old",
    candidateId: "new-plugin",
    action: "replace",
    reasons: ["outdated"],
    installedVersion: "1.0.0",
    latestVersion: "2.0.0",
    capabilitiesAdded: ["code-review.security"],
    ...overrides,
  };
}

const SKILL_CANDIDATE: Candidate = candidate({
  id: "acme/skills/brainstorming",
  name: "brainstorming",
  artifactType: "skill",
  packageName: undefined,
  repositoryUrl: "https://github.com/acme/skills",
  sources: ["https://github.com/acme/skills"],
  artifactEvidence: {
    kind: "skill",
    sourceUrl: "https://github.com/acme/skills/blob/main/brainstorming/SKILL.md",
    resolvedRef: "v2.0.0",
    contentHash: "a".repeat(64),
    license: "MIT",
    name: "brainstorming",
    capabilities: [],
    evidenceSnippets: ["name: brainstorming"],
    retrievedAt: "2026-11-01T00:00:00.000Z",
  },
});

function skillRecord(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return record({
    id: "opencode:skill:project:old-review",
    name: "old-review",
    kind: "skill",
    sourceRef: "/home/me/.config/opencode/skills/old-review",
    installPath: "/home/me/.config/opencode/skills/old-review",
    configRefs: ["/home/me/.config/opencode/skills/old-review/SKILL.md"],
    ...overrides,
  });
}

test("replace global OpenCode plugin removes the declared spec and adds the candidate", () => {
  const recipe = lifecyclePlan(row(), record(), candidate());

  assert.deepEqual(recipe, [
    "Back up /home/me/.config/opencode/opencode.json before making changes.",
    "opencode plugin remove old-plugin@1.0.0",
    "opencode plugin add new-plugin",
    "Rollback: restore /home/me/.config/opencode/opencode.json from that backup.",
    APPROVAL_NOTE,
  ]);
});

test("replace skill uses a bare installed name and an owner/repo@skill add spec", () => {
  const recipe = lifecyclePlan(
    row({
      installedId: "opencode:skill:project:old-review",
      candidateId: SKILL_CANDIDATE.id,
    }),
    skillRecord(),
    SKILL_CANDIDATE,
  );

  assert.deepEqual(recipe, [
    "Back up /home/me/.config/opencode/skills/old-review before making changes.",
    "npx skills remove -a opencode old-review",
    "npx skills add -a opencode acme/skills@brainstorming",
    "Rollback: restore /home/me/.config/opencode/skills/old-review from that backup.",
    APPROVAL_NOTE,
  ]);
  assert.ok(!recipe.some((line) => line.includes("opencode:skill:")));
});

test("skills commands add -g for user-scope installs", () => {
  const global = skillRecord({ id: "opencode:skill:global:old-review" });
  const recipe = lifecyclePlan(
    row({
      installedId: global.id,
      candidateId: SKILL_CANDIDATE.id,
    }),
    global,
    SKILL_CANDIDATE,
  );
  assert.deepEqual(recipe, [
    "Back up /home/me/.config/opencode/skills/old-review before making changes.",
    "npx skills remove -g -a opencode old-review",
    "npx skills add -g -a opencode acme/skills@brainstorming",
    "Rollback: restore /home/me/.config/opencode/skills/old-review from that backup.",
    APPROVAL_NOTE,
  ]);

  const user = skillRecord({ id: "claude-code:skill:user:old-review", harness: "claude-code" });
  assert.deepEqual(
    lifecyclePlan(
      row({ installedId: user.id, candidateId: SKILL_CANDIDATE.id }),
      user,
      SKILL_CANDIDATE,
    ),
    [
      "Back up /home/me/.config/opencode/skills/old-review before making changes.",
      "npx skills remove -g -a claude-code old-review",
      "npx skills add -g -a claude-code acme/skills@brainstorming",
      "Rollback: restore /home/me/.config/opencode/skills/old-review from that backup.",
      APPROVAL_NOTE,
    ],
  );
});

test("project OpenCode plugin replace edits config instead of using global CLI", () => {
  const installed = record({
    id: "opencode:plugin:project:old",
    configRefs: ["/work/opencode.json"],
  });
  const recipe = lifecyclePlan(row({ installedId: installed.id }), installed, candidate());

  assert.deepEqual(recipe, [
    "Back up /work/opencode.json before making changes.",
    'Edit /work/opencode.json: remove "old-plugin@1.0.0" from the "plugin" array.',
    'Edit /work/opencode.json: add "new-plugin" to the "plugin" array.',
    "Rollback: restore /work/opencode.json from that backup.",
    APPROVAL_NOTE,
  ]);
  assert.ok(!recipe.some((line) => line.startsWith("opencode plugin")));

  const local = record({
    id: "opencode:plugin:local:old",
    configRefs: ["/work/opencode.jsonc"],
  });
  assert.deepEqual(
    lifecyclePlan(row({ installedId: local.id }), local, candidate()),
    [
      "Back up /work/opencode.jsonc before making changes.",
      'Edit /work/opencode.jsonc: remove "old-plugin@1.0.0" from the "plugin" array.',
      'Edit /work/opencode.jsonc: add "new-plugin" to the "plugin" array.',
      "Rollback: restore /work/opencode.jsonc from that backup.",
      APPROVAL_NOTE,
    ],
  );
});

test("Claude plugin commands carry the installed scope", () => {
  const user = record({
    id: "claude-code:plugin:user:market:old",
    name: "old",
    harness: "claude-code",
    sourceRef: "old@market",
    configRefs: ["/home/me/.claude.json"],
  });
  const next = candidate({
    id: "new@market",
    name: "new",
    packageName: "new@market",
  });
  assert.deepEqual(
    lifecyclePlan(row({ installedId: user.id, candidateId: next.id }), user, next),
    [
      "Back up /home/me/.claude.json before making changes.",
      "claude plugin uninstall --scope user --keep-data old@market",
      "claude plugin install --scope user new@market",
      "Rollback: restore /home/me/.claude.json from that backup.",
      APPROVAL_NOTE,
    ],
  );

  const project = record({
    ...user,
    id: "claude-code:plugin:project:market:old",
    configRefs: ["/work/.claude/settings.json"],
  });
  assert.deepEqual(
    lifecyclePlan(
      row({ installedId: project.id, candidateId: next.id }),
      project,
      next,
    ),
    [
      "Back up /work/.claude/settings.json before making changes.",
      "claude plugin uninstall --scope project --keep-data old@market",
      "claude plugin install --scope project new@market",
      "Rollback: restore /work/.claude/settings.json from that backup.",
      APPROVAL_NOTE,
    ],
  );

  for (const packageName of ["new@1.0.0", "new@v1"]) {
    const pinned = lifecyclePlan(
      row({ installedId: user.id, candidateId: next.id }),
      user,
      candidate({ id: "new@market", name: "new", packageName }),
    );
    assert.ok(
      isManualOnly(pinned),
      `${packageName} is an npm pin, not a marketplace id`,
    );
    assert.ok(!pinned.some((line) => line.startsWith("claude plugin")));
  }

  const unknown = record({
    ...user,
    id: "claude-code:plugin:unknown:market:old",
    configRefs: [],
  });
  const manual = lifecyclePlan(
    row({ installedId: unknown.id, candidateId: next.id }),
    unknown,
    next,
  );
  assert.ok(isManualOnly(manual));
  assert.ok(!manual.some((line) => line.startsWith("claude plugin")));
});

test("unknown installed scope falls back to manual", () => {
  const unknownSkill = skillRecord({
    id: "opencode:skill:unknown:old-review",
    configRefs: [],
  });
  const skillRecipe = lifecyclePlan(
    row({
      installedId: unknownSkill.id,
      candidateId: SKILL_CANDIDATE.id,
    }),
    unknownSkill,
    SKILL_CANDIDATE,
  );
  assert.ok(isManualOnly(skillRecipe));
  assert.ok(!skillRecipe.some((line) => line.startsWith("npx skills")));

  const unknownPlugin = record({
    id: "claude-code:plugin:unknown:market:old",
    name: "old",
    harness: "claude-code",
    sourceRef: "old@market",
    configRefs: ["/work/.claude/settings.json"],
  });
  const pluginRecipe = lifecyclePlan(
    row({
      installedId: unknownPlugin.id,
      candidateId: "new@market",
    }),
    unknownPlugin,
    candidate({ id: "new@market", name: "new", packageName: "new@market" }),
  );
  assert.ok(isManualOnly(pluginRecipe));
  assert.ok(
    !pluginRecipe.some((line) => line.startsWith("claude plugin")),
    "unknown Claude scope must not default to --scope user",
  );
});

test("upgrade recipes use update commands without removal", () => {
  const plugin = lifecyclePlan(
    row({ action: "upgrade" }),
    record(),
    candidate(),
  );
  assert.deepEqual(plugin, [
    "Back up /home/me/.config/opencode/opencode.json before making changes.",
    "opencode plugin update old-plugin@1.0.0",
    "Rollback: restore /home/me/.config/opencode/opencode.json from that backup.",
    APPROVAL_NOTE,
  ]);

  const skill = lifecyclePlan(
    row({ action: "upgrade", installedId: "opencode:skill:project:old-review" }),
    skillRecord(),
    SKILL_CANDIDATE,
  );
  assert.deepEqual(skill, [
    "Back up /home/me/.config/opencode/skills/old-review before making changes.",
    "npx skills update -a opencode old-review",
    "Rollback: restore /home/me/.config/opencode/skills/old-review from that backup.",
    APPROVAL_NOTE,
  ]);

  const userSkill = skillRecord({ id: "claude-code:skill:user:old-review", harness: "claude-code" });
  assert.deepEqual(
    lifecyclePlan(
      row({ action: "upgrade", installedId: userSkill.id }),
      userSkill,
      SKILL_CANDIDATE,
    ),
    [
      "Back up /home/me/.config/opencode/skills/old-review before making changes.",
      "npx skills update -g -a claude-code old-review",
      "Rollback: restore /home/me/.config/opencode/skills/old-review from that backup.",
      APPROVAL_NOTE,
    ],
  );

  const claude = lifecyclePlan(
    row({ action: "upgrade", installedId: "claude-code:plugin:user:market:old" }),
    record({
      id: "claude-code:plugin:user:market:old",
      name: "old",
      harness: "claude-code",
      sourceRef: "old@market",
      configRefs: ["/home/me/.claude.json"],
    }),
    candidate({ id: "new@market", name: "new", packageName: "new@market" }),
  );
  assert.deepEqual(claude, [
    "Back up /home/me/.claude.json before making changes.",
    "claude plugin update --scope user old@market",
    "Rollback: restore /home/me/.claude.json from that backup.",
    APPROVAL_NOTE,
  ]);
  for (const recipe of [plugin, skill, claude]) {
    assert.ok(!recipe.some((line) => line.includes("remove")));
  }
});

test("local installed plugin removal is manual, never a CLI path argument", () => {
  const localPath = "/home/me/.config/opencode/plugins/local-plugin";
  const installed = record({
    sourceRef: localPath,
    installPath: localPath,
  });
  const recipe = lifecyclePlan(row(), installed, candidate());

  assert.match(recipe[0] ?? "", /Back up .*local-plugin/);
  assert.ok(recipe[0]?.includes(localPath));
  assert.match(recipe[1] ?? "", /Manual: delete the local plugin/);
  assert.ok(recipe.some((line) => line.startsWith("Manual: install")));
  assert.match(
    recipe.at(-2) ?? "",
    /Rollback: restore .*local-plugin from that backup\./,
  );
  assert.ok(!recipe.some((line) => line.startsWith("opencode plugin")));

  const upgrade = lifecyclePlan(
    row({ action: "upgrade" }),
    installed,
    candidate(),
  );
  assert.match(upgrade[1] ?? "", /Manual: update the local plugin/);
  assert.ok(!upgrade.some((line) => line.startsWith("opencode plugin")));
});

test("external CLI and unknown-harness replacements stay manual", () => {
  const external = record({
    id: "external:cli:git",
    name: "git",
    harness: "unknown",
    kind: "cli",
    capabilities: ["vcs.workflow"],
    sourceRef: "PATH:git",
    installPath: "/usr/bin/git",
  });
  const recipe = lifecyclePlan(
    row({ installedId: external.id }),
    external,
    candidate({ artifactType: "tool", packageName: undefined }),
  );
  assert.match(recipe[0] ?? "", /^Back up /);
  assert.ok(recipe.some((line) => line.startsWith("Manual: remove")));
  assert.ok(recipe.some((line) => line.startsWith("Manual: install")));
  assert.ok(recipe.some((line) => line.startsWith("Rollback: restore ")));
  assert.ok(isManualOnly(recipe));
  assert.ok(
    !recipe.some((line) => /\b(?:npm|pnpm|yarn|pip|brew|apt)\b/.test(line)),
    "never invents a package-manager command",
  );

  const unknownHarness = record({
    id: "tool:project:linter",
    name: "linter",
    harness: "unknown",
    kind: "tool",
  });
  const upgrade = lifecyclePlan(
    row({ action: "upgrade", installedId: unknownHarness.id }),
    unknownHarness,
    candidate({ artifactType: "tool" }),
  );
  assert.ok(isManualOnly(upgrade));
  assert.match(upgrade[1] ?? "", /^Manual: upgrade/);
});

test("shell metacharacters and control characters force manual recipes", () => {
  const unsafeSource = record({ sourceRef: "old;rm -rf /" });
  const unsafeSourceRecipe = lifecyclePlan(
    row({ installedId: unsafeSource.id }),
    unsafeSource,
    candidate(),
  );
  assert.ok(isManualOnly(unsafeSourceRecipe));
  assert.ok(
    !unsafeSourceRecipe.some((line) => line.startsWith("opencode plugin")),
  );

  for (const packageName of [
    "evil$(whoami)",
    "evil|pipe",
    "evil`id`",
    "--global",
  ]) {
    const recipe = lifecyclePlan(
      row(),
      record(),
      candidate({ packageName }),
    );
    assert.ok(isManualOnly(recipe), `${packageName} must stay manual`);
    assert.ok(!recipe.some((line) => line.startsWith("opencode plugin add")));
  }

  const unsafeSkill = skillRecord({
    name: "old\nreview",
    sourceRef: undefined,
    installPath: undefined,
    configRefs: [],
  });
  const skillRecipe = lifecyclePlan(
    row({ installedId: unsafeSkill.id, candidateId: SKILL_CANDIDATE.id }),
    unsafeSkill,
    SKILL_CANDIDATE,
  );
  assert.ok(isManualOnly(skillRecipe));
  assert.ok(!skillRecipe.some((line) => line.startsWith("npx skills")));
  assert.ok(skillRecipe.every((line) => !line.includes("\n")));
});

test("MCP recipes escape server keys and emit no shell command", () => {
  const installed = record({
    id: "opencode:mcp:project:github",
    name: 'bad"key',
    kind: "mcp",
    sourceRef: undefined,
    configRefs: ["/work/opencode.json"],
  });
  const next = candidate({
    id: 'next"key',
    name: "next",
    artifactType: "mcp-server",
    packageName: undefined,
    repositoryUrl: "https://example.com/next",
  });
  const recipe = lifecyclePlan(row({ installedId: installed.id }), installed, next);

  assert.match(recipe[0] ?? "", /^Back up \/work\/opencode\.json/);
  assert.equal(
    recipe[1],
    'Edit /work/opencode.json: remove the "bad\\"key" server entry.',
  );
  assert.ok(recipe[2]?.includes('"next\\"key"'));
  assert.match(
    recipe.at(-2) ?? "",
    /^Rollback: restore \/work\/opencode\.json from that backup\.$/,
  );
  assert.equal(recipe.at(-1), APPROVAL_NOTE);
  assert.ok(!recipe.some((line) => line.startsWith("opencode ")));
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

function isManualOnly(lines: string[]): boolean {
  return lines.every(
    (line) =>
      line.startsWith("Manual:") ||
      line.startsWith("Back up ") ||
      line.startsWith("Rollback: restore ") ||
      line === APPROVAL_NOTE,
  );
}

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

test("recommend JSON includes CLI-shaped recipes only on actionable rows", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REVIEW_CANDIDATE]);
  const logs = await capture(() =>
    recommend(
      [...baseArgs(env), "--check-updates", "--json"],
      { resolveLatest, externalTools: () => [] },
    ),
  );
  const parsed = RecommendJsonSchema.parse(JSON.parse(logs.join("\n")));
  const replaced = parsed.facts.lifecycle?.find(
    (entry) => entry.installedId === INSTALLED_SKILL_ID,
  );
  assert.equal(replaced?.action, "replace");
  const skillDir = join(env.root, ".opencode", "skills", "old-review");
  assert.deepEqual(replaced?.recipe, [
    `Back up ${skillDir} before making changes.`,
    "npx skills remove -a opencode old-review",
    "npx skills add -a opencode acme/new-review@new-review",
    `Rollback: restore ${skillDir} from that backup.`,
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
      { resolveLatest, externalTools: () => [] },
    ),
  );
  const parsed = InstalledExplainJsonSchema.parse(JSON.parse(logs.join("\n")));
  assert.equal(parsed.facts.action, "replace");
  const skillDir = join(env.root, ".opencode", "skills", "old-review");
  assert.deepEqual(parsed.facts.recipe, [
    `Back up ${skillDir} before making changes.`,
    "npx skills remove -a opencode old-review",
    "npx skills add -a opencode acme/new-review@new-review",
    `Rollback: restore ${skillDir} from that backup.`,
    APPROVAL_NOTE,
  ]);
});

test("generating recipes through recommend and explain writes no files", async () => {
  const env = setup();
  writeInstalledReview(env.root);
  writeSnapshot(env.cache, [REVIEW_CANDIDATE]);
  const before = [hashTree(env.home), hashTree(env.root), hashTree(env.cache)];

  const recommendLogs = await capture(() =>
    recommend(
      [...baseArgs(env), "--check-updates", "--json"],
      { resolveLatest, externalTools: () => [] },
    ),
  );
  const parsed = RecommendJsonSchema.parse(
    JSON.parse(recommendLogs.join("\n")),
  );
  assert.ok(
    parsed.facts.lifecycle?.some((entry) => entry.recipe !== undefined),
    "the run exercised recipe generation",
  );
  await capture(() =>
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
      ],
      { resolveLatest, externalTools: () => [] },
    ),
  );

  assert.deepEqual(
    [hashTree(env.home), hashTree(env.root), hashTree(env.cache)],
    before,
    "recipe generation never touches the filesystem",
  );
});

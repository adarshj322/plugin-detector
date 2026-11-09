import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Release-surface contract. Runs from packages/cli/dist/test/ after the normal
// `npm test` build, exactly like workspace-lock.test.ts.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const PUBLISHED_PACKAGES = [
  "packages/core",
  "packages/adapters/shared",
  "packages/adapters/opencode",
  "packages/adapters/claude-code",
  "packages/adapters/codex",
  "packages/adapters/cursor",
  "packages/profiles",
  "packages/registry",
  "packages/cli",
  "packages/skill",
] as const;

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  private?: boolean;
  license?: string;
  files?: string[];
  bin?: Record<string, string>;
  exports?: Record<string, string>;
  engines?: { node?: string };
  publishConfig?: { access?: string; provenance?: boolean };
  repository?: { url?: string; directory?: string };
  dependencies?: Record<string, string>;
  workspaces?: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
}

function readText(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function nodeFloor(range: string | undefined): number {
  assert.ok(range, "engines.node is required");
  const match = /^>=\s*(\d+)/.exec(range);
  assert.ok(match, `unsupported engines.node range: ${range}`);
  return Number(match[1]);
}

// npm pack --dry-run is the only reliable statement about what will ship: the
// `files` field is a filter, not a guarantee (npm always adds package.json, and
// an .npmignore/gitignore fallback can change the result).
function packedFiles(dir: string): string[] {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(ROOT, dir),
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "error" },
  });
  const parsed = JSON.parse(raw) as { files: { path: string }[] }[];
  assert.equal(parsed.length, 1, `${dir}: expected exactly one pack result`);
  return parsed[0]!.files.map((file) => file.path);
}

function assertNoDevOrSecretFiles(dir: string, files: string[]): void {
  const forbidden: [RegExp, string][] = [
    [/(^|\/)node_modules\//, "node_modules"],
    [/(^|\/)dist\/test\//, "compiled tests"],
    [/(^|\/)fixtures\//, "fixtures"],
    [/(^|\/)coverage\//, "coverage output"],
    [/(^|\/)\.superpowers\//, "agent workspace"],
    [/(^|\/)docs\/superpowers\//, "agent design/plan docs"],
    [/(^|\/)\.env(\.|$)/, ".env file"],
    [/(^|\/)\.npmrc$/, ".npmrc"],
    [/\.tsbuildinfo$/, "TypeScript build info"],
    [/(^|\/)registry-manifest\.json$/, "local registry manifest"],
    [/^\/home\//, "absolute home path"],
    [/^\/Users\//, "absolute macOS home path"],
    [/^[A-Za-z]:\\/, "absolute Windows path"],
  ];
  for (const file of files) {
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(file, pattern, `${dir}: packed ${label}: ${file}`);
    }
  }
}

test("publishable packages share public, MIT, Node 22 release metadata", () => {
  const root = readJson<PackageJson>("package.json");
  assert.equal(root.private, true, "monorepo root must stay private");
  assert.match(root.version, /^\d+\.\d+\.\d+$/, "root version must be semver");

  for (const dir of PUBLISHED_PACKAGES) {
    const pkg = readJson<PackageJson>(`${dir}/package.json`);
    assert.equal(pkg.version, root.version, `${dir}: lockstep version`);
    assert.equal(pkg.license, "MIT", `${dir}: license`);
    assert.ok(
      typeof pkg.description === "string" && pkg.description.length > 0,
      `${dir}: description is required on the published manifest`,
    );
    assert.notEqual(pkg.private, true, `${dir}: publishable package cannot be private`);
    assert.ok(nodeFloor(pkg.engines?.node) >= 22, `${dir}: Node >= 22`);
    assert.equal(pkg.publishConfig?.access, "public", `${dir}: public access`);
    assert.equal(pkg.publishConfig?.provenance, true, `${dir}: provenance`);
    assert.ok(
      pkg.repository?.url?.includes("github.com/adarshj322/plugin-detector"),
      `${dir}: repository URL is required for npm provenance`,
    );
    assert.equal(pkg.repository?.directory, dir, `${dir}: repository directory`);
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, `${dir}: files field`);
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith("@plugin-detector/")) {
        assert.equal(range, root.version, `${dir}: ${dep} must be pinned to ${root.version}`);
      }
    }
  }
});

test("CLI exposes only the intended binary and unscoped npx name", () => {
  const pkg = readJson<PackageJson>("packages/cli/package.json");
  assert.equal(pkg.name, "plugin-detector");
  assert.deepEqual(pkg.bin, { "plugin-detector": "./dist/src/index.js" });
  assert.deepEqual(pkg.exports, {
    ".": "./dist/src/index.js",
    "./package.json": "./package.json",
  });
  assert.deepEqual(pkg.files, ["dist/src"]);
  assert.match(
    readText("packages/cli/src/index.ts"),
    /PACKAGE_NAME = "plugin-detector"/,
  );
});

test("skill, registry data, and release docs are present in the repo", () => {
  const skill = readJson<PackageJson>("packages/skill/package.json");
  for (const entry of ["SKILL.md", "agents", "assets", "scripts"]) {
    assert.ok(skill.files?.includes(entry), `skill files must include ${entry}`);
  }

  const registry = readJson<PackageJson>("packages/registry/package.json");
  assert.ok(registry.files?.includes("data"), "registry files must include data");

  const snapshotPath = "packages/registry/data/registry-snapshot.json";
  assert.ok(existsSync(join(ROOT, snapshotPath)), "bundled snapshot must exist");
  const snapshot = JSON.parse(readText(snapshotPath)) as {
    schemaVersion: number;
    generatedAt: string;
    candidates: { id: string }[];
    provenance: { id: string }[];
  };
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
  assert.ok(Array.isArray(snapshot.candidates));
  assert.ok(Array.isArray(snapshot.provenance));
  const ids = snapshot.provenance.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "provenance ids must be unique");
  for (const candidate of snapshot.candidates) {
    assert.ok(ids.includes(candidate.id), `snapshot ${candidate.id} needs provenance`);
  }

  for (const doc of [
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "docs/adapters.md",
    "docs/security-model.md",
    "docs/profile-schema.md",
    "docs/benchmark.md",
    ".github/GITHUB_RELEASE_NOTES.template",
    ".github/workflows/release.yml",
  ]) {
    assert.ok(existsSync(join(ROOT, doc)), `missing release doc: ${doc}`);
  }

  const license = readText("LICENSE");
  assert.match(license, /MIT License/);
  assert.match(license, /Permission is hereby granted/);

  const readme = readText("README.md");
  for (const harness of ["OpenCode", "Claude Code", "Codex", "Cursor"]) {
    assert.ok(readme.includes(harness), `README must name ${harness}`);
  }
  for (const phrase of [
    "recipe-only",
    "no-good-candidates",
    "seed/placeholder",
    "registry:refresh",
    "plan --candidate",
    "approve --candidate",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/benchmark.md",
  ]) {
    assert.ok(readme.includes(phrase), `README must document ${phrase}`);
  }

  const adapters = readText("docs/adapters.md");
  assert.match(adapters, /recipe-only/i);
  assert.match(adapters, /installVerified/);
  assert.match(adapters, /verified only/i);

  const security = readText("docs/security-model.md").toLowerCase();
  for (const phrase of [
    "local-first",
    "no telemetry by default",
    "no llm in the cli",
    "one-shot consent tokens",
    "unverified candidates become manual recipes",
    "read-only defaults",
    "environment names only",
    "rollback",
    "not a certification",
  ]) {
    assert.ok(security.includes(phrase), `security model must state: ${phrase}`);
  }
});

test("npm pack ships only runtime files for every published package", () => {
  const expected: Record<string, string[]> = {
    "packages/cli": ["dist/src/index.js", "package.json"],
    "packages/registry": ["data/registry-snapshot.json"],
    "packages/skill": ["SKILL.md", "scripts/plugin-detector"],
  };

  for (const dir of PUBLISHED_PACKAGES) {
    const files = packedFiles(dir);
    assertNoDevOrSecretFiles(dir, files);
    assert.ok(files.includes("package.json"), `${dir}: package.json is always packed`);
    assert.ok(files.includes("LICENSE"), `${dir}: LICENSE must ship in the tarball`);
    assert.ok(files.includes("README.md"), `${dir}: README.md must ship in the tarball`);
    assert.ok(
      files.every((file) => file === "package.json" || !file.startsWith("dist/test")),
      `${dir}: compiled tests must not ship`,
    );
    for (const file of expected[dir] ?? []) {
      assert.ok(files.includes(file), `${dir}: expected packed file ${file}`);
    }
  }
});

test("built CLI exposes plan and the hardened install usage", () => {
  const entry = join(ROOT, "packages/cli/dist/src/index.js");
  const env = {
    ...process.env,
    PLUGIN_DETECTOR_CACHE_DIR: join(tmpdir(), "pd-release-plan-no-cache"),
  };
  const help = spawnSync(process.execPath, [entry, "--help"], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  assert.match(help.stderr, /plan --candidate <id> --harness <name>/);
  assert.match(
    help.stderr,
    /install --plan-file <file> --candidate <id> --harness <name>/,
  );

  const plan = spawnSync(
    process.execPath,
    [entry, "plan", "--candidate", "missing", "--harness", "opencode", "--json"],
    { cwd: ROOT, encoding: "utf8", env },
  );
  assert.equal(plan.status, 1, `stderr: ${plan.stderr}`);
  assert.match(plan.stderr, /unknown candidate: missing/);
});

test("root pack dry-run excludes workspaces, fixtures, and agent docs", () => {
  const files = packedFiles(".");
  assertNoDevOrSecretFiles(".", files);
  for (const file of ["README.md", "LICENSE", "docs/security-model.md"]) {
    assert.ok(files.includes(file), `root pack missing ${file}`);
  }
  assert.ok(!files.some((file) => file.includes("superpowers")));
});

test("release workflow publishes only on v tags, with gates and provenance", () => {
  const workflow = readText(".github/workflows/release.yml");
  assert.match(workflow, /^on:\s*$/m);
  assert.match(workflow, /push:/);
  assert.match(workflow, /tags:/);
  assert.match(workflow, /- "v\*"/);
  assert.doesNotMatch(workflow, /pull_request/, "PRs must never publish");
  assert.doesNotMatch(workflow, /^\s+branches:/m, "branch pushes must never publish");
  assert.match(workflow, /needs: verify/);
  for (const step of [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run benchmark",
    "npm audit --omit=dev",
    "npm pack --dry-run",
    "npm publish",
    "--provenance",
    "sha256sum",
    "gh release create",
    "registry snapshot accepted",
  ]) {
    assert.ok(workflow.includes(step), `release workflow missing: ${step}`);
  }
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /secrets\.NPM_TOKEN/);
  assert.match(workflow, /registry-snapshot\.json/);
  assert.match(workflow, /generatedAt/);
  assert.match(workflow, /registry:refresh/);
});

test("changelog documents v0.1.0 and the unresolved v1.0 gates", () => {
  const changelog = readText("CHANGELOG.md");
  assert.match(changelog, /## \[0\.1\.0\]/);
  assert.match(changelog, /Unresolved v1\.0 gates/i);
  for (const gate of [
    "seed/placeholder",
    "registry:refresh",
    "recipe-only",
    "Compatibility wired into scoring",
    "Coverage gates",
    "Local observability",
    "Independent benchmark label review",
  ]) {
    assert.ok(changelog.includes(gate), `changelog must track gate: ${gate}`);
  }

  const template = readText(".github/GITHUB_RELEASE_NOTES.template");
  assert.match(template, /provenance/);
  assert.match(template, /Checksums|checksums/);
  assert.match(template, /\{\{TAG\}\}/);
});

test("npm and engine release settings are pinned", () => {
  const npmrc = readText(".npmrc");
  assert.match(npmrc, /^engine-strict=true$/m);
  assert.match(npmrc, /^provenance=true$/m);
  assert.match(npmrc, /^access=public$/m);
});

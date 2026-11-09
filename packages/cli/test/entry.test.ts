import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The built CLI entry and the benchmark fixtures, resolved from the compiled
// test file (packages/cli/dist/test/).
const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));
const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../../fixtures/benchmark", import.meta.url),
);

// Regression guard for the ESM auto-run check in index.ts. npm/npx invoke the
// bin through a symlink (node_modules/.bin/plugin-detector -> dist/src/index.js),
// so process.argv[1] is the symlink path while import.meta.url is the real
// path. Comparing raw argv[1] would skip main() entirely: the CLI would exit 0
// with no output (a false pass for the release-blocking gate). These tests spawn
// real child processes, are offline, and clean up their temp files.
test("CLI entry auto-runs main() when invoked through a symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-entry-symlink-"));
  const link = join(dir, "plugin-detector");
  try {
    symlinkSync(ENTRY, link, "file");
    const res = spawnSync(
      process.execPath,
      [link, "benchmark", "--fixtures", FIXTURE_ROOT, "--fail-on-low-value"],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /mean-precision@5/, "main() must actually run");
    assert.match(res.stdout, /offenders=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the CLI entry as a library does not auto-run main()", () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-entry-import-"));
  try {
    const script = join(dir, "importer.mjs");
    const entryUrl = pathToFileURL(ENTRY).href;
    writeFileSync(
      script,
      `import ${JSON.stringify(entryUrl)};\nconsole.log("IMPORT_OK");\n`,
    );
    const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), "IMPORT_OK");
    assert.doesNotMatch(
      `${res.stdout}${res.stderr}`,
      /usage: plugin-detector/,
      "an imported library must not print the CLI usage / run main()",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

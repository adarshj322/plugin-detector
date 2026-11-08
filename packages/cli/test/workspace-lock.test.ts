import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// From packages/cli/dist/test/ up four levels is the repo root (package.json
// and package-lock.json live there). Runs from the compiled dist tree.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

interface RootPackage {
  workspaces: string[];
}
interface LockFile {
  packages: Record<string, { link?: boolean }>;
}

// Regression guard for the CI-blocking drift where `npm ci` refuses a clean
// checkout because a workspace package is missing from package-lock.json
// (EUSAGE: Missing: @plugin-detector/skill@0.0.0 from lock file). Both the `ci`
// and `benchmark` jobs start with `npm ci`, so any missing workspace link would
// kill them before build/test. This test fails locally the moment drift recurs.
test("every workspace package is present in package-lock.json packages map", () => {
  const rootPkg = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as RootPackage;
  const lock = JSON.parse(
    readFileSync(join(ROOT, "package-lock.json"), "utf8"),
  ) as LockFile;
  const packages = lock.packages;

  let checked = 0;
  for (const pattern of rootPkg.workspaces) {
    // Workspaces are simple `dir/*` globs in this repo.
    const base = pattern.replace(/\/\*$/, "");
    for (const entry of readdirSync(join(ROOT, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${base}/${entry.name}`;
      const pkgPath = join(ROOT, dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const name = (
        JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string }
      ).name;
      const linkKey = `node_modules/${name}`;
      assert.ok(
        packages[linkKey],
        `package-lock.json missing workspace link ${linkKey}`,
      );
      assert.equal(
        packages[linkKey]?.link,
        true,
        `package-lock.json ${linkKey} is not a workspace link`,
      );
      assert.ok(
        packages[dir],
        `package-lock.json missing "${dir}" workspace entry`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 10, `expected >= 10 workspace packages, saw ${checked}`);
});

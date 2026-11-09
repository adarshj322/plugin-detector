#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inventory } from "./commands/inventory.js";
import { recommend } from "./commands/recommend.js";
import { explain } from "./commands/explain.js";
import { validateProfile } from "./commands/profiles-validate.js";
import { registryRefresh } from "./commands/registry-refresh.js";
import { plan } from "./commands/plan.js";
import { approve } from "./commands/approve.js";
import { install } from "./commands/install.js";
import { rollback } from "./commands/rollback.js";
import { benchmark } from "./commands/benchmark.js";

export const PACKAGE_NAME = "plugin-detector";

function usage(): number {
  console.error(
    [
      "usage: plugin-detector <command> [options]",
      "  inventory [--json] [--home DIR] [--root DIR]",
      "  recommend --use-case <id> [--signal S ...] [--json] [--cache-dir DIR] [--home DIR] [--root DIR] [--harness H] [--threshold N]",
      "  explain <candidate-id> [--show-untrusted] [--json] [--cache-dir DIR] [--home DIR] [--root DIR]",
      "  profiles validate <file>",
      "  registry refresh [--cache-dir <dir>] [--limit <n>]",
      "  plan --candidate <id> --harness <name> [--json] [--out <file>] [--cache-dir DIR] [--home DIR] [--root DIR]",
      "  approve --candidate <id> --plan <sha256> [--plan-file <file>] [--ttl-minutes N] [--json]",
      "  install --plan-file <file> --candidate <id> --harness <name> [--approval-token <token>] [--json] [--home DIR] [--root DIR] [--cache-dir DIR]",
      "  rollback --plan-file <file> [--json] [--home DIR] [--root DIR]",
      "  benchmark [--fixtures DIR] [--fail-on-low-value]",
      "install takes the token from --approval-token or PLUGIN_DETECTOR_APPROVAL_TOKEN,",
      "else prompts on a TTY; non-TTY without a token refuses.",
    ].join("\n"),
  );
  return 2;
}

// Exit codes: 0 ok, 1 error, 2 usage, 3 needs-clarification, 4 blocked.
// Only `registry refresh` (explicit cache refresh), `plan --out` (explicit
// plan file), `approve` (token store), consented `install` (verified writers),
// and `rollback` (restores recorded preimages) touch the filesystem.
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (command === "inventory") return (await inventory(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "recommend") return (await recommend(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "explain") return (await explain(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "plan") return (await plan(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "approve") return (await approve(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "install") return (await install(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "rollback") return (await rollback(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "benchmark") return (await benchmark(sub ? [sub, ...rest] : [])).exitCode;
  if (command === "profiles" && sub === "validate") return (await validateProfile(rest)).exitCode;
  if (command === "registry" && sub === "refresh") {
    return (await registryRefresh(rest)).exitCode;
  }
  if (command === "--help" || command === "-h") {
    console.log("plugin-detector: local-first harness plugin recommender");
    return usage();
  }
  return usage();
}

const invoked = process.argv[1] !== undefined;
if (invoked) {
  try {
    // Resolve symlinks: npm/npx invoke the bin through .bin/<name> -> the real
    // entry. pathToFileURL(argv[1]) is the symlink path, but import.meta.url is
    // the real path, so comparing raw argv[1] would silently skip main().
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] as string)).href) {
      main().then(
        (code) => {
          process.exitCode = code;
        },
        (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        },
      );
    }
  } catch {
    // Imported as a library (tests): never auto-run.
  }
}

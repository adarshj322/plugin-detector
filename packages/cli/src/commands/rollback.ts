import { readFileSync } from "node:fs";
import { InstallPlanSchema, type InstallPlan } from "@plugin-detector/core";
import { RollbackJsonSchema, printJson, printSection } from "../output.js";
import { createInstallAdapter, type InstallHarness } from "./inventory.js";

export interface RollbackResult {
  exitCode: number;
}

const HARNESSES: InstallHarness[] = ["opencode", "claude-code", "codex", "cursor"];

function isHarness(value: string): value is InstallHarness {
  return (HARNESSES as string[]).includes(value);
}

// `plugin-detector rollback`: restore the preimages recorded by an applied
// plan. Rollback is always available for plans that mutated managed files;
// it never installs anything and never touches paths the plan did not back up.
export async function rollback(argv: string[]): Promise<RollbackResult> {
  let planFile: string | undefined;
  let json = false;
  let home: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--plan-file" && i + 1 < argv.length) {
      planFile = argv[i + 1];
      i += 1;
    } else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: plugin-detector rollback --plan-file <file> [--json] [--home DIR] [--root DIR]",
      );
      return { exitCode: 0 };
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  if (planFile === undefined) {
    console.error("missing required --plan-file <path>");
    return { exitCode: 2 };
  }
  let plan: InstallPlan;
  try {
    plan = InstallPlanSchema.parse(
      JSON.parse(readFileSync(planFile, "utf8")) as unknown,
    );
  } catch (error) {
    console.error(
      `invalid plan file: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 2 };
  }
  if (!isHarness(plan.harness)) {
    console.error(`unsupported harness "${plan.harness}"`);
    return { exitCode: 2 };
  }
  const opts = { ...(home ? { home } : {}), ...(root ? { root } : {}) };
  const adapter = createInstallAdapter(plan.harness, opts);
  try {
    const receipt = await adapter.rollback(plan);
    if (json) {
      printJson(
        {
          command: "rollback",
          facts: {
            candidateId: plan.candidateId,
            harness: plan.harness,
            restored: receipt.restored,
          },
        },
        RollbackJsonSchema,
      );
    } else {
      printSection("facts", [
        `candidate: ${plan.candidateId}`,
        `harness: ${plan.harness}`,
        `status: rolled back`,
        ...receipt.restored.map((entry) => `restored: ${entry}`),
        ...(receipt.restored.length === 0
          ? ["restored: none (no backups found or nothing was mutated)"]
          : []),
      ]);
      printSection("estimates", []);
      printSection("untrustedCopy", []);
    }
    return { exitCode: 0 };
  } catch (error) {
    console.error(
      `rollback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }
}

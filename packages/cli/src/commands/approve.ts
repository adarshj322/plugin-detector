import { readFileSync } from "node:fs";
import {
  APPROVAL_TOKEN_MAX_TTL_MS,
  InstallPlanSchema,
  canonicalPlanHash,
  createApprovalToken,
  type InstallPlan,
} from "@plugin-detector/core";
import { ApproveJsonSchema, printJson, printSection } from "../output.js";

export interface ApproveResult {
  exitCode: number;
}

// One-shot scoped token: approve records (candidate, plan hash) and prints
// the token; install consumes it. TTL is capped at 30 minutes.
export async function approve(argv: string[]): Promise<ApproveResult> {
  let candidateId: string | undefined;
  let planHash: string | undefined;
  let planFile: string | undefined;
  let ttlMinutes = 10;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--candidate" && i + 1 < argv.length) {
      candidateId = argv[i + 1];
      i += 1;
    } else if (arg === "--plan" && i + 1 < argv.length) {
      planHash = argv[i + 1];
      i += 1;
    } else if (arg === "--plan-file" && i + 1 < argv.length) {
      planFile = argv[i + 1];
      i += 1;
    } else if (arg === "--ttl-minutes" && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error("--ttl-minutes must be a positive number");
        return { exitCode: 2 };
      }
      ttlMinutes = Math.min(parsed, APPROVAL_TOKEN_MAX_TTL_MS / 60000);
      i += 1;
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  if (candidateId === undefined) {
    console.error("missing required --candidate <id>");
    return { exitCode: 2 };
  }
  if (planFile !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(planFile, "utf8");
    } catch (error) {
      console.error(
        `cannot read plan file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { exitCode: 2 };
    }
    let parsed: { operations: InstallPlan["operations"] };
    try {
      parsed = InstallPlanSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      console.error(
        `invalid plan file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { exitCode: 2 };
    }
    const computed = canonicalPlanHash(parsed.operations);
    if (planHash !== undefined && planHash.toLowerCase() !== computed) {
      console.error("--plan does not match the hash of --plan-file");
      return { exitCode: 2 };
    }
    planHash = computed;
  }
  if (planHash === undefined || !/^[0-9a-f]{64}$/i.test(planHash)) {
    console.error("missing or invalid --plan <sha256>");
    return { exitCode: 2 };
  }
  let record;
  try {
    record = createApprovalToken({
      candidateId,
      planHash,
      ttlMs: ttlMinutes * 60 * 1000,
    });
  } catch (error) {
    console.error(
      `cannot mint approval token: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }
  if (json) {
    printJson(
      {
        command: "approve",
        facts: {
          candidateId: record.candidateId,
          planHash: record.planHash,
          token: record.token,
          expiresAt: record.expiresAt,
        },
      },
      ApproveJsonSchema,
    );
    return { exitCode: 0 };
  }
  printSection("facts", [
    `candidate: ${record.candidateId}`,
    `plan-hash: ${record.planHash}`,
    `expires-at: ${record.expiresAt}`,
    `approval-token: ${record.token}`,
  ]);
  printSection("estimates", []);
  printSection("untrustedCopy", []);
  return { exitCode: 0 };
}

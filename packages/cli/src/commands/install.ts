import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { OpenCodeAdapter } from "@plugin-detector/opencode";
import { ClaudeCodeAdapter } from "@plugin-detector/claude-code";
import { CodexAdapter } from "@plugin-detector/codex";
import { CursorAdapter } from "@plugin-detector/cursor";
import {
  ApprovalError,
  InstallError,
  InstallPlanSchema,
  applyInstallPlan,
  isRecipeOnly,
  recipeText,
  type ConsentDetail,
  type InstallPlan,
} from "@plugin-detector/core";
import { loadSnapshot } from "@plugin-detector/registry";
import { CliErrorSchema, InstallJsonSchema, printJson, printSection } from "../output.js";

export interface InstallResult {
  exitCode: number;
}

// Seams for the TTY transport (overridden in tests; production reads the
// real stdin TTY flag and prompts over readline).
export const ttyHooks = {
  isTTY: (): boolean => process.stdin.isTTY ?? false,
  confirm: (lines: string[]): Promise<boolean> => promptTTYConfirm(lines),
};

// Exit codes: 0 ok (applied or recipe), 1 apply failure, 2 usage/input,
// 4 blocked (approval missing/expired/mismatched/reused, declined, non-TTY
// without a token). The token itself is never printed here.
export async function install(argv: string[]): Promise<InstallResult> {
  let planFile: string | undefined;
  let approvalToken: string | undefined;
  let json = false;
  let home: string | undefined;
  let root: string | undefined;
  let cacheDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--plan-file" && i + 1 < argv.length) {
      planFile = argv[i + 1];
      i += 1;
    } else if (arg === "--approval-token" && i + 1 < argv.length) {
      approvalToken = argv[i + 1];
      i += 1;
    } else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else if (arg === "--cache-dir" && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
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
  if (isRecipeOnly(plan)) {
    const recipe = recipeText(plan);
    if (json) {
      printJson(
        {
          command: "install",
          facts: {
            status: "recipe",
            candidateId: plan.candidateId,
            writes: [],
            restored: [],
            recipe,
          },
        },
        InstallJsonSchema,
      );
    } else {
      printSection("facts", [
        `candidate: ${plan.candidateId}`,
        `status: recipe (manual install, zero writes)`,
        ...recipe.split("\n").map((line) => `recipe: ${line}`),
      ]);
      printSection("estimates", []);
      printSection("untrustedCopy", []);
    }
    return { exitCode: 0 };
  }
  const opts = { ...(home ? { home } : {}), ...(root ? { root } : {}) };
  const adapter =
    plan.harness === "opencode"
      ? new OpenCodeAdapter(opts)
      : plan.harness === "claude-code"
        ? new ClaudeCodeAdapter(opts)
        : plan.harness === "codex"
          ? new CodexAdapter(opts)
          : plan.harness === "cursor"
            ? new CursorAdapter(opts)
            : null;
  if (adapter === null) {
    console.error(`unsupported harness "${plan.harness}"`);
    return { exitCode: 2 };
  }
  const enriched = describeCandidate(plan.candidateId, cacheDir);
  const isTTY = ttyHooks.isTTY();
  try {
    const receipt = await applyInstallPlan(plan, approvalToken ?? null, adapter, {
      isTTY,
      confirm: async (shown) =>
        ttyHooks.confirm(buildConsentLines({ ...shown, ...enriched })),
    });
    if (json) {
      printJson(
        {
          command: "install",
          facts: {
            status: "applied",
            candidateId: plan.candidateId,
            writes: receipt.writes,
            restored: receipt.restored,
          },
        },
        InstallJsonSchema,
      );
    } else {
      printSection("facts", [
        `candidate: ${plan.candidateId}`,
        `status: applied`,
        ...receipt.writes.map((entry) => `write: ${entry}`),
      ]);
      printSection("estimates", []);
      printSection("untrustedCopy", []);
    }
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof ApprovalError) {
      reportBlocked(json, "install", `approval-${error.code}`, error.message);
      return { exitCode: 4 };
    }
    if (error instanceof InstallError) {
      if (error.code === "approval-required" || error.code === "declined") {
        reportBlocked(json, "install", error.code, error.message);
        return { exitCode: 4 };
      }
      console.error(`install failed: ${error.message}`);
      return { exitCode: 1 };
    }
    console.error(
      `install failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }
}

function reportBlocked(
  json: boolean,
  command: string,
  code: string,
  message: string,
): void {
  console.error(`${code}: ${message}`);
  if (json) {
    printJson({ command, error: { code, message } }, CliErrorSchema);
  }
}

// Best-effort enrichment for the TTY prompt: name, source, and trust from
// the cached snapshot. Falls back to plan ids when no snapshot is cached.
export function describeCandidate(
  candidateId: string,
  cacheDir?: string,
): Pick<ConsentDetail, "candidateName" | "source" | "trust"> {
  try {
    const snapshot = loadSnapshot({ ...(cacheDir ? { cacheDir } : {}) });
    const found = snapshot.candidates.find((entry) => entry.id === candidateId);
    if (!found) return {};
    const provenance = snapshot.provenance.find(
      (entry) => entry.id === candidateId,
    );
    return {
      candidateName: found.name,
      source: found.packageName ?? found.repositoryUrl ?? found.id,
      trust: provenance?.trust ?? "unverified",
    };
  } catch {
    return {};
  }
}

// Pure TTY prompt body: candidate, source, trust, operations, and rollback.
export function buildConsentLines(detail: ConsentDetail): string[] {
  return [
    `candidate: ${detail.candidateId}`,
    ...(detail.candidateName !== undefined
      ? [`name: ${detail.candidateName}`]
      : []),
    ...(detail.source !== undefined ? [`source: ${detail.source}`] : []),
    ...(detail.trust !== undefined ? [`trust: ${detail.trust}`] : []),
    `harness: ${detail.harness}`,
    `operations:`,
    ...detail.operations.map(
      (op) => `- [${op.kind}] ${op.target ?? "(no target)"}: ${op.summary}`,
    ),
    `backup-refs: ${detail.backupRefs.join(", ") || "(none)"}`,
    `rollback:`,
    ...detail.rollback.map((line) => `- ${line}`),
  ];
}

function promptTTYConfirm(lines: string[]): Promise<boolean> {
  for (const line of lines) console.log(line);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Approve this install? [y/N] ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

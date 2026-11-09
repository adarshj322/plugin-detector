import { writeFileSync } from "node:fs";
import {
  isRecipeOnly,
  planHash,
  recipeText,
} from "@plugin-detector/core";
import { PlanJsonSchema, printJson, printSection } from "../output.js";
import { consentMetadata } from "./consent-metadata.js";
import { buildAdapters, findSnapshotCandidate } from "./inventory.js";

export interface PlanResult {
  exitCode: number;
}

const INSTALL_HARNESSES = [
  "opencode",
  "claude-code",
  "codex",
  "cursor",
] as const;
type InstallHarness = (typeof INSTALL_HARNESSES)[number];

function isInstallHarness(value: string): value is InstallHarness {
  return (INSTALL_HARNESSES as readonly string[]).includes(value);
}

// `plugin-detector plan`: the only command that produces an install plan for
// a snapshot candidate. Trust comes from the snapshot provenance, so an
// unverified/curated candidate can never yield a write plan; it gets the
// adapter's manual recipe instead. This command writes nothing except the
// explicit `--out` plan file.
export async function plan(argv: string[]): Promise<PlanResult> {
  let candidateId: string | undefined;
  let harness: string | undefined;
  let json = false;
  let out: string | undefined;
  let cacheDir: string | undefined;
  let home: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--candidate" && i + 1 < argv.length) {
      candidateId = argv[i + 1];
      i += 1;
    } else if (arg === "--harness" && i + 1 < argv.length) {
      harness = argv[i + 1];
      i += 1;
    } else if (arg === "--out" && i + 1 < argv.length) {
      out = argv[i + 1];
      i += 1;
    } else if (arg === "--cache-dir" && i + 1 < argv.length) {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--home" && i + 1 < argv.length) {
      home = argv[i + 1];
      i += 1;
    } else if (arg === "--root" && i + 1 < argv.length) {
      root = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: plugin-detector plan --candidate <id> --harness <name> [--json] [--out <file>] [--cache-dir DIR] [--home DIR] [--root DIR]",
      );
      return { exitCode: 0 };
    } else {
      console.error(`unknown argument: ${arg}`);
      return { exitCode: 2 };
    }
  }
  if (candidateId === undefined) {
    console.error("missing required --candidate <id>");
    return { exitCode: 2 };
  }
  if (harness === undefined || !isInstallHarness(harness)) {
    console.error(
      `missing or invalid --harness <name>. Valid: ${INSTALL_HARNESSES.join(", ")}`,
    );
    return { exitCode: 2 };
  }

  let resolved;
  try {
    resolved = findSnapshotCandidate(candidateId, cacheDir);
  } catch (error) {
    console.error(
      `no registry snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { exitCode: 1 };
  }
  if (resolved === null) {
    console.error(`unknown candidate: ${candidateId}`);
    return { exitCode: 1 };
  }
  const adapter = buildAdapters(home, root).find((a) => a.harness === harness);
  if (adapter === undefined) {
    console.error(`unsupported harness "${harness}"`);
    return { exitCode: 2 };
  }

  // A source-declared artifact that was never probed cannot produce a write
  // plan even if a snapshot wrongly labels it verified.
  const probed = resolved.candidate.artifactProbed !== false;
  const installPlan = adapter.installPlan(
    resolved.candidate,
    probed ? resolved.trust : "unverified",
  );
  const hash = planHash(installPlan);
  const recipeOnly = isRecipeOnly(installPlan);
  const status: "write" | "recipe" =
    probed && resolved.trust === "verified" && !recipeOnly ? "write" : "recipe";
  const metadata = consentMetadata(
    resolved.candidate,
    resolved.provenance,
    resolved.trust,
  );
  if (status === "recipe" && !recipeOnly) {
    // Defense in depth: a snapshot-untrusted candidate must never surface a
    // write plan even if an adapter regresses.
    console.error(
      `refusing to emit a write plan for candidate "${candidateId}" with trust "${resolved.trust}"`,
    );
    return { exitCode: 4 };
  }
  const recipe = recipeOnly ? recipeText(installPlan) : undefined;

  const nextSteps =
    status === "write"
      ? [
          `approve --candidate ${candidateId} --plan ${hash}`,
          `install --plan-file <plan-file> --candidate ${candidateId} --harness ${harness} --approval-token <token>`,
          ...(out === undefined
            ? [`re-run plan with --out <plan-file> to save the plan for install`]
            : []),
        ]
      : [
          "No write plan is available for this candidate: follow the manual recipe; no approval token or install command is required.",
        ];

  if (status === "write" && out !== undefined) {
    try {
      writeFileSync(out, `${JSON.stringify(installPlan, null, 2)}\n`);
    } catch (error) {
      console.error(
        `cannot write plan file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { exitCode: 1 };
    }
  }

  if (json) {
    printJson(
      {
        command: "plan",
        facts: {
          candidateId,
          harness,
          trust: resolved.trust,
          status,
          source: metadata.source ?? "unknown",
          canonicalUrl: metadata.canonicalUrl ?? "unknown",
          artifactType: metadata.artifactType ?? "unknown",
          pinnedRef: metadata.pinnedRef ?? "unknown",
          license: metadata.license ?? "unknown",
          trustEvidence: metadata.trustEvidence ?? "unknown",
          permissions: metadata.permissions ?? "unknown",
          envVars: metadata.envVars ?? "unknown",
          sideEffects: metadata.sideEffects ?? "unknown",
          plan: installPlan,
          planHash: hash,
          ...(recipe !== undefined ? { recipe } : {}),
          nextSteps,
        },
      },
      PlanJsonSchema,
    );
    return { exitCode: 0 };
  }

  printSection("facts", [
    `candidate: ${candidateId} (${resolved.candidate.name})`,
    `harness: ${harness}`,
    `source: ${metadata.source ?? "unknown"}`,
    `canonical-url: ${metadata.canonicalUrl ?? "unknown"}`,
    `artifact-type: ${metadata.artifactType ?? "unknown"}`,
    `pinned-ref: ${metadata.pinnedRef ?? "unknown"}`,
    `license: ${metadata.license ?? "unknown"}`,
    `trust: ${resolved.trust}`,
    `trust-evidence: ${metadata.trustEvidence ?? "unknown"}`,
    `permissions: ${metadata.permissions ?? "unknown"}`,
    `env-vars: ${metadata.envVars ?? "unknown"}`,
    `side-effects: ${metadata.sideEffects ?? "unknown"}`,
    `status: ${status}`,
    `plan-hash: ${hash}`,
    ...installPlan.operations.map(
      (op) => `operation: [${op.kind}] ${op.target ?? "(no target)"}: ${op.summary}`,
    ),
    ...installPlan.backupRefs.map((ref) => `backup-ref: ${ref}`),
    ...installPlan.rollbackOperations.map((op) => `rollback: ${op.summary}`),
    ...(recipe === undefined ? [] : recipe.split("\n").map((line) => `recipe: ${line}`)),
    ...(out === undefined
      ? []
      : status === "write"
        ? [`plan-file: ${out}`]
        : ["plan-file: not written (manual recipe)"]),
    ...nextSteps.map((step) => `next: ${step}`),
  ]);
  printSection("estimates", []);
  printSection("untrustedCopy", []);
  return { exitCode: 0 };
}

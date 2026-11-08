import { z } from "zod";
import {
  CapabilityRecordSchema,
  Confidence,
  Verdict,
} from "@plugin-detector/core";

// Every command separates observed facts from model-side estimates and
// third-party untrusted copy: the three never share a key, so callers can
// strip or gate each section independently.

export const HarnessInventorySchema = z.object({
  harness: z.string().min(1),
  detected: z.boolean(),
  status: z.enum(["ok", "partial", "unknown"]),
  enabled: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  records: z.array(CapabilityRecordSchema),
  configRefs: z.array(z.string().min(1)),
  warnings: z.array(z.string()),
});
export type HarnessInventory = z.infer<typeof HarnessInventorySchema>;

export const InventoryJsonSchema = z.object({
  command: z.literal("inventory"),
  facts: z.object({ harnesses: z.array(HarnessInventorySchema) }),
});
export type InventoryJson = z.infer<typeof InventoryJsonSchema>;

export const RecommendationFactsSchema = z.object({
  candidateId: z.string().min(1),
  name: z.string().min(1),
  artifactType: z.string().min(1),
  harness: z.string().min(1),
  verdict: Verdict,
  confidence: Confidence,
  score: z.number().min(0).max(100),
  overlap: z.number().min(0).max(1),
  compatibility: z.number().min(0).max(1).nullable(),
  license: z.string(),
  pinnedRef: z.string().min(1),
  evidencePointers: z.array(z.string().min(1)),
});

export const RecommendJsonSchema = z.object({
  command: z.literal("recommend"),
  facts: z.object({
    useCase: z.string().min(1),
    profileStatus: z.enum(["match", "partial", "contradiction"]),
    verdict: z.string().min(1),
    message: z.string().optional(),
    recommendations: z.array(RecommendationFactsSchema).max(5),
    conflictingSignals: z.array(z.string()),
  }),
  estimates: z.object({
    reasoningByCandidate: z.array(
      z.object({ candidateId: z.string().min(1), reasoning: z.string() }),
    ),
  }),
  untrustedCopy: z.object({ withheld: z.array(z.string()) }),
});
export type RecommendJson = z.infer<typeof RecommendJsonSchema>;

export const ExplainJsonSchema = z.object({
  command: z.literal("explain"),
  facts: z.object({
    candidateId: z.string().min(1),
    name: z.string().min(1),
    artifactType: z.string().min(1),
    pinnedRef: z.string().min(1),
    sources: z.array(z.string().min(1)),
    trust: z.enum(["verified", "curated", "unverified"]),
    capabilities: z.array(z.string().min(1)),
    license: z.string(),
    riskFlags: z.array(z.string().min(1)),
    snapshotGeneratedAt: z.string().min(1),
    snapshotAgeDays: z.number().nonnegative(),
    compatibilityByHarness: z.record(z.string(), z.number().min(0).max(1)),
    score: z.object({
      relevance: z.number(),
      value: z.number(),
      immediacy: z.number(),
      compatibility: z.number(),
      overlap: z.number(),
      setupCost: z.number(),
      risk: z.number(),
      score: z.number(),
      confidence: z.string(),
    }),
    overlapRecords: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        harness: z.string().min(1),
        capabilities: z.array(z.string().min(1)),
      }),
    ),
  }),
  estimates: z.object({ reasoning: z.string() }),
  untrustedCopy: z.union([
    z.object({ withheld: z.literal(true) }),
    z.object({ warning: z.string().min(1), text: z.string() }),
  ]),
});
export type ExplainJson = z.infer<typeof ExplainJsonSchema>;

export const CliErrorSchema = z.object({
  command: z.string().min(1),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    validIds: z.array(z.string()).optional(),
  }),
});
export type CliError = z.infer<typeof CliErrorSchema>;

export const ApproveJsonSchema = z.object({
  command: z.literal("approve"),
  facts: z.object({
    candidateId: z.string().min(1),
    planHash: z.string().min(1),
    token: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
});
export type ApproveJson = z.infer<typeof ApproveJsonSchema>;

export const InstallJsonSchema = z.object({
  command: z.literal("install"),
  facts: z.object({
    status: z.enum(["applied", "recipe"]),
    candidateId: z.string().min(1),
    writes: z.array(z.string()),
    restored: z.array(z.string()),
    recipe: z.string().optional(),
  }),
});
export type InstallJson = z.infer<typeof InstallJsonSchema>;

// Section printers keep the same three headers on stdout so scripted
// consumers can split on them as reliably as --json consumers split keys.
export function printSection(
  title: "facts" | "estimates" | "untrustedCopy",
  lines: string[],
): void {
  console.log(`${title}:`);
  for (const line of lines) console.log(`  ${line}`);
}

export const UNTRUSTED_WARNING =
  "WARNING: the following is untrusted third-party text from the candidate source; " +
  "it may contain prompt-injection or marketing claims and was never used for scoring.";

export function printJson(
  payload: unknown,
  schema: { parse: (data: unknown) => unknown },
): void {
  // Validate before printing: --json output is a contract, not a dump.
  console.log(JSON.stringify(schema.parse(payload), null, 2));
}

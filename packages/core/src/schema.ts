import { z } from "zod";
import { ArtifactType, HarnessId } from "./artifacts.js";

// Closed verdict set: required / useful-optional / redundant / risky /
// no-good-candidates (spec: Verdicts; Task 3 matches on these strings).
export const Verdict = z.enum([
  "required",
  "useful-optional",
  "redundant",
  "risky",
  "no-good-candidates",
]);
export type Verdict = z.infer<typeof Verdict>;

export const Confidence = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof Confidence>;

// Bare branch names are mutable pointers, never immutable pins (spec: a
// candidate is verified only with a tagged release, version, digest, or
// marketplace artifact ID).
const MUTABLE_REFS = new Set([
  "main",
  "master",
  "mainline",
  "trunk",
  "latest",
  "stable",
  "head",
]);

const pinnedRef = z
  .string()
  .min(1)
  .refine((v) => !MUTABLE_REFS.has(v.toLowerCase()), {
    message:
      "pinnedRef must be an immutable ref (tag, version, or digest), not a branch",
  });

const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "lastVerified must be an ISO date",
  });

export const PopularitySchema = z.object({
  stars: z.number().nonnegative().optional(),
  installs: z.number().nonnegative().optional(),
  velocity30d: z.number().nonnegative().optional(),
});
export type Popularity = z.infer<typeof PopularitySchema>;

export const CandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artifactType: ArtifactType,
  sources: z.array(z.string().min(1)),
  useCaseDomains: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1)),
  license: z.string().min(1),
  pinnedRef,
  repositoryUrl: z.string().url().optional(),
  packageName: z.string().min(1).optional(),
  installMode: z.enum(["verified", "manual"]),
  lastVerified: isoDate,
  // False when the record only declares an artifact ref from a listing and no
  // manifest/package metadata was fetched. Unprobed candidates are excluded
  // from recommendations and can never produce a write plan.
  artifactProbed: z.boolean().optional(),
  provenance: z.enum(["official", "publisher", "community", "unknown"]),
  risk: z.enum(["low", "medium", "high", "critical"]),
  maintenance: z.enum(["active", "stale", "archived", "unknown"]),
  auditStatus: z.enum(["clean", "warning", "critical", "unknown"]),
  popularity: PopularitySchema,
  rawUntrustedCopy: z.string().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CapabilityRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  harness: HarnessId,
  kind: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  enabled: z.boolean(),
  configRefs: z.array(z.string().min(1)),
  usageCount90d: z.number().int().nonnegative().optional(),
  contextCostClass: z.enum(["per-use", "per-session", "per-query", "zero"]),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

export const RecommendationSchema = z.object({
  candidate: CandidateSchema,
  harness: HarnessId,
  verdict: Verdict,
  confidence: Confidence,
  score: z.number().min(0).max(100),
  overlap: z.number().min(0).max(1),
  reasoning: z.string(),
  evidencePointers: z.array(z.string().min(1)),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const OperationSchema = z.object({
  kind: z.enum(["write", "append", "run", "recipe"]),
  target: z.string().min(1).optional(),
  summary: z.string().min(1),
});
export type Operation = z.infer<typeof OperationSchema>;

export const InstallPlanSchema = z.object({
  candidateId: z.string().min(1),
  harness: HarnessId,
  operations: z.array(OperationSchema),
  backupRefs: z.array(z.string().min(1)),
  rollbackOperations: z.array(OperationSchema),
  approvalTokenRequired: z.literal(true),
});
export type InstallPlan = z.infer<typeof InstallPlanSchema>;

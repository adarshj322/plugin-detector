import { z } from "zod";
import { ArtifactType } from "@plugin-detector/core";
import type { CacheManifest } from "./cache.js";
import { TrustClassSchema, type RegistrySnapshot } from "./snapshot.js";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO date",
});

// Review evidence is evidence-only: every accepted candidate must carry the
// probed artifact record, its provenance entry, and the source URL the record
// was retrieved from. Anything else is an invalid snapshot, not a silent skip.
export const ReviewCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artifactType: ArtifactType,
  sourceUrl: z.string().url(),
  provenance: z.enum(["official", "publisher", "community", "unknown"]),
  trust: TrustClassSchema,
  license: z.string().min(1),
  pinnedRef: z.string().min(1),
  risk: z.enum(["low", "medium", "high", "critical"]),
  maintenance: z.enum(["active", "stale", "archived", "unknown"]),
  auditStatus: z.enum(["clean", "warning", "critical", "unknown"]),
  lastVerified: isoDate,
  retrievedAt: isoDate,
  // A preserved record survived a transient source failure (or a partial
  // source refresh) at its old evidence age. It is not a fresh probe.
  preserved: z.boolean(),
  evidenceSource: z.string().url(),
  evidenceRef: z.string().min(1),
  contentHash: z.string().min(1),
  evidenceSnippets: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1)),
});
export type ReviewCandidate = z.infer<typeof ReviewCandidateSchema>;

export const ReviewRefusalSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
  sourceUrl: z.string().url(),
  at: isoDate,
  // An empty pin is itself review evidence (a mutable or missing pin), so it
  // is preserved rather than rejected by the schema.
  pinnedRef: z.string().optional(),
});
export type ReviewRefusal = z.infer<typeof ReviewRefusalSchema>;

export const ReviewRejectedGroupSchema = z.object({
  reason: z.string().min(1),
  sourceUrl: z.string().url(),
  count: z.number().int().positive(),
  ids: z.array(z.string().min(1)),
});
export type ReviewRejectedGroup = z.infer<typeof ReviewRejectedGroupSchema>;

export const ReviewSourceCountSchema = z.object({
  sourceUrl: z.string().url(),
  probed: z.number().int().nonnegative(),
  unprobed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
export type ReviewSourceCount = z.infer<typeof ReviewSourceCountSchema>;

// Manifest source health is copied through unchanged (minus transport
// validators) so a reviewer sees which sources failed or only partially
// answered the refresh that produced the snapshot.
export const ReviewSourceHealthSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  count: z.number().int().nonnegative().optional(),
  partial: z.boolean().optional(),
  error: z.string().min(1).optional(),
  failures: z
    .array(z.object({ query: z.string(), error: z.string() }))
    .optional(),
});
export type ReviewSourceHealth = z.infer<typeof ReviewSourceHealthSchema>;

export const ReviewReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  snapshotGeneratedAt: isoDate,
  manifestGeneratedAt: isoDate.nullable(),
  counts: z.object({
    // total counts records, not unique ids: a rejected record whose prior
    // candidate was preserved appears in both `probed` and `rejected`.
    total: z.number().int().nonnegative(),
    probed: z.number().int().nonnegative(),
    preserved: z.number().int().nonnegative(),
    unprobed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    rejectedAlsoPreserved: z.number().int().nonnegative(),
  }),
  sources: z.array(ReviewSourceCountSchema),
  sourceHealth: z.array(ReviewSourceHealthSchema),
  candidates: z.array(ReviewCandidateSchema),
  unprobed: z.array(ReviewRefusalSchema),
  rejected: z.array(ReviewRefusalSchema),
  rejectedGroups: z.array(ReviewRejectedGroupSchema),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Pure report assembly: the CLI owns file reads so this stays deterministic
// and testable. Rejections are grouped by (reason, source) so repeated intake
// failures collapse into one review line instead of burying the signal.
export function buildReviewReport(
  snapshot: RegistrySnapshot,
  manifest: CacheManifest | null,
  now: Date = new Date(),
): ReviewReport {
  if (snapshot.candidates.length === 0) {
    throw new Error(
      "registry snapshot has no candidates to review; run `plugin-detector registry refresh` first",
    );
  }
  const provenanceById = new Map(
    snapshot.provenance.map((provenance) => [provenance.id, provenance]),
  );
  const candidates: ReviewCandidate[] = snapshot.candidates.map((candidate) => {
    const evidence = candidate.artifactEvidence;
    if (evidence === undefined) {
      throw new Error(
        `snapshot candidate "${candidate.id}" has no artifact evidence`,
      );
    }
    const provenance = provenanceById.get(candidate.id);
    if (provenance === undefined) {
      throw new Error(
        `snapshot candidate "${candidate.id}" has no provenance record`,
      );
    }
    return {
      id: candidate.id,
      name: candidate.name,
      artifactType: candidate.artifactType,
      sourceUrl: provenance.sourceUrl,
      provenance: candidate.provenance,
      trust: provenance.trust,
      // The probed license is the fetched truth; a listing claim never wins.
      license: evidence.license,
      pinnedRef: candidate.pinnedRef,
      risk: candidate.risk,
      maintenance: candidate.maintenance,
      auditStatus: candidate.auditStatus,
      lastVerified: candidate.lastVerified,
      retrievedAt: evidence.retrievedAt,
      // Without a manifest there is no refresh boundary to compare against;
      // a committed/bundled snapshot is reported as not preserved.
      preserved:
        manifest !== null &&
        Date.parse(evidence.retrievedAt) < Date.parse(manifest.generatedAt),
      evidenceSource: evidence.sourceUrl,
      evidenceRef: evidence.resolvedRef,
      contentHash: evidence.contentHash,
      evidenceSnippets: [...evidence.evidenceSnippets],
      capabilities: [...candidate.capabilities],
    };
  });

  const unprobed: ReviewRefusal[] = (manifest?.unprobed ?? []).map(
    (record) => ({
      id: record.id,
      reason: record.reason,
      sourceUrl: record.sourceUrl,
      at: record.observedAt,
      ...(record.pinnedRef === undefined ? {} : { pinnedRef: record.pinnedRef }),
    }),
  );
  const rejected: ReviewRefusal[] = (manifest?.rejected ?? []).map(
    (record) => ({
      id: record.id,
      reason: record.reason,
      sourceUrl: record.sourceUrl,
      at: record.rejectedAt,
      ...(record.pinnedRef === undefined ? {} : { pinnedRef: record.pinnedRef }),
    }),
  );

  const groupBuilders = new Map<
    string,
    { reason: string; sourceUrl: string; count: number; ids: Set<string> }
  >();
  for (const record of rejected) {
    const key = `${record.sourceUrl}\u0000${record.reason}`;
    const group = groupBuilders.get(key);
    if (group === undefined) {
      groupBuilders.set(key, {
        reason: record.reason,
        sourceUrl: record.sourceUrl,
        count: 1,
        ids: new Set([record.id]),
      });
    } else {
      group.count += 1;
      group.ids.add(record.id);
    }
  }
  const rejectedGroups: ReviewRejectedGroup[] = [...groupBuilders.values()]
    .map((group) => ({
      reason: group.reason,
      sourceUrl: group.sourceUrl,
      count: group.count,
      ids: [...group.ids].sort(compare),
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        compare(a.reason, b.reason) ||
        compare(a.sourceUrl, b.sourceUrl),
    );

  const sourceCounts = new Map<
    string,
    { probed: number; unprobed: number; rejected: number }
  >();
  const bump = (
    sourceUrl: string,
    bucket: "probed" | "unprobed" | "rejected",
  ): void => {
    const counts = sourceCounts.get(sourceUrl) ?? {
      probed: 0,
      unprobed: 0,
      rejected: 0,
    };
    counts[bucket] += 1;
    sourceCounts.set(sourceUrl, counts);
  };
  for (const record of candidates) bump(record.sourceUrl, "probed");
  for (const record of unprobed) bump(record.sourceUrl, "unprobed");
  for (const record of rejected) bump(record.sourceUrl, "rejected");
  const sources: ReviewSourceCount[] = [...sourceCounts.entries()]
    .map(([sourceUrl, counts]) => ({ sourceUrl, ...counts }))
    .sort((a, b) => compare(a.sourceUrl, b.sourceUrl));

  const sourceHealth: ReviewSourceHealth[] = Object.entries(
    manifest?.sources ?? {},
  )
    .map(([id, health]) => ({
      id,
      ok: health.ok,
      ...(health.count === undefined ? {} : { count: health.count }),
      ...(health.partial === undefined ? {} : { partial: health.partial }),
      ...(health.error === undefined ? {} : { error: health.error }),
      ...(health.failures === undefined
        ? {}
        : { failures: health.failures.map((failure) => ({ ...failure })) }),
    }))
    .sort((a, b) => compare(a.id, b.id));

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  return ReviewReportSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    snapshotGeneratedAt: snapshot.generatedAt,
    manifestGeneratedAt: manifest?.generatedAt ?? null,
    counts: {
      total: candidates.length + unprobed.length + rejected.length,
      probed: candidates.length,
      preserved: candidates.filter((candidate) => candidate.preserved).length,
      unprobed: unprobed.length,
      rejected: rejected.length,
      rejectedAlsoPreserved: rejected.filter((record) =>
        candidateIds.has(record.id),
      ).length,
    },
    sources,
    sourceHealth,
    candidates,
    unprobed,
    rejected,
    rejectedGroups,
  });
}

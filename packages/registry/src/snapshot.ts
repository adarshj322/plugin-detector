import { z } from "zod";
import { CandidateSchema, type Candidate } from "@plugin-detector/core";
import type { TrustClass } from "./trust.js";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO date",
});

export const TrustClassSchema = z.enum(["verified", "curated", "unverified"]);

export const SnapshotProvenanceSchema = z.object({
  id: z.string().min(1),
  sourceUrl: z.string().url(),
  retrievedAt: isoDate,
  trust: TrustClassSchema,
});
export type SnapshotProvenance = z.infer<typeof SnapshotProvenanceSchema>;

export const RegistrySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  candidates: z.array(CandidateSchema),
  provenance: z.array(SnapshotProvenanceSchema),
});
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;

export interface SnapshotEntry {
  candidate: Candidate;
  sourceUrl: string;
  retrievedAt?: string | undefined;
  trust?: TrustClass | undefined;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TRUST_RANK: Record<TrustClass, number> = {
  verified: 3,
  curated: 2,
  unverified: 1,
};

function mergeSources(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

// One entry per candidate id, deterministic: the highest-trust source wins
// the record and its provenance, while every source URL is merged into
// `candidate.sources`. Ties break on source URL, then id.
function dedupeEntries(entries: SnapshotEntry[], at: string): SnapshotEntry[] {
  const byId = new Map<string, SnapshotEntry>();
  for (const entry of entries) {
    const id = entry.candidate.id;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, {
        candidate: {
          ...entry.candidate,
          sources: [...new Set(entry.candidate.sources)].sort(),
        },
        sourceUrl: entry.sourceUrl,
        retrievedAt: entry.retrievedAt ?? at,
        trust: entry.trust ?? "unverified",
      });
      continue;
    }
    const existingRank = TRUST_RANK[existing.trust ?? "unverified"];
    const nextRank = TRUST_RANK[entry.trust ?? "unverified"];
    const preferNext =
      nextRank > existingRank ||
      (nextRank === existingRank && entry.sourceUrl < existing.sourceUrl);
    const winner = preferNext ? entry : existing;
    byId.set(id, {
      candidate: {
        ...winner.candidate,
        sources: mergeSources(existing.candidate.sources, entry.candidate.sources).sort(),
      },
      sourceUrl: winner.sourceUrl,
      retrievedAt: winner.retrievedAt ?? at,
      trust: winner.trust ?? "unverified",
    });
  }
  return [...byId.values()].sort((x, y) => compareId(x.candidate.id, y.candidate.id));
}

// Deterministic build: stable id sort, caller-supplied timestamp (tests pin
// it), one deduplicated record per id with merged provenance and trust.
export function buildSnapshot(
  entries: SnapshotEntry[],
  generatedAt: Date = new Date(),
): RegistrySnapshot {
  const at = generatedAt.toISOString();
  const sorted = dedupeEntries(entries, at);
  return RegistrySnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: at,
    candidates: sorted.map((e) => e.candidate),
    provenance: sorted.map((e) => ({
      id: e.candidate.id,
      sourceUrl: e.sourceUrl,
      retrievedAt: e.retrievedAt ?? at,
      trust: e.trust ?? "unverified",
    })),
  });
}

export function parseSnapshot(json: string): RegistrySnapshot {
  return RegistrySnapshotSchema.parse(JSON.parse(json));
}

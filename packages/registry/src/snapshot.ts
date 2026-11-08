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

// Deterministic build: stable id sort, caller-supplied timestamp (tests pin
// it), per-candidate source URL + retrieval time + trust class.
export function buildSnapshot(
  entries: SnapshotEntry[],
  generatedAt: Date = new Date(),
): RegistrySnapshot {
  const at = generatedAt.toISOString();
  const sorted = [...entries].sort((x, y) => compareId(x.candidate.id, y.candidate.id));
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

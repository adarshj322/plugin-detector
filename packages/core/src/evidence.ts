import { z } from "zod";
import { ArtifactType } from "./artifacts.js";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be an ISO date",
});

// Fetched-artifact evidence (v1.0): produced only after the listed artifact
// itself was fetched and validated. Listing fields never populate it, and its
// presence is what makes a candidate probed. `kind` uses the shared
// ArtifactType values exactly.
export const ArtifactEvidenceSchema = z.object({
  kind: ArtifactType,
  sourceUrl: z.string().url(),
  resolvedRef: z.string().min(1),
  contentHash: z.string().min(1),
  license: z.string().min(1),
  name: z.string().min(1).optional(),
  // Package identity declared by the probed artifact itself (package.json /
  // npm or PyPI metadata). Listing-supplied package names never set this.
  packageName: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
  evidenceSnippets: z.array(z.string().min(1)).default([]),
  retrievedAt: isoDate,
});
export type ArtifactEvidence = z.infer<typeof ArtifactEvidenceSchema>;

export const PackageRegistrySchema = z.enum(["npm", "pypi"]);
export type PackageRegistry = z.infer<typeof PackageRegistrySchema>;

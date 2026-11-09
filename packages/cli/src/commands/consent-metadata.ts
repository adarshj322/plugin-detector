import type { Candidate, ConsentDetail } from "@plugin-detector/core";
import type { SnapshotProvenance } from "@plugin-detector/registry";

type Metadata = Pick<
  ConsentDetail,
  | "candidateName"
  | "source"
  | "canonicalUrl"
  | "artifactType"
  | "pinnedRef"
  | "license"
  | "trust"
  | "trustEvidence"
  | "permissions"
  | "envVars"
  | "sideEffects"
>;

// The consent surface must state every safety-relevant fact the snapshot
// carries. Fields the registry does not collect are printed as explicit
// "unknown" instead of being silently omitted.
export function consentMetadata(
  candidate: Candidate,
  provenance?: SnapshotProvenance,
  trust?: ConsentDetail["trust"],
): Metadata {
  const source = candidate.packageName ?? candidate.repositoryUrl ?? candidate.id;
  const canonicalUrl =
    candidate.repositoryUrl ??
    candidate.sources.find((entry) => entry.startsWith("http")) ??
    "unknown";
  const trustEvidence =
    provenance === undefined
      ? "unknown (no provenance record)"
      : `${provenance.sourceUrl} retrieved ${provenance.retrievedAt}; trust ${provenance.trust}`;
  return {
    candidateName: candidate.name,
    source,
    canonicalUrl,
    artifactType: candidate.artifactType,
    pinnedRef: candidate.pinnedRef,
    license: candidate.license,
    ...(trust === undefined ? {} : { trust }),
    trustEvidence,
    permissions: "unknown (not declared by source metadata)",
    envVars: "unknown (not declared by source metadata)",
    sideEffects: "writes only the files listed in operations; no other effects declared",
  };
}

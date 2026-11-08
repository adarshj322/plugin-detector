import type { Candidate } from "@plugin-detector/core";

export interface TrustEvidence {
  maintainerVerified: boolean;
  activity: "active" | "stale" | "archived" | "unknown";
  reviewEvidence?: boolean;
  checksumPresent?: boolean;
}

export type TrustClass = "verified" | "curated" | "unverified";

// Minimal open-license set for v1 (spec: verified requires an open license).
// shortcut: exotic OSI-approved ids (e.g. EPL, EUPL) stay unverified until the
// set is sourced from a license taxonomy; upgrade when a false rejection lands.
const OPEN_LICENSES = new Set([
  "mit",
  "apache-2.0",
  "apache 2.0",
  "isc",
  "bsd-2-clause",
  "bsd-3-clause",
  "mpl-2.0",
  "cc0-1.0",
  "unlicense",
]);

function isOpenLicense(license: string): boolean {
  return OPEN_LICENSES.has(license.trim().toLowerCase());
}

// v1 trust policy (spec §Verified/curated policy): verified needs an
// official/standards-backed source or verified publisher, an immutable pinned
// ref (enforced at normalize time by CandidateSchema), active maintenance,
// an open license, checksum/attestation where supported, and no critical
// audit finding. Curated adds in-repo review evidence. Popularity is never
// consulted and cannot promote trust. An omitted checksumPresent means the
// artifact class carries no checksum signal (shortcut: no per-artifact
// support matrix yet; explicit false always blocks verified).
export function classifyTrust(
  candidate: Candidate,
  evidence: TrustEvidence,
): TrustClass {
  const sourceOk =
    candidate.provenance === "official" ||
    (candidate.provenance === "publisher" && evidence.maintainerVerified);
  const verified =
    sourceOk &&
    evidence.activity === "active" &&
    candidate.maintenance === "active" &&
    isOpenLicense(candidate.license) &&
    candidate.auditStatus !== "critical" &&
    evidence.checksumPresent !== false;
  if (!verified) return "unverified";
  return evidence.reviewEvidence === true ? "curated" : "verified";
}

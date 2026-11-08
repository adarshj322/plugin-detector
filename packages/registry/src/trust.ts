import type { Candidate } from "@plugin-detector/core";

export interface TrustEvidence {
  maintainerVerified: boolean;
  activity: "active" | "stale" | "archived" | "unknown";
  reviewEvidence?: boolean;
  checksumPresent?: boolean;
  // Silent manifest drift under an unchanged tag (detectDrift): the pinned
  // review no longer describes the artifact, so trust cannot be inherited.
  drifted?: boolean;
  // Shell/exec language in display copy (untrustedCopyRisk): suppresses
  // trusted handling even when every other signal is clean.
  untrustedCopyRisk?: boolean;
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
  // Drifted or shell/exec-tainted candidates never inherit trust: a prior
  // verified review describes a different artifact, or the copy itself asks
  // for code execution.
  if (evidence.drifted === true || evidence.untrustedCopyRisk === true)
    return "unverified";
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

export interface DriftResult {
  drifted: boolean;
  reasons: string[];
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

// Silent-drift comparison against the pinned snapshot entry. Same id and
// tag but a changed manifest (capabilities, license, source URL, package
// name, maintenance, audit, or artifact type) drifts and must re-review.
// Tolerance: a changed tag is a version update, not drift — it re-verifies
// through the normal path; a different id is not comparable.
export function detectDrift(
  previous: Candidate,
  current: Candidate,
): DriftResult {
  if (previous.id !== current.id) {
    return { drifted: false, reasons: ["different candidate id: not comparable"] };
  }
  if (previous.pinnedRef !== current.pinnedRef) {
    return {
      drifted: false,
      reasons: [
        `pinnedRef changed ${previous.pinnedRef} -> ${current.pinnedRef}: version update, re-verify via the normal path`,
      ],
    };
  }
  const reasons: string[] = [];
  if (!sameStringSet(previous.capabilities, current.capabilities)) {
    reasons.push(
      `capabilities changed [${previous.capabilities.join(", ")}] -> [${current.capabilities.join(", ")}] under unchanged tag ${current.pinnedRef}`,
    );
  }
  if (previous.license !== current.license) {
    reasons.push(
      `license changed ${previous.license} -> ${current.license} under unchanged tag ${current.pinnedRef}`,
    );
  }
  if ((previous.repositoryUrl ?? null) !== (current.repositoryUrl ?? null)) {
    reasons.push(
      `repositoryUrl changed ${previous.repositoryUrl ?? "(none)"} -> ${current.repositoryUrl ?? "(none)"} under unchanged tag ${current.pinnedRef}`,
    );
  }
  if ((previous.packageName ?? null) !== (current.packageName ?? null)) {
    reasons.push(
      `packageName changed ${previous.packageName ?? "(none)"} -> ${current.packageName ?? "(none)"} under unchanged tag ${current.pinnedRef}`,
    );
  }
  if (previous.maintenance !== current.maintenance) {
    reasons.push(
      `maintenance changed ${previous.maintenance} -> ${current.maintenance} under unchanged tag ${current.pinnedRef}`,
    );
  }
  if (previous.auditStatus !== current.auditStatus) {
    reasons.push(
      `auditStatus changed ${previous.auditStatus} -> ${current.auditStatus} under unchanged tag ${current.pinnedRef}`,
    );
  }
  if (previous.artifactType !== current.artifactType) {
    reasons.push(
      `artifactType changed ${previous.artifactType} -> ${current.artifactType} under unchanged tag ${current.pinnedRef}`,
    );
  }
  return {
    drifted: reasons.length > 0,
    reasons:
      reasons.length > 0 ? reasons : ["no manifest change under the same tag"],
  };
}

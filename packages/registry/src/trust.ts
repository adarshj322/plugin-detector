import type { Candidate } from "@plugin-detector/core";

// Exact publisher identities approved for v1. Publisher trust comes from the
// probed repository owner only: package names are self-declared listing fields
// and never grant identity. npm scopes below are retained solely to detect a
// contradiction between a scoped package name and the repository owner; the
// scope alone never promotes a candidate. PyPI/unscoped names carry no
// ownership claim and are ignored.
export const OFFICIAL_PUBLISHERS = {
  githubOrgs: new Set([
    "anthropics",
    "modelcontextprotocol",
    "microsoft",
    "github",
    "vercel-labs",
    "supabase",
    "playwright",
    "openai",
    "google",
    "google-labs-code",
    "aws",
    "cloudflare",
    "stripe",
    "figma",
    "linear",
    "sentry",
  ]),
  npmScopes: new Set([
    "@anthropic-ai",
    "@modelcontextprotocol",
    "@microsoft",
    "@github",
    "@vercel",
    "@supabase",
    "@playwright",
    "@openai",
    "@google",
    "@aws",
    "@cloudflare",
    "@stripe",
    "@figma",
    "@linear",
    "@sentry",
  ]),
};

// Scope owner aliases: the npm account and GitHub org need not share a name.
const NPM_SCOPE_OWNERS: Record<string, readonly string[]> = {
  "@anthropic-ai": ["anthropics"],
  "@modelcontextprotocol": ["modelcontextprotocol"],
  "@microsoft": ["microsoft"],
  "@github": ["github"],
  "@vercel": ["vercel-labs"],
  "@supabase": ["supabase"],
  "@playwright": ["playwright"],
  "@openai": ["openai"],
  "@google": ["google", "google-labs-code"],
  "@aws": ["aws"],
  "@cloudflare": ["cloudflare"],
  "@stripe": ["stripe"],
  "@figma": ["figma"],
  "@linear": ["linear"],
  "@sentry": ["sentry"],
};

export interface PublisherCandidate {
  repositoryUrl?: string | undefined;
  packageName?: string | undefined;
}

function githubOwner(repositoryUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return undefined;
  return url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
}

function npmScope(packageName: string): string | undefined {
  return /^(@[^/]+)\//.exec(packageName.trim())?.[1];
}

export function isOfficialPublisher(candidate: PublisherCandidate): boolean {
  const owner =
    candidate.repositoryUrl === undefined
      ? undefined
      : githubOwner(candidate.repositoryUrl);
  if (owner === undefined || !OFFICIAL_PUBLISHERS.githubOrgs.has(owner)) {
    return false;
  }
  const packageName = candidate.packageName?.trim();
  if (packageName === undefined || packageName === "") return true;
  const scope = npmScope(packageName);
  // Unscoped names cannot grant or revoke identity: they are not ownership
  // evidence. A malformed scoped name is a disagreement, not a pass.
  if (scope === undefined) return !packageName.startsWith("@");
  return NPM_SCOPE_OWNERS[scope]?.includes(owner) === true;
}

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
// official/standards-backed source or an allowlisted publisher with
// maintainer evidence, an artifact that was actually probed (listing-only
// records never verify), an immutable pinned ref (enforced at normalize time
// by CandidateSchema), active maintenance, an open license,
// checksum/attestation where supported, and no critical audit finding.
// Curated adds in-repo review evidence. Popularity is never consulted and
// cannot promote trust. An omitted checksumPresent means the artifact class
// carries no checksum signal (shortcut: no per-artifact support matrix yet;
// explicit false always blocks verified).
export function classifyTrust(
  candidate: Candidate,
  evidence: TrustEvidence,
): TrustClass {
  const sourceOk =
    candidate.provenance === "official" ||
    (candidate.provenance === "publisher" &&
      isOfficialPublisher(candidate) &&
      evidence.maintainerVerified);
  // Drifted or shell/exec-tainted candidates never inherit trust: a prior
  // verified review describes a different artifact, or the copy itself asks
  // for code execution.
  if (evidence.drifted === true || evidence.untrustedCopyRisk === true)
    return "unverified";
  const verified =
    candidate.artifactProbed === true &&
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

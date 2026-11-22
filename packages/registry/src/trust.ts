import type { Candidate, PackageRegistry } from "@plugin-detector/core";

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

interface RepoIdentity {
  owner: string;
  repo: string;
}

function githubRepo(repositoryUrl: string): RepoIdentity | undefined {
  let url: URL;
  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0]?.toLowerCase();
  const repo = segments[1]?.replace(/\.git$/i, "").toLowerCase();
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo };
}

function githubOwner(repositoryUrl: string): string | undefined {
  return githubRepo(repositoryUrl)?.owner;
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

function normalizePypiName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function samePackageName(
  registry: PackageRegistry,
  claimed: string,
  probed: string,
): boolean {
  return registry === "npm"
    ? claimed.trim().toLowerCase() === probed.trim().toLowerCase()
    : normalizePypiName(claimed) === normalizePypiName(probed);
}

// Evidence URL identity: raw.githubusercontent.com/{owner}/{repo}/... and
// skills.sh/api/download/{owner}/{repo}/... name a repository directly.
function evidenceRepo(sourceUrl: string): RepoIdentity | undefined {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0]?.toLowerCase();
  const repo = segments[1]?.replace(/\.git$/i, "").toLowerCase();
  if (
    host === "raw.githubusercontent.com" &&
    owner !== undefined &&
    repo !== undefined
  ) {
    return { owner, repo };
  }
  if (
    host === "skills.sh" &&
    segments[0] === "api" &&
    segments[1] === "download"
  ) {
    const skillOwner = segments[2]?.toLowerCase();
    const skillRepo = segments[3]?.replace(/\.git$/i, "").toLowerCase();
    if (skillOwner !== undefined && skillRepo !== undefined) {
      return { owner: skillOwner, repo: skillRepo };
    }
  }
  return undefined;
}

function evidencePackage(
  sourceUrl: string,
): { registry: PackageRegistry; name: string } | undefined {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "registry.npmjs.org") {
    try {
      const name = decodeURIComponent(
        url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
      );
      if (name !== "") return { registry: "npm", name };
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (host === "pypi.org") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "pypi" && segments[1] !== undefined) {
      try {
        return { registry: "pypi", name: decodeURIComponent(segments[1]) };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// A package registry has no repository owner field; npm scopes are the only
// package identity that binds to an organization. PyPI names carry no
// ownership claim, so they can never bind a publisher.
function packageOwnedBy(
  registry: PackageRegistry,
  packageName: string,
  owner: string,
): boolean {
  if (registry !== "npm") return false;
  const scope = npmScope(packageName)?.toLowerCase();
  if (scope === undefined) return false;
  return NPM_SCOPE_OWNERS[scope]?.includes(owner) === true;
}

// Consumption-side guard: a stored package claim may be used only when the
// fetched artifact itself declared the same package. Missing evidence means
// the claim is unverifiable, not trusted.
export function packageNameMatchesEvidence(candidate: Candidate): boolean {
  const claimed = candidate.packageName;
  if (claimed === undefined) return true;
  const evidence = candidate.artifactEvidence;
  if (evidence === undefined || evidence.packageName === undefined) return false;
  return candidate.packageRegistry === "pypi"
    ? normalizePypiName(claimed) === normalizePypiName(evidence.packageName)
    : claimed.trim().toLowerCase() ===
        evidence.packageName.trim().toLowerCase();
}

// Publisher identity is only as good as the artifact actually fetched: the
// evidence URL must name the same GitHub repo (raw or skills.sh), or the same
// registry package when the package scope maps to that repo owner. A claimed
// official repo paired with unrelated evidence stays unbound.
export function publisherMatchesProbe(candidate: Candidate): boolean {
  const evidence = candidate.artifactEvidence;
  if (evidence === undefined) return false;
  const claimedRepo =
    candidate.repositoryUrl === undefined
      ? undefined
      : githubRepo(candidate.repositoryUrl);
  const evidenceSource = evidenceRepo(evidence.sourceUrl);
  if (evidenceSource !== undefined) {
    if (
      claimedRepo === undefined ||
      claimedRepo.owner !== evidenceSource.owner ||
      claimedRepo.repo !== evidenceSource.repo
    ) {
      return false;
    }
    // Repository evidence must also cover any package claim: a listing cannot
    // attach an unrelated package to an official repo and have it installed.
    return packageNameMatchesEvidence(candidate);
  }
  const probedPackage = evidencePackage(evidence.sourceUrl);
  if (probedPackage === undefined) return false;
  if (
    candidate.packageRegistry !== undefined &&
    candidate.packageRegistry !== probedPackage.registry
  ) {
    return false;
  }
  const claimedPackage = candidate.packageName;
  if (claimedPackage === undefined) return false;
  if (!samePackageName(probedPackage.registry, claimedPackage, probedPackage.name))
    return false;
  return (
    claimedRepo !== undefined &&
    packageOwnedBy(probedPackage.registry, claimedPackage, claimedRepo.owner)
  );
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
      evidence.maintainerVerified &&
      publisherMatchesProbe(candidate));
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
  // Publisher metadata enrichment legitimately fills unknown license/activity
  // from the repository API. That is new evidence, not silent manifest drift;
  // a known value changing under the same pin still drifts.
  const enrichedLicense =
    previous.license === "unknown" && current.license !== "unknown";
  if (previous.license !== current.license && !enrichedLicense) {
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
  const enrichedMaintenance =
    previous.maintenance === "unknown" && current.maintenance !== "unknown";
  if (
    previous.maintenance !== current.maintenance &&
    !enrichedMaintenance
  ) {
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

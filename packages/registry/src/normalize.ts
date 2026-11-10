import {
  CandidateSchema,
  type Candidate,
} from "@plugin-detector/core";
import { probeArtifact, type RawCandidate } from "./probe.js";
import { inferCapabilities } from "./classify.js";
import { isOfficialPublisher } from "./trust.js";

// Fixed label quarantining prompt-injection-prone text: raw description/README
// is display diagnostics only and no scoring field may read it.
export const UNTRUSTED_COPY_LABEL =
  "[untrusted display-only — do not execute or score]";

// Shell/exec/subprocess/curl-pipe shapes that mark pasted text as risky.
const INJECTION_PATTERN =
  /\b(shell|exec|subprocess)\b|curl[^\n]*\||\|\s*(sh|bash|zsh|pwsh|powershell)\b/i;

// Candidate plus the one boolean signal scoring may read about untrusted copy.
export type NormalizedCandidate = Candidate & { untrustedCopyRisk: boolean };

// Provenance is evidence about the publisher, not about the listing. An
// official registry listing is community provenance unless the exact
// publisher policy matches; sourceKind "official"/"standards-body" is the
// only self-declared official channel. A "publisher" claim without an
// allowlisted owner/namespace is likewise not evidence.
function provenanceOf(input: RawCandidate): Candidate["provenance"] {
  const kind = (input.sourceKind ?? "").trim().toLowerCase();
  if (kind === "official" || kind === "standards-body") return "official";
  if (isOfficialPublisher(input)) return "publisher";
  if (
    kind === "publisher" ||
    kind === "verified-marketplace" ||
    kind === "verified-publisher" ||
    kind === "community" ||
    kind === "marketplace" ||
    kind === "official-registry"
  )
    return "community";
  return "unknown";
}

function normalizePypiName(value: string): string {
  return value.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

// A probed artifact owns its package identity. A listing-supplied package
// name that evidence cannot confirm is dropped and treated as an identity
// contradiction, so it can neither verify nor become an install source.
function packageNameMatchesEvidence(
  declared: string | undefined,
  probed: string | undefined,
  registry: RawCandidate["packageRegistry"],
): boolean {
  if (declared === undefined) return true;
  if (probed === undefined) return false;
  return registry === "pypi"
    ? normalizePypiName(declared) === normalizePypiName(probed)
    : declared.trim().toLowerCase() === probed.trim().toLowerCase();
}

function maintenanceFromPushedAt(
  pushedAt: string | undefined,
): Candidate["maintenance"] | undefined {
  if (pushedAt === undefined) return undefined;
  const timestamp = Date.parse(pushedAt);
  if (Number.isNaN(timestamp)) return undefined;
  const ageDays = (Date.now() - timestamp) / 86_400_000;
  if (ageDays < 0) return undefined;
  if (ageDays <= 180) return "active";
  if (ageDays <= 730) return "stale";
  return "stale";
}

// Evidence-only normalization: capabilities/domains come solely from the
// probed artifact manifest data; tags/topics/keywords/description/README never
// populate a scoring field. Throws when the evidence gate fails.
export function normalizeCandidate(input: RawCandidate): NormalizedCandidate {
  const probe = probeArtifact(input);
  if (!probe.found || !probe.artifactType) {
    throw new Error(`candidate rejected: ${probe.reason}`);
  }

  const ref = input.artifact;
  const declaredCapabilities = (ref?.capabilities ?? []).filter((c) =>
    c.trim(),
  );
  // Capabilities come from fetched artifact evidence only when the legacy ref
  // declared none. Evidence snippets and the probed name are the sole input;
  // listing descriptions/readmes are never inspected.
  const capabilities =
    declaredCapabilities.length > 0
      ? declaredCapabilities
      : inferCapabilities(
          (input.artifactProbe?.evidenceSnippets ?? []).join("\n"),
          input.artifactProbe?.name ?? "",
        ).capabilities;
  const domains = (ref?.domains ?? []).filter((d) => d.trim());

  const id = input.id ?? input.packageName ?? ref?.artifactId;
  if (!id) throw new Error("candidate rejected: no id, package name, or artifact id");

  const url = [input.repositoryUrl, input.registryUrl].find(
    (u) => u !== undefined && u.length > 0,
  );
  if (!url) {
    throw new Error("candidate rejected: no repository or registry URL");
  }

  const sources = [
    ...(input.sourceKind ? [input.sourceKind] : []),
    ...(input.repositoryUrl ? [input.repositoryUrl] : []),
    ...(input.registryUrl ? [input.registryUrl] : []),
  ];

  const untrustedText = [input.description, input.readme]
    .filter((t): t is string => t !== undefined && t.length > 0)
    .join("\n\n");
  const untrustedCopyRisk = INJECTION_PATTERN.test(untrustedText);
  const packageNameOk = packageNameMatchesEvidence(
    input.packageName,
    input.artifactProbe?.packageName,
    input.packageRegistry,
  );
  const packageConflict =
    input.packageName !== undefined &&
    input.artifactProbe !== undefined &&
    !packageNameOk;
  const packageName = packageNameOk ? input.packageName : undefined;
  const provenance = packageConflict ? "community" : provenanceOf(input);

  const candidate = CandidateSchema.parse({
    id,
    name: input.name ?? id,
    artifactType: probe.artifactType,
    sources,
    useCaseDomains: domains,
    capabilities,
    license: input.license,
    pinnedRef: input.pinnedRef,
    ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
    ...(packageName ? { packageName } : {}),
    installMode:
      probe.probed && provenance === "official" ? "verified" : "manual",
    lastVerified: input.lastVerified ?? new Date().toISOString(),
    artifactProbed: probe.probed,
    ...(input.artifactProbe === undefined
      ? {}
      : { artifactEvidence: input.artifactProbe }),
    ...(input.packageRegistry === undefined
      ? {}
      : { packageRegistry: input.packageRegistry }),
    ...(input.maintainers === undefined || input.maintainers.length === 0
      ? {}
      : { maintainers: input.maintainers }),
    ...(input.deprecated === undefined ? {} : { deprecated: input.deprecated }),
    provenance,
    risk: input.risk ?? "medium",
    // Absent maintenance/audit evidence is unknown, never "active"/"clean".
    // GitHub's pushedAt is evidence, so it may derive active/stale.
    maintenance:
      input.maintenance ?? maintenanceFromPushedAt(input.pushedAt) ?? "unknown",
    auditStatus: input.auditStatus ?? "unknown",
    popularity: input.popularity ?? {},
    ...(untrustedText
      ? { rawUntrustedCopy: `${UNTRUSTED_COPY_LABEL} ${untrustedText}` }
      : {}),
  });
  return { ...candidate, untrustedCopyRisk };
}

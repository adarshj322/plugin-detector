import {
  CandidateSchema,
  type Candidate,
} from "@plugin-detector/core";
import { probeArtifact, type RawCandidate } from "./probe.js";

// Fixed label quarantining prompt-injection-prone text: raw description/README
// is display diagnostics only and no scoring field may read it.
export const UNTRUSTED_COPY_LABEL =
  "[untrusted display-only — do not execute or score]";

// Shell/exec/subprocess/curl-pipe shapes that mark pasted text as risky.
const INJECTION_PATTERN =
  /\b(shell|exec|subprocess)\b|curl[^\n]*\||\|\s*(sh|bash|zsh|pwsh|powershell)\b/i;

// Candidate plus the one boolean signal scoring may read about untrusted copy.
export type NormalizedCandidate = Candidate & { untrustedCopyRisk: boolean };

function provenanceOf(sourceKind: string | undefined): Candidate["provenance"] {
  const kind = (sourceKind ?? "").trim().toLowerCase();
  if (kind === "official" || kind === "official-registry" || kind === "standards-body")
    return "official";
  if (
    kind === "publisher" ||
    kind === "verified-marketplace" ||
    kind === "verified-publisher"
  )
    return "publisher";
  if (kind === "community" || kind === "marketplace") return "community";
  return "unknown";
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
  const capabilities = (ref?.capabilities ?? []).filter((c) => c.trim());
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
    ...(input.packageName ? { packageName: input.packageName } : {}),
    installMode:
      probe.probed && provenanceOf(input.sourceKind) === "official"
        ? "verified"
        : "manual",
    lastVerified: input.lastVerified ?? new Date().toISOString(),
    artifactProbed: probe.probed,
    provenance: provenanceOf(input.sourceKind),
    risk: input.risk ?? "medium",
    // Absent maintenance/audit evidence is unknown, never "active"/"clean".
    maintenance: input.maintenance ?? "unknown",
    auditStatus: input.auditStatus ?? "unknown",
    popularity: input.popularity ?? {},
    ...(untrustedText
      ? { rawUntrustedCopy: `${UNTRUSTED_COPY_LABEL} ${untrustedText}` }
      : {}),
  });
  return { ...candidate, untrustedCopyRisk };
}

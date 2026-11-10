import { createHash } from "node:crypto";
import { stableStringify, type ArtifactType } from "@plugin-detector/core";
import type { ArtifactEvidence } from "./probe.js";
import { MAX_EVIDENCE_SNIPPET_LENGTH } from "./probe-skills-sh.js";
import {
  MAX_PACKAGE_METADATA_BYTES,
  PACKAGE_REGISTRY_LIMITER,
  PackageProbeError,
  npmPackageUrl,
  packageRegistryGet,
  parseNpmRegistry,
  parsePypiRegistry,
  pypiPackageUrl,
  repositoryUrlOf,
  type PackageJsonGetter,
  type PackageMetadata,
  type PackageRegistry,
} from "./sources/package-registries.js";
import { RateLimiter, SourceHttpError } from "./sources/http.js";

export {
  PACKAGE_REGISTRY_LIMITER,
  PackageProbeError,
  npmPackageUrl,
  packageRegistryGet,
  parseNpmRegistry,
  parsePypiRegistry,
  pypiPackageUrl,
} from "./sources/package-registries.js";
export type {
  PackageJsonGetter,
  PackageMetadata,
  PackageProbeCode,
  PackageRegistry,
} from "./sources/package-registries.js";

type PackageArtifactType = Extract<ArtifactType, "mcp-server" | "tool">;

export interface ProbePackageOptions {
  // Test seam; production callers use the shared 60/min registry limiter.
  get?: PackageJsonGetter | undefined;
  limiter?: RateLimiter | undefined;
  // Defaults to npm. PyPI callers must say so: a dashed name is valid on both.
  registry?: PackageRegistry | undefined;
  // Caller-owned classification; a package alone cannot prove it is an MCP server.
  artifactType?: PackageArtifactType | undefined;
  // Optional repository pin (e.g. the MCP listing's repository); a different
  // normalized registry repository is a typed mismatch.
  expectedRepository?: string | undefined;
}

export interface PackageProbeResult {
  evidence: ArtifactEvidence;
  metadata: PackageMetadata;
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

function validateName(registry: PackageRegistry, value: string): string {
  const name = value.trim();
  const valid =
    registry === "npm"
      ? name.length <= 214 && NPM_NAME.test(name)
      : name.length <= 200 && PYPI_NAME.test(name);
  if (!valid) {
    throw new PackageProbeError(
      name,
      "ARTIFACT_INVALID",
      `is not a valid ${registry} package name`,
    );
  }
  return name;
}

function boundedSnippet(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= MAX_EVIDENCE_SNIPPET_LENGTH
    ? singleLine
    : singleLine.slice(0, MAX_EVIDENCE_SNIPPET_LENGTH);
}

function boundedReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

function buildEvidence(
  metadata: PackageMetadata,
  sourceUrl: string,
  kind: PackageArtifactType,
): ArtifactEvidence {
  const license = metadata.license.length > 0 ? metadata.license : "unknown";
  const snippets = [boundedSnippet(`license: ${license}`)];
  const detail =
    metadata.description !== undefined
      ? `description: ${metadata.description}`
      : metadata.repositoryUrl !== undefined
        ? `repository: ${metadata.repositoryUrl}`
        : undefined;
  if (detail !== undefined) snippets.push(boundedSnippet(detail));
  return {
    kind,
    sourceUrl,
    resolvedRef: `${metadata.registry}:${metadata.name}@${metadata.version}`,
    // Metadata hash, never the tarball: the package payload is not fetched.
    contentHash: createHash("sha256")
      .update(stableStringify(metadata), "utf8")
      .digest("hex"),
    license,
    name: metadata.name,
    packageName: metadata.name,
    version: metadata.version,
    // Task 7 owns capability inference; the probe records none of its own.
    capabilities: [],
    evidenceSnippets: snippets.slice(0, 2),
    retrievedAt: new Date().toISOString(),
  };
}

export async function probePackage(
  packageName: string,
  version?: string,
  opts: ProbePackageOptions = {},
): Promise<PackageProbeResult> {
  const registry = opts.registry ?? "npm";
  const name = validateName(registry, packageName);
  const requested = version?.trim() === "" ? undefined : version?.trim();
  const expectedRepository =
    opts.expectedRepository === undefined
      ? undefined
      : repositoryUrlOf(opts.expectedRepository);
  if (opts.expectedRepository !== undefined && expectedRepository === undefined) {
    throw new PackageProbeError(
      name,
      "ARTIFACT_INVALID",
      "expectedRepository is not a valid repository URL",
    );
  }
  const url =
    registry === "npm"
      ? npmPackageUrl(name)
      : pypiPackageUrl(name, requested);
  const get = opts.get ?? packageRegistryGet;
  const limiter = opts.limiter ?? PACKAGE_REGISTRY_LIMITER;

  let payload: unknown;
  try {
    payload = await limiter.run(() => get(url));
  } catch (error) {
    if (error instanceof SourceHttpError) {
      if (error.status === 404 || error.status === 410) {
        throw new PackageProbeError(
          name,
          "ARTIFACT_MISSING",
          `not found in the ${registry} registry`,
        );
      }
      // Fetch refuses redirects (the registry host is fixed); the transport
      // returns a fixed message, so no redirect target can leak.
      if (error.status === 0 && /redirect/i.test(error.message)) {
        throw new PackageProbeError(
          name,
          "ARTIFACT_INVALID",
          `fetching metadata was redirected; refusing to follow`,
        );
      }
      if (
        error.status === 0 &&
        /response exceeded \d+ bytes/.test(error.message)
      ) {
        throw new PackageProbeError(
          name,
          "ARTIFACT_TOO_LARGE",
          `metadata exceeds the ${MAX_PACKAGE_METADATA_BYTES}-byte limit`,
        );
      }
    }
    throw new PackageProbeError(
      name,
      "ARTIFACT_UNAVAILABLE",
      `fetching metadata failed: ${boundedReason(error)}`,
    );
  }

  const metadata =
    registry === "npm"
      ? parseNpmRegistry(payload, name, requested)
      : parsePypiRegistry(payload, name, requested);
  if (
    expectedRepository !== undefined &&
    metadata.repositoryUrl !== expectedRepository
  ) {
    throw new PackageProbeError(
      name,
      "ARTIFACT_MISMATCH",
      "registry repository does not match expectedRepository",
    );
  }
  return {
    evidence: buildEvidence(metadata, url, opts.artifactType ?? "tool"),
    metadata,
  };
}

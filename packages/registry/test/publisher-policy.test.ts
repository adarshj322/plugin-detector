import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_PUBLISHERS,
  isOfficialPublisher,
  normalizeCandidate,
  type RawCandidate,
} from "../src/index.js";

// Valid-by-default raw record for a probed community listing.
function rawCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    id: "acme-thumb",
    name: "Acme Thumbnails",
    artifact: { kind: "mcp", file: "server.json" },
    sourceKind: "community",
    pinnedRef: "1.4.2",
    license: "MIT",
    repositoryUrl: "https://github.com/acme/thumb",
    maintenance: "active",
    auditStatus: "clean",
    ...overrides,
  };
}

test("official publisher lists are exact and explicit", () => {
  for (const org of [
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
  ]) {
    assert.ok(OFFICIAL_PUBLISHERS.githubOrgs.has(org), org);
  }
  for (const scope of [
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
  ]) {
    assert.ok(OFFICIAL_PUBLISHERS.npmScopes.has(scope), scope);
  }
});

test("GitHub owner match is exact, case-insensitive, and GitHub-only", () => {
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://github.com/anthropics/skills" }),
    true,
  );
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://github.com/OpenAI/openai-node" }),
    true,
  );
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://github.com/openaix/plugin" }),
    false,
  );
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://github.com/acme/openai" }),
    false,
  );
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://github.com/openai-evil/plugin" }),
    false,
  );
  assert.equal(
    isOfficialPublisher({ repositoryUrl: "https://gitlab.com/openai/plugin" }),
    false,
  );
  assert.equal(isOfficialPublisher({ repositoryUrl: "not a url" }), false);
});

test("package names alone never establish publisher identity", () => {
  for (const packageName of [
    "@openai/sdk",
    "@anthropic-ai/sdk",
    "openai",
    "linear",
    "google",
    "google-genai",
    "OpenAI_SDK",
    "openaix",
  ]) {
    assert.equal(isOfficialPublisher({ packageName }), false, packageName);
  }
});

test("registered npm scope must agree with the repository owner", () => {
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@openai/sdk",
    }),
    true,
  );
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/anthropics/skills",
      packageName: "@anthropic-ai/sdk",
    }),
    true,
  );
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@openai-evil/sdk",
    }),
    false,
  );
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@anthropic-ai/sdk",
    }),
    false,
  );
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/acme/thumb",
      packageName: "@openai/sdk",
    }),
    false,
  );
  // Unscoped names carry no ownership claim and cannot contradict the repo.
  assert.equal(
    isOfficialPublisher({
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "openai",
    }),
    true,
  );
});

test("normalization maps official publisher repos to publisher provenance", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/anthropics/skills",
    }),
  );
  assert.equal(candidate.provenance, "publisher");
});

test("manifest packageName cannot manufacture publisher provenance", () => {
  for (const packageName of ["openai", "linear", "@openai/sdk"]) {
    const candidate = normalizeCandidate(
      rawCandidate({
        sourceKind: "community",
        repositoryUrl: "https://github.com/acme/evil",
        packageName,
      }),
    );
    assert.equal(candidate.provenance, "community", packageName);
  }
});

test("official registry listing without an official publisher is not official", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "official-registry",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(candidate.provenance, "community");
});

test("only official and standards-body sources yield official provenance", () => {
  const official = normalizeCandidate(
    rawCandidate({
      sourceKind: "official",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(official.provenance, "official");
  const standards = normalizeCandidate(
    rawCandidate({
      sourceKind: "standards-body",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(standards.provenance, "official");
});

test("a self-declared publisher without the allowlist stays community", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "publisher",
      repositoryUrl: "https://github.com/acme/thumb",
    }),
  );
  assert.equal(candidate.provenance, "community");
});

test("official repo with a mismatched package scope stays community", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/openai/openai-node",
      packageName: "@anthropic-ai/sdk",
    }),
  );
  assert.equal(candidate.provenance, "community");
});

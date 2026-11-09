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
    artifactProbed: true,
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
    isOfficialPublisher({ repositoryUrl: "https://gitlab.com/openai/plugin" }),
    false,
  );
  assert.equal(isOfficialPublisher({ repositoryUrl: "not a url" }), false);
});

test("npm scope match is exact and does not accept lookalikes", () => {
  assert.equal(isOfficialPublisher({ packageName: "@openai/sdk" }), true);
  assert.equal(isOfficialPublisher({ packageName: "@openai-evil/sdk" }), false);
  assert.equal(isOfficialPublisher({ packageName: "@openaix/sdk" }), false);
  assert.equal(isOfficialPublisher({ packageName: "@openai" }), false);
  assert.equal(isOfficialPublisher({ packageName: "openai" }), true);
  assert.equal(isOfficialPublisher({ packageName: "openaix" }), false);
});

test("PyPI namespace match uses a dash boundary, never a substring", () => {
  assert.equal(isOfficialPublisher({ packageName: "openai" }), true);
  assert.equal(isOfficialPublisher({ packageName: "openai-sdk" }), true);
  assert.equal(isOfficialPublisher({ packageName: "OpenAI_SDK" }), true);
  assert.equal(isOfficialPublisher({ packageName: "openaix" }), false);
  assert.equal(isOfficialPublisher({ packageName: "my-openai" }), false);
});

test("normalization maps official publishers to publisher provenance", () => {
  const candidate = normalizeCandidate(
    rawCandidate({
      sourceKind: "community",
      repositoryUrl: "https://github.com/anthropics/skills",
    }),
  );
  assert.equal(candidate.provenance, "publisher");
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

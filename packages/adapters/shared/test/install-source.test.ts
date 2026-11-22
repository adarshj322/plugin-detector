import test from "node:test";
import assert from "node:assert/strict";
import { CandidateSchema, type Candidate } from "@plugin-detector/core";
import { skillInstallSpec } from "../src/install-source.js";

const PROBED_AT = "2026-11-01T00:00:00.000Z";

function candidate(overrides: Record<string, unknown> = {}): Candidate {
  return CandidateSchema.parse({
    id: "owner/repo/my-skill",
    name: "my-skill",
    artifactType: "skill",
    sources: [],
    useCaseDomains: [],
    capabilities: ["testing.runner"],
    license: "MIT",
    pinnedRef: "v1.0.0",
    repositoryUrl: "https://github.com/owner/repo",
    installMode: "manual",
    lastVerified: PROBED_AT,
    artifactProbed: true,
    artifactEvidence: {
      kind: "skill",
      sourceUrl:
        "https://skills.sh/api/download/owner/repo/my-skill",
      resolvedRef: "main",
      contentHash: "a".repeat(64),
      license: "MIT",
      name: "my-skill",
      capabilities: [],
      evidenceSnippets: ["name: my-skill"],
      retrievedAt: PROBED_AT,
    },
    provenance: "publisher",
    risk: "low",
    maintenance: "active",
    auditStatus: "unknown",
    popularity: {},
    ...overrides,
  });
}

test("skill install spec pins the repository and skill name", () => {
  assert.equal(skillInstallSpec(candidate()), "owner/repo@my-skill");
});

test("an explicit package spec is never rewritten", () => {
  assert.equal(
    skillInstallSpec(candidate({ packageName: "@scope/my-skill" })),
    "@scope/my-skill",
  );
});

test("non-GitHub and non-skill candidates keep their existing source", () => {
  assert.equal(
    skillInstallSpec(candidate({ repositoryUrl: "https://example.com/repo" })),
    "https://example.com/repo",
  );
  assert.equal(
    skillInstallSpec(candidate({ artifactType: "plugin" })),
    "https://github.com/owner/repo",
  );
});

test("an unsafe skill name falls back to the repository source", () => {
  assert.equal(
    skillInstallSpec(
      candidate({ artifactEvidence: undefined, name: "my skill; rm -rf" }),
    ),
    "https://github.com/owner/repo",
  );
});

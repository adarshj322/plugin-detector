import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stableStringify } from "@plugin-detector/core";
import { ArtifactEvidenceSchema } from "../src/probe.js";
import {
  PACKAGE_REGISTRY_LIMITER,
  PackageProbeError,
  npmPackageUrl,
  probePackage,
  pypiPackageUrl,
  type PackageJsonGetter,
  type ProbePackageOptions,
} from "../src/probe-package.js";
import {
  parseNpmRegistry,
  parsePypiRegistry,
} from "../src/sources/package-registries.js";
import { RateLimiter, SourceHttpError } from "../src/sources/http.js";

const FIXTURE_DIR = "../../../../fixtures/registry";

function fixture(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`${FIXTURE_DIR}/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, any>;
}

function npmFixture(): Record<string, any> {
  return fixture("npm-package.json");
}

function pypiFixture(): Record<string, any> {
  return fixture("pypi-package.json");
}

function fastLimiter(): RateLimiter {
  // Tests exercise request shape, not pacing: keep the 60/min budget out.
  return new RateLimiter();
}

function jsonGet(
  payload: unknown,
  calls: string[] = [],
): PackageJsonGetter {
  return async (url) => {
    calls.push(url);
    return payload;
  };
}

async function probe(
  packageName: string,
  version: string | undefined,
  payload: unknown,
  opts: ProbePackageOptions = {},
): Promise<{ evidence: Awaited<ReturnType<typeof probePackage>>; calls: string[] }> {
  const calls: string[] = [];
  const evidence = await probePackage(packageName, version, {
    get: jsonGet(payload, calls),
    limiter: fastLimiter(),
    ...opts,
  });
  return { evidence, calls };
}

async function probeError(
  packageName: string,
  version: string | undefined,
  payload: unknown,
  opts: ProbePackageOptions = {},
): Promise<PackageProbeError> {
  let caught: unknown;
  try {
    await probe(packageName, version, payload, opts);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof PackageProbeError,
    `expected PackageProbeError, got ${String(caught)}`,
  );
  return caught;
}

function metadataHash(metadata: unknown): string {
  return createHash("sha256")
    .update(stableStringify(metadata), "utf8")
    .digest("hex");
}

function notFound(url: string): SourceHttpError {
  return new SourceHttpError(url, 404, false, `GET ${url} failed with status 404`);
}

const SCOPED_NPM = "@modelcontextprotocol/server-filesystem";

test("npm scoped package probes latest metadata without fetching the tarball", async () => {
  const payload = npmFixture();
  const { evidence, calls } = await probe(SCOPED_NPM, undefined, payload);

  assert.deepEqual(calls, [
    "https://registry.npmjs.org/%40modelcontextprotocol%2Fserver-filesystem",
  ]);
  assert.equal(
    evidence.sourceUrl,
    "https://registry.npmjs.org/%40modelcontextprotocol%2Fserver-filesystem",
  );
  assert.equal(evidence.kind, "tool");
  assert.equal(evidence.name, SCOPED_NPM);
  assert.equal(evidence.version, "2.2.0");
  assert.equal(evidence.resolvedRef, `npm:${SCOPED_NPM}@2.2.0`);
  assert.equal(evidence.license, "Apache-2.0");
  assert.deepEqual(evidence.capabilities, []);
  assert.equal(evidence.evidenceSnippets.length, 2);
  assert.equal(evidence.evidenceSnippets[0], "license: Apache-2.0");
  assert.equal(
    evidence.evidenceSnippets[1],
    "repository: https://github.com/modelcontextprotocol/servers",
  );
  for (const snippet of evidence.evidenceSnippets) {
    assert.ok(snippet.length <= 300);
  }
  assert.ok(!Number.isNaN(Date.parse(evidence.retrievedAt)));
  assert.doesNotMatch(JSON.stringify(evidence), /BODY-MARKER/);
  assert.doesNotMatch(JSON.stringify(evidence), /\.tgz/);
  assert.equal(ArtifactEvidenceSchema.parse(evidence).kind, "tool");

  const metadata = parseNpmRegistry(payload, SCOPED_NPM);
  assert.equal(evidence.contentHash, metadataHash(metadata));
  assert.equal(metadata.repositoryUrl, "https://github.com/modelcontextprotocol/servers");
  assert.equal(metadata.homepage, "https://modelcontextprotocol.io");
  assert.deepEqual(metadata.maintainers, ["jspahrsummers", "pcarleton"]);
  assert.equal(
    metadata.tarball,
    "https://registry.npmjs.org/@modelcontextprotocol/server-filesystem/-/server-filesystem-2.2.0.tgz",
  );
});

test("npm exact version wins and deprecated packages record the reason", async () => {
  const payload = npmFixture();
  const { evidence } = await probe(SCOPED_NPM, "1.0.0", payload);
  assert.equal(evidence.version, "1.0.0");
  assert.equal(evidence.resolvedRef, `npm:${SCOPED_NPM}@1.0.0`);

  const metadata = parseNpmRegistry(payload, SCOPED_NPM, "1.0.0");
  assert.equal(metadata.deprecated, "use 2.x instead");
  assert.deepEqual(metadata.maintainers, ["jspahrsummers"]);
});

test("npm object license and repository shorthand are normalized", () => {
  const metadata = parseNpmRegistry(npmFixture(), SCOPED_NPM, "2.1.0");
  assert.equal(metadata.license, "Apache-2.0");
  assert.equal(metadata.repositoryUrl, "https://github.com/modelcontextprotocol/servers");
  // Version entry omits maintainers; root maintainers fill in.
  assert.deepEqual(metadata.maintainers, ["jspahrsummers", "pcarleton"]);
});

test("npm root metadata fills fields missing from a version entry", () => {
  const metadata = parseNpmRegistry(npmFixture(), SCOPED_NPM, "3.0.0-beta.1");
  assert.equal(metadata.version, "3.0.0-beta.1");
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.homepage, "https://modelcontextprotocol.io");
  assert.equal(metadata.repositoryUrl, "https://github.com/modelcontextprotocol/servers");
  assert.deepEqual(metadata.maintainers, ["jspahrsummers", "pcarleton"]);
});

test("npm unscoped package URL is a single encoded path segment", async () => {
  const payload = {
    name: "cool-tool",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": { name: "cool-tool", version: "1.0.0", license: "MIT" },
    },
  };
  const { evidence, calls } = await probe("cool-tool", undefined, payload);
  assert.deepEqual(calls, ["https://registry.npmjs.org/cool-tool"]);
  assert.equal(evidence.resolvedRef, "npm:cool-tool@1.0.0");
  assert.equal(npmPackageUrl("cool-tool"), "https://registry.npmjs.org/cool-tool");
});

test("npm missing requested version is a typed missing error", async () => {
  const error = await probeError(SCOPED_NPM, "9.9.9", npmFixture());
  assert.equal(error.code, "ARTIFACT_MISSING");
  assert.match(error.reason, /9\.9\.9/);
});

test("npm packument without a latest dist-tag is a typed missing error", async () => {
  const payload = npmFixture();
  delete payload["dist-tags"];
  const error = await probeError(SCOPED_NPM, undefined, payload);
  assert.equal(error.code, "ARTIFACT_MISSING");
  assert.match(error.reason, /latest/i);
});

test("npm malformed packument is invalid and never echoes the body", async () => {
  const payload = {
    name: SCOPED_NPM,
    marker: "BODY-MARKER",
    versions: "BODY-MARKER",
  };
  const error = await probeError(SCOPED_NPM, undefined, payload);
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.doesNotMatch(error.message, /BODY-MARKER/);
  assert.doesNotMatch(error.reason, /BODY-MARKER/);
});

test("npm response name mismatch is a typed mismatch", async () => {
  const error = await probeError("@acme/squatter", undefined, npmFixture());
  assert.equal(error.code, "ARTIFACT_MISMATCH");
  assert.match(error.reason, /server-filesystem/);
});

test("npm missing license and repository fall back to unknown and description", async () => {
  const payload = {
    name: "bare-tool",
    "dist-tags": { latest: "0.1.0" },
    versions: {
      "0.1.0": {
        name: "bare-tool",
        version: "0.1.0",
        description: "A tiny tool",
      },
    },
  };
  const { evidence } = await probe("bare-tool", undefined, payload);
  assert.equal(evidence.license, "unknown");
  assert.deepEqual(evidence.evidenceSnippets, [
    "license: unknown",
    "description: A tiny tool",
  ]);

  const metadata = parseNpmRegistry(payload, "bare-tool");
  assert.equal(metadata.repositoryUrl, undefined);
  assert.equal(metadata.license, "unknown");
});

test("npm 404 is a typed missing error", async () => {
  let caught: unknown;
  try {
    await probePackage("missing-tool", undefined, {
      get: async (url) => {
        throw notFound(url);
      },
      limiter: fastLimiter(),
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PackageProbeError);
  assert.equal(caught.code, "ARTIFACT_MISSING");
  assert.match(caught.reason, /not found/i);
});

test("mcp-server artifact type reaches the evidence kind", async () => {
  const { evidence } = await probe(SCOPED_NPM, undefined, npmFixture(), {
    artifactType: "mcp-server",
  });
  assert.equal(evidence.kind, "mcp-server");
  assert.equal(ArtifactEvidenceSchema.parse(evidence).kind, "mcp-server");
});

test("metadata hash is deterministic across key order and is not the tarball hash", async () => {
  const one = {
    name: "stable-tool",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        name: "stable-tool",
        version: "1.0.0",
        license: "MIT",
        maintainers: [{ name: "alice", email: "alice@example.com" }],
      },
    },
  };
  const two = {
    versions: {
      "1.0.0": {
        maintainers: [{ name: "alice", email: "alice@example.com" }],
        license: "MIT",
        version: "1.0.0",
        name: "stable-tool",
      },
    },
    "dist-tags": { latest: "1.0.0" },
    name: "stable-tool",
  };
  const first = (await probe("stable-tool", undefined, one)).evidence;
  const second = (await probe("stable-tool", undefined, two)).evidence;
  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(
    first.contentHash,
    metadataHash(parseNpmRegistry(one, "stable-tool")),
  );
});

test("pypi project probes latest info and repository project url", async () => {
  const { evidence, calls } = await probe("acme-py-mcp", undefined, pypiFixture(), {
    registry: "pypi",
  });
  assert.deepEqual(calls, ["https://pypi.org/pypi/acme-py-mcp/json"]);
  assert.equal(evidence.sourceUrl, "https://pypi.org/pypi/acme-py-mcp/json");
  assert.equal(evidence.kind, "tool");
  assert.equal(evidence.name, "acme-py-mcp");
  assert.equal(evidence.version, "1.3.0");
  assert.equal(evidence.resolvedRef, "pypi:acme-py-mcp@1.3.0");
  assert.equal(evidence.license, "MIT");
  assert.deepEqual(evidence.evidenceSnippets, [
    "license: MIT",
    "repository: https://github.com/acme/acme-py-mcp",
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /BODY-MARKER/);
  assert.equal(pypiPackageUrl("acme-py-mcp"), "https://pypi.org/pypi/acme-py-mcp/json");

  const metadata = parsePypiRegistry(pypiFixture(), "acme-py-mcp");
  assert.equal(metadata.homepage, "https://example.com/acme-py-mcp");
  assert.deepEqual(metadata.maintainers, ["Acme Maintainers"]);
  assert.equal(metadata.projectUrls?.["Documentation"], "https://docs.example.com/acme-py-mcp");
  assert.equal(evidence.contentHash, metadataHash(metadata));
});

test("pypi exact version requires a published release", async () => {
  const { evidence } = await probe("acme-py-mcp", "1.2.0", pypiFixture(), {
    registry: "pypi",
  });
  assert.equal(evidence.version, "1.2.0");
  assert.equal(evidence.resolvedRef, "pypi:acme-py-mcp@1.2.0");

  const error = await probeError("acme-py-mcp", "9.9.9", pypiFixture(), {
    registry: "pypi",
  });
  assert.equal(error.code, "ARTIFACT_MISSING");
  assert.match(error.reason, /9\.9\.9/);
});

test("pypi name normalization accepts underscore spelling", async () => {
  const { evidence, calls } = await probe("acme_py_mcp", undefined, pypiFixture(), {
    registry: "pypi",
  });
  assert.deepEqual(calls, ["https://pypi.org/pypi/acme_py_mcp/json"]);
  assert.equal(evidence.name, "acme-py-mcp");
  assert.equal(evidence.resolvedRef, "pypi:acme-py-mcp@1.3.0");
});

test("pypi missing license falls back to unknown and a description snippet", async () => {
  const payload = pypiFixture();
  delete payload.info.license;
  delete payload.info.project_urls;
  payload.info.license_expression = null;
  payload.info.summary = "A tiny MCP server";
  const { evidence } = await probe("acme-py-mcp", undefined, payload, {
    registry: "pypi",
  });
  assert.equal(evidence.license, "unknown");
  assert.deepEqual(evidence.evidenceSnippets, [
    "license: unknown",
    "description: A tiny MCP server",
  ]);
});

test("pypi malformed response and 404 are typed errors", async () => {
  const malformed = await probeError("acme-py-mcp", undefined, {
    info: "BODY-MARKER",
  }, { registry: "pypi" });
  assert.equal(malformed.code, "ARTIFACT_INVALID");
  assert.doesNotMatch(malformed.message, /BODY-MARKER/);

  let caught: unknown;
  try {
    await probePackage("missing-py", undefined, {
      registry: "pypi",
      get: async (url) => {
        throw notFound(url);
      },
      limiter: fastLimiter(),
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PackageProbeError);
  assert.equal(caught.code, "ARTIFACT_MISSING");
});

test("probe pacing uses the shared package registry limiter for injected getters", async () => {
  const held: number[] = [];
  for (let i = 0; i < PACKAGE_REGISTRY_LIMITER.concurrency; i += 1) {
    await PACKAGE_REGISTRY_LIMITER.acquire();
    held.push(i);
  }
  const calls: string[] = [];
  const pending = probePackage("cool-tool", undefined, {
    get: jsonGet(
      {
        name: "cool-tool",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": { name: "cool-tool", version: "1.0.0", license: "MIT" },
        },
      },
      calls,
    ),
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], "probe must wait for the shared limiter");
  } finally {
    for (let i = 0; i < held.length; i += 1) PACKAGE_REGISTRY_LIMITER.release();
  }
  const evidence = await pending;
  assert.equal(calls.length, 1);
  assert.equal(evidence.resolvedRef, "npm:cool-tool@1.0.0");
});

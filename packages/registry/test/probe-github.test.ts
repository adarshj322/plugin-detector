import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCandidate } from "../src/normalize.js";
import { probeArtifact, type RawCandidate } from "../src/probe.js";
import {
  GITHUB_RAW_LIMITER,
  GithubProbeError,
  MAX_MANIFEST_BYTES,
  probeGithub,
} from "../src/probe-github.js";
import { parseGithubSearch } from "../src/sources/github.js";
import { parseAwesomeList } from "../src/sources/awesome-lists.js";
import {
  RateLimiter,
  SourceHttpError,
  type HttpGetter,
} from "../src/sources/http.js";

const FIXTURE_DIR = "../../../../fixtures/registry/github";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`${FIXTURE_DIR}/${name}`, import.meta.url)),
    "utf8",
  );
}

function fastLimiter(): RateLimiter {
  // Tests exercise request shape, not pacing: keep the 60/min budget out.
  return new RateLimiter();
}

function listing(
  repo: string,
  overrides: Partial<RawCandidate> = {},
): RawCandidate {
  return {
    id: `acme/${repo}`,
    name: repo,
    artifact: { kind: "plugin", file: "plugin.json" },
    artifactProbed: false,
    sourceKind: "community",
    pinnedRef: "0.0.0",
    license: "unknown",
    repositoryUrl: `https://github.com/acme/${repo}`,
    defaultBranch: "main",
    ...overrides,
  };
}

function notFound(url: string): SourceHttpError {
  return new SourceHttpError(url, 404, false, `GET ${url} failed with status 404`);
}

// Serves fixture text by repository-relative path; refs are single segments
// (main/HEAD) in these tests, so slice(3) drops host, owner, and repo.
function servedGet(
  served: Record<string, string>,
  calls: string[] = [],
): HttpGetter {
  return async (url) => {
    calls.push(url);
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const path = segments.slice(3).join("/");
    const text = served[path];
    if (text === undefined) throw notFound(url);
    return { text };
  };
}

function probe(raw: RawCandidate, get: HttpGetter): Promise<RawCandidate> {
  return probeGithub(raw, get, { limiter: fastLimiter() });
}

async function probeError(
  raw: RawCandidate,
  get: HttpGetter,
): Promise<GithubProbeError> {
  let caught: unknown;
  try {
    await probe(raw, get);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof GithubProbeError,
    `expected GithubProbeError, got ${String(caught)}`,
  );
  return caught;
}

test("probes SKILL.md first and records bounded skill evidence", async () => {
  const calls: string[] = [];
  const skill = fixture("SKILL.md");
  const probed = await probe(
    listing("cool-skill"),
    servedGet({ "SKILL.md": skill }, calls),
  );

  assert.deepEqual(calls, [
    "https://raw.githubusercontent.com/acme/cool-skill/main/SKILL.md",
  ]);
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.kind, "skill");
  assert.equal(evidence.sourceUrl, calls[0]);
  assert.equal(evidence.resolvedRef, "main");
  assert.equal(
    evidence.contentHash,
    createHash("sha256").update(skill).digest("hex"),
  );
  assert.equal(evidence.license, "MIT");
  assert.equal(evidence.name, "cool-skill");
  assert.equal(evidence.version, "1.0.0");
  assert.deepEqual(evidence.capabilities, []);
  assert.ok(evidence.evidenceSnippets.length >= 1);
  assert.ok(evidence.evidenceSnippets.length <= 2);
  for (const snippet of evidence.evidenceSnippets) {
    assert.ok(snippet.length <= 300);
  }
  assert.equal(evidence.evidenceSnippets[0], "name: cool-skill");
  assert.match(evidence.evidenceSnippets[1] ?? "", /^description: Builds cool MCP/);
  assert.ok(!Number.isNaN(Date.parse(evidence.retrievedAt)));
  assert.equal(probed.artifactProbed, true);
  assert.equal(probed.pinnedRef, `github:${evidence.contentHash}`);
  assert.deepEqual(probed.artifact, { kind: "skill", file: "SKILL.md" });
  assert.match(probed.description ?? "", /^Builds cool MCP/);
  assert.doesNotMatch(JSON.stringify(probed), /BODY-MARKER/);
  assert.equal(normalizeCandidate(probed).artifactType, "skill");
});

test("falls through to .claude-plugin/plugin.json and maps a plugin", async () => {
  const calls: string[] = [];
  const probed = await probe(
    listing("cool-plugin"),
    servedGet({ ".claude-plugin/plugin.json": fixture("plugin.json") }, calls),
  );

  assert.deepEqual(calls, [
    "https://raw.githubusercontent.com/acme/cool-plugin/main/SKILL.md",
    "https://raw.githubusercontent.com/acme/cool-plugin/main/.claude-plugin/plugin.json",
  ]);
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.kind, "plugin");
  assert.equal(evidence.name, "cool-plugin");
  assert.equal(evidence.version, "1.2.3");
  assert.equal(evidence.license, "MIT");
  assert.deepEqual(probed.artifact, {
    kind: "plugin",
    file: ".claude-plugin/plugin.json",
  });
  assert.equal(normalizeCandidate(probed).artifactType, "plugin");
  assert.doesNotMatch(JSON.stringify(probed), /BODY-MARKER/);
});

test("root plugin.json is accepted as a plugin manifest", async () => {
  const probed = await probe(
    listing("cool-plugin"),
    servedGet({ "plugin.json": fixture("plugin.json") }),
  );
  assert.equal(probed.artifactProbe?.kind, "plugin");
  assert.deepEqual(probed.artifact, { kind: "plugin", file: "plugin.json" });
});

test("package.json is a tool artifact and a scoped name matches the repo", async () => {
  const probed = await probe(
    listing("cool-tool"),
    servedGet({ "package.json": fixture("package.json") }),
  );
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.kind, "tool");
  assert.equal(evidence.name, "@acme/cool-tool");
  assert.equal(evidence.version, "0.4.0");
  assert.equal(evidence.license, "Apache-2.0");
  assert.deepEqual(probed.artifact, { kind: "tool", file: "package.json" });
  assert.equal(normalizeCandidate(probed).artifactType, "tool");
  assert.doesNotMatch(JSON.stringify(probed), /BODY-MARKER/);
});

test("server.json is an mcp-server and matches a reverse-DNS name", async () => {
  const probed = await probe(
    listing("cool-server"),
    servedGet({ "server.json": fixture("server.json") }),
  );
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.kind, "mcp-server");
  assert.equal(evidence.name, "io.github.acme/cool-server");
  assert.equal(evidence.version, "2.0.0");
  assert.deepEqual(probed.artifact, { kind: "mcp-server", file: "server.json" });
  assert.equal(normalizeCandidate(probed).artifactType, "mcp-server");
});

test("server.json may declare remotes instead of packages", async () => {
  const probed = await probe(
    listing("cool-server"),
    servedGet({
      "server.json": JSON.stringify({
        name: "io.github.acme/cool-server",
        version: "1.0.0",
        remotes: [{ type: "sse", url: "https://example.com/sse" }],
      }),
    }),
  );
  assert.equal(probed.artifactProbe?.kind, "mcp-server");
});

test("server.json without remotes or packages is invalid", async () => {
  const error = await probeError(
    listing("cool-server"),
    servedGet({
      "server.json": JSON.stringify({
        name: "io.github.acme/cool-server",
        version: "1.0.0",
        packages: [],
        remotes: [],
      }),
    }),
  );
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.match(error.reason, /remotes|packages/);
});

test("missing artifacts throw a typed ARTIFACT_MISSING error", async () => {
  const calls: string[] = [];
  const error = await probeError(
    listing("cool-skill"),
    servedGet({}, calls),
  );
  assert.equal(error.code, "ARTIFACT_MISSING");
  assert.equal(error.candidateId, "acme/cool-skill");
  assert.match(error.reason, /no supported artifact/i);
  assert.match(error.message, /acme\/cool-skill/);
  assert.equal(calls.length, 10, "five paths on main, then five on HEAD");
});

test("a mismatched artifact name throws ARTIFACT_MISMATCH", async () => {
  const error = await probeError(
    listing("cool-skill"),
    servedGet({
      "SKILL.md":
        "---\nname: other-skill\ndescription: Something else.\n---\n",
    }),
  );
  assert.equal(error.code, "ARTIFACT_MISMATCH");
  assert.match(error.reason, /other-skill/);
  assert.match(error.reason, /cool-skill/);
});

test("traversal in a ref or declared path is refused before any request", async () => {
  const cases: RawCandidate[] = [
    listing("cool-skill", { defaultBranch: "../../etc" }),
    listing("cool-skill", { defaultBranch: "main/../evil" }),
    listing("cool-skill", { defaultBranch: "main\\..\\evil" }),
    listing("cool-skill", {
      artifact: { kind: "plugin", file: "../../etc/passwd" },
    }),
  ];
  for (const raw of cases) {
    const calls: string[] = [];
    const error = await probeError(
      raw,
      servedGet({ "SKILL.md": fixture("SKILL.md") }, calls),
    );
    assert.equal(error.code, "ARTIFACT_INVALID");
    assert.match(error.reason, /traversal|unsafe path/i);
    assert.deepEqual(calls, []);
  }
});

test("non-GitHub repository URLs are refused before any request", async () => {
  for (const repositoryUrl of [
    "https://gitlab.com/acme/cool-skill",
    "https://raw.githubusercontent.com/acme/cool-skill/HEAD/package.json",
    "file:///etc/passwd",
    "not a url",
    "https://github.com/acme",
  ]) {
    const calls: string[] = [];
    const error = await probeError(
      listing("cool-skill", { repositoryUrl }),
      servedGet({}, calls),
    );
    assert.equal(error.code, "ARTIFACT_INVALID");
    assert.deepEqual(calls, [], `no request for ${repositoryUrl}`);
  }
});

test("a .git suffix is stripped from the repository URL", async () => {
  const calls: string[] = [];
  await probe(
    listing("cool-tool", {
      repositoryUrl: "https://github.com/acme/cool-tool.git",
    }),
    servedGet({ "package.json": fixture("package.json") }, calls),
  );
  assert.equal(
    calls[0],
    "https://raw.githubusercontent.com/acme/cool-tool/main/SKILL.md",
  );
});

test("oversized manifests throw ARTIFACT_TOO_LARGE", async () => {
  const error = await probeError(
    listing("cool-skill"),
    servedGet({ "SKILL.md": "x".repeat(MAX_MANIFEST_BYTES + 1) }),
  );
  assert.equal(error.code, "ARTIFACT_TOO_LARGE");
  assert.match(error.reason, new RegExp(String(MAX_MANIFEST_BYTES)));
  assert.doesNotMatch(error.reason, /xxxx/);
});

test("non-UTF-8 manifest bytes are rejected", async () => {
  const bytes = readFileSync(
    fileURLToPath(new URL(`${FIXTURE_DIR}/invalid-utf8.bin`, import.meta.url)),
  );
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes("\uFFFD"));
  const error = await probeError(
    listing("cool-skill"),
    servedGet({ "SKILL.md": text }),
  );
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.match(error.reason, /UTF-8/);
});

test("empty manifests are rejected", async () => {
  const error = await probeError(
    listing("cool-skill"),
    servedGet({ "SKILL.md": "  \n" }),
  );
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.match(error.reason, /empty/);
});

test("malformed manifest JSON is invalid and never echoed", async () => {
  const error = await probeError(
    listing("cool-tool"),
    servedGet({ "package.json": "{not json" }),
  );
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.match(error.reason, /not valid JSON/);
  assert.doesNotMatch(error.reason, /not json/);
});

test("falls back to HEAD when the default branch is missing", async () => {
  const calls: string[] = [];
  const probed = await probeGithub(
    listing("cool-tool"),
    async (url) => {
      calls.push(url);
      if (url.includes("/main/")) throw notFound(url);
      if (url.endsWith("/HEAD/package.json")) {
        return { text: fixture("package.json") };
      }
      throw notFound(url);
    },
    { limiter: fastLimiter() },
  );

  assert.deepEqual(calls.slice(0, 5), [
    "https://raw.githubusercontent.com/acme/cool-tool/main/SKILL.md",
    "https://raw.githubusercontent.com/acme/cool-tool/main/.claude-plugin/plugin.json",
    "https://raw.githubusercontent.com/acme/cool-tool/main/plugin.json",
    "https://raw.githubusercontent.com/acme/cool-tool/main/package.json",
    "https://raw.githubusercontent.com/acme/cool-tool/main/server.json",
  ]);
  assert.equal(
    calls[5],
    "https://raw.githubusercontent.com/acme/cool-tool/HEAD/SKILL.md",
  );
  assert.equal(
    calls[8],
    "https://raw.githubusercontent.com/acme/cool-tool/HEAD/package.json",
  );
  assert.equal(calls.length, 9, "stop at the first accepted HEAD artifact");
  assert.equal(probed.artifactProbe?.resolvedRef, "HEAD");
  assert.equal(
    probed.pinnedRef,
    `github:${probed.artifactProbe?.contentHash ?? ""}`,
  );
  assert.equal(probed.artifactProbe?.license, "Apache-2.0");
});

test("a missing default branch probes HEAD only", async () => {
  const calls: string[] = [];
  const probed = await probe(
    listing("cool-tool", { defaultBranch: undefined, license: undefined }),
    servedGet({ "package.json": fixture("package.json") }, calls),
  );
  assert.equal(
    calls[0],
    "https://raw.githubusercontent.com/acme/cool-tool/HEAD/SKILL.md",
  );
  assert.equal(probed.artifactProbe?.resolvedRef, "HEAD");
});

test("license falls back to the listing, then unknown", async () => {
  const noLicense = JSON.stringify({ name: "cool-tool", version: "1.0.0" });
  const fromListing = await probe(
    listing("cool-tool", { license: "BSD-3-Clause" }),
    servedGet({ "package.json": noLicense }),
  );
  assert.equal(fromListing.artifactProbe?.license, "BSD-3-Clause");

  const unknown = await probe(
    listing("cool-tool", { license: undefined }),
    servedGet({ "package.json": noLicense }),
  );
  assert.equal(unknown.artifactProbe?.license, "unknown");
});

test("an object license from a manifest is reduced to its type", async () => {
  const probed = await probe(
    listing("cool-tool"),
    servedGet({
      "package.json": JSON.stringify({
        name: "cool-tool",
        version: "1.0.0",
        license: { type: "MIT" },
      }),
    }),
  );
  assert.equal(probed.artifactProbe?.license, "MIT");
});

test("an exact listing id matches a differently named repo artifact", async () => {
  const probed = await probe(
    listing("unrelated-repo", { id: "acme/cool-tool" }),
    servedGet({
      "package.json": JSON.stringify({
        name: "acme/cool-tool",
        version: "1.0.0",
      }),
    }),
  );
  assert.equal(probed.artifactProbe?.name, "acme/cool-tool");
});

test("manifest bodies are never stored, only bounded snippets", async () => {
  const probed = await probe(
    listing("cool-tool"),
    servedGet({
      "package.json": JSON.stringify({
        name: "cool-tool",
        version: "1.0.0",
        description: `BODY-MARKER-description-${"x".repeat(1000)}`,
        readme: "BODY-MARKER-readme",
      }),
    }),
  );
  const serialized = JSON.stringify(probed);
  assert.doesNotMatch(serialized, /BODY-MARKER/);
  const snippets = probed.artifactProbe?.evidenceSnippets ?? [];
  assert.ok(snippets.length <= 2);
  for (const snippet of snippets) assert.ok(snippet.length <= 300);
});

test("install lifecycle hooks are recorded for the intake gate", async () => {
  const probed = await probe(
    listing("cool-tool"),
    servedGet({
      "package.json": JSON.stringify({
        name: "cool-tool",
        version: "1.0.0",
        scripts: { preinstall: "node setup.js", test: "node --test" },
      }),
    }),
  );
  assert.deepEqual(probed.installHooks, ["preinstall"]);
  const gate = probeArtifact(probed);
  assert.equal(gate.found, false);
  assert.match(gate.reason ?? "", /install hooks/);
});

test("an awesome-list record probes from its HEAD default branch", async () => {
  const raws = parseAwesomeList(
    "- [cool tool](https://github.com/acme/cool-tool)",
  );
  const raw = raws[0];
  assert.ok(raw);
  assert.equal(raw.defaultBranch, "HEAD");
  assert.equal(raw.defaultBranchFallback, true);

  const calls: string[] = [];
  const probed = await probe(
    raw,
    servedGet({ "package.json": fixture("package.json") }, calls),
  );
  assert.equal(
    calls[0],
    "https://raw.githubusercontent.com/acme/cool-tool/HEAD/SKILL.md",
  );
  assert.equal(probed.artifactProbe?.resolvedRef, "HEAD");
  assert.equal(probed.artifactProbe?.kind, "tool");
});

test("archived repositories are refused before any request", async () => {  const raws = parseGithubSearch({
    items: [
      {
        full_name: "acme/cool-skill",
        html_url: "https://github.com/acme/cool-skill",
        default_branch: "main",
        archived: true,
      },
    ],
  });
  const archived = raws[0];
  assert.ok(archived);
  assert.equal(archived.maintenance, "archived");

  const calls: string[] = [];
  const error = await probeError(archived, servedGet({}, calls));
  assert.equal(error.code, "ARTIFACT_INVALID");
  assert.match(error.reason, /archived/);
  assert.deepEqual(calls, []);
});

test("probe pacing uses the shared raw limiter for injected getters", async () => {
  const held: number[] = [];
  for (let i = 0; i < GITHUB_RAW_LIMITER.concurrency; i += 1) {
    await GITHUB_RAW_LIMITER.acquire();
    held.push(i);
  }
  const calls: string[] = [];
  const pending = probeGithub(
    listing("cool-skill"),
    servedGet({ "SKILL.md": fixture("SKILL.md") }, calls),
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], "probe must wait for the shared limiter");
  } finally {
    for (let i = 0; i < held.length; i += 1) GITHUB_RAW_LIMITER.release();
  }
  const probed = await pending;
  assert.equal(calls.length, 1);
  assert.equal(probed.artifactProbe?.kind, "skill");
});

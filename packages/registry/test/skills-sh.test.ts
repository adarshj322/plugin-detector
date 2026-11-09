import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { probeSkillsSh, SkillsShProbeError } from "../src/probe-skills-sh.js";
import type { RawCandidate } from "../src/probe.js";
import {
  DEFAULT_SKILL_QUERIES,
  fetchSkillsSh,
  SKILLS_SH_URL,
} from "../src/sources/skills-sh.js";
import type { HttpGetter } from "../src/sources/http.js";

const SEARCH_FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/registry/skills-sh-search.json", import.meta.url),
);
const DOWNLOAD_FIXTURE = fileURLToPath(
  new URL(
    "../../../../fixtures/registry/skills-sh-download.json",
    import.meta.url,
  ),
);

function searchText(): string {
  return readFileSync(SEARCH_FIXTURE, "utf8");
}

function searchPayload(): {
  skills: Array<{
    id: string;
    source: string;
    skillId: string;
    name: string;
    installs: number;
  }>;
} {
  return JSON.parse(searchText()) as ReturnType<typeof searchPayload>;
}

function downloadText(): string {
  return readFileSync(DOWNLOAD_FIXTURE, "utf8");
}

function downloadPayload(): {
  files: Array<{ path: string; contents: string }>;
  hash: string;
} {
  return JSON.parse(downloadText()) as ReturnType<typeof downloadPayload>;
}

function recordingGet(
  calls: string[],
  text: string | (() => string) = searchText(),
): HttpGetter {
  return async (url) => {
    calls.push(url);
    return { text: typeof text === "function" ? text() : text };
  };
}

function listing(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    id: "github/awesome-copilot/mcp-cli",
    name: "mcp-cli",
    artifact: {
      kind: "skill",
      file: "SKILL.md",
      artifactId: "mcp-cli",
    },
    artifactProbed: false,
    sourceKind: "community",
    pinnedRef: "0.0.0",
    license: "unknown",
    repositoryUrl: "https://github.com/github/awesome-copilot",
    ...overrides,
  };
}

function downloadWith(contents: string, hash = "a".repeat(64)): string {
  return JSON.stringify({
    files: [{ path: "SKILL.md", contents }],
    hash,
  });
}

async function probeError(
  raw: RawCandidate,
  text: string | (() => string) | Error,
): Promise<SkillsShProbeError> {
  let caught: unknown;
  try {
    await probeSkillsSh(raw, async () => {
      if (text instanceof Error) throw text;
      return { text: typeof text === "function" ? text() : text };
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SkillsShProbeError, `expected typed error, got ${caught}`);
  return caught;
}

test("skills.sh search uses the captured default query set and endpoint", async () => {
  assert.deepEqual(DEFAULT_SKILL_QUERIES, [
    "agent",
    "mcp",
    "claude",
    "testing",
    "review",
    "video",
    "design",
    "data",
    "docs",
  ]);
  assert.equal(SKILLS_SH_URL, "https://skills.sh/api/search");
  const calls: string[] = [];
  const fetch = await fetchSkillsSh({ get: recordingGet(calls) });
  assert.equal(calls.length, DEFAULT_SKILL_QUERIES.length);
  assert.deepEqual(
    calls,
    DEFAULT_SKILL_QUERIES.map((query) => `${SKILLS_SH_URL}?q=${query}`),
  );
  assert.equal(fetch.raws.length, searchPayload().skills.length);
});

test("search payload maps to community skill candidates", async () => {
  const calls: string[] = [];
  const fetch = await fetchSkillsSh({
    queries: ["mcp"],
    get: recordingGet(calls),
  });
  assert.deepEqual(calls, ["https://skills.sh/api/search?q=mcp"]);
  assert.equal(fetch.raws.length, 5);

  const cli = fetch.raws.find(
    (raw) => raw.id === "github/awesome-copilot/mcp-cli",
  );
  assert.ok(cli);
  assert.equal(cli.name, "mcp-cli");
  assert.equal(
    cli.repositoryUrl,
    "https://github.com/github/awesome-copilot",
  );
  assert.deepEqual(cli.artifact, {
    kind: "skill",
    file: "SKILL.md",
    artifactId: "mcp-cli",
  });
  assert.equal(cli.artifactProbed, false);
  assert.equal(cli.artifactProbe, undefined);
  assert.equal(cli.sourceKind, "community");
  assert.equal(cli.pinnedRef, "0.0.0");
  assert.equal(cli.license, "unknown");
  assert.equal(cli.popularity?.installs, 9669);
  assert.equal(cli.description, undefined);
  assert.equal(cli.tags, undefined);
});

test("duplicate query terms are fetched once, case- and space-insensitive", async () => {
  const calls: string[] = [];
  await fetchSkillsSh({
    queries: ["mcp", "MCP", " mcp ", ""],
    get: recordingGet(calls),
  });
  assert.deepEqual(calls, ["https://skills.sh/api/search?q=mcp"]);
});

test("merged query results dedupe by listing id", async () => {
  const calls: string[] = [];
  const fetch = await fetchSkillsSh({
    queries: ["mcp", "agent"],
    get: recordingGet(calls),
  });
  assert.equal(calls.length, 2);
  assert.equal(fetch.raws.length, searchPayload().skills.length);
  const ids = fetch.raws.map((raw) => raw.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("search caps unique candidates at 400", async () => {
  const skills = Array.from({ length: 401 }, (_, index) => ({
    id: `owner/repo/skill-${index}`,
    source: "owner/repo",
    skillId: `skill-${index}`,
    name: `skill-${index}`,
    installs: index,
  }));
  const fetch = await fetchSkillsSh({
    queries: ["mcp"],
    get: async () => ({ text: JSON.stringify({ skills }) }),
  });
  assert.equal(fetch.raws.length, 400);
  assert.equal(fetch.raws[0]?.id, "owner/repo/skill-0");
  assert.equal(fetch.raws[399]?.id, "owner/repo/skill-399");
});

test("search rejects malformed JSON and an unexpected payload shape", async () => {
  await assert.rejects(
    fetchSkillsSh({
      queries: ["mcp"],
      get: async () => ({ text: "{not json" }),
    }),
    /returned invalid JSON/,
  );
  await assert.rejects(
    fetchSkillsSh({
      queries: ["mcp"],
      get: async () => ({ text: JSON.stringify({ skills: {} }) }),
    }),
    /no skills array/,
  );
});

test("download probe records frontmatter evidence and a SHA-256 content hash", async () => {
  const fixture = downloadPayload();
  const skillMd = fixture.files[0]?.contents ?? "";
  const calls: string[] = [];
  const probed = await probeSkillsSh(listing(), async (url) => {
    calls.push(url);
    return { text: downloadText() };
  });

  assert.deepEqual(calls, [
    "https://skills.sh/api/download/github/awesome-copilot/mcp-cli",
  ]);
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.kind, "skill");
  assert.equal(evidence.sourceUrl, calls[0]);
  assert.equal(evidence.resolvedRef, `skills.sh:${fixture.hash}`);
  assert.equal(
    evidence.contentHash,
    createHash("sha256").update(skillMd).digest("hex"),
  );
  assert.equal(evidence.name, "mcp-cli");
  assert.match(probed.description ?? "", /^Interface for MCP/);
  assert.ok(
    evidence.evidenceSnippets.some((snippet) =>
      snippet.startsWith("description: Interface for MCP"),
    ),
  );
  assert.equal(evidence.license, "unknown");
  assert.deepEqual(evidence.capabilities, []);
  assert.ok(evidence.evidenceSnippets.length >= 1);
  assert.ok(evidence.evidenceSnippets.length <= 2);
  for (const snippet of evidence.evidenceSnippets) {
    assert.ok(snippet.length <= 300);
  }
  assert.ok(!Number.isNaN(Date.parse(evidence.retrievedAt)));
  assert.equal(probed.artifactProbed, true);
  assert.equal(probed.pinnedRef, evidence.resolvedRef);
});

test("frontmatter name matching ignores case and separators", async () => {
  const cases = [
    { name: "MCP Builder", artifactId: "mcp-builder" },
    { name: "mcp-builder", artifactId: "MCP_Builder" },
    { name: "MCP.Builder", artifactId: "mcp builder" },
  ];
  for (const item of cases) {
    const probed = await probeSkillsSh(
      listing({ artifact: { kind: "skill", file: "SKILL.md", artifactId: item.artifactId } }),
      async () => ({
        text: downloadWith(
          `---\nname: ${item.name}\ndescription: Builds MCP servers.\n---\n`,
        ),
      }),
    );
    assert.equal(probed.artifactProbe?.name, item.name);
  }
});

test("missing SKILL.md throws a typed ARTIFACT_MISSING error", async () => {
  const error = await probeError(
    listing(),
    JSON.stringify({
      files: [{ path: "README.md", contents: "# no skill here" }],
      hash: "b".repeat(64),
    }),
  );
  assert.equal(error.code, "ARTIFACT_MISSING");
  assert.equal(error.candidateId, "github/awesome-copilot/mcp-cli");
  assert.match(error.reason, /SKILL\.md/);
  assert.match(error.message, /github\/awesome-copilot\/mcp-cli/);
});

test("invalid or missing frontmatter throws ARTIFACT_MISSING", async () => {
  const contents = [
    "# plain markdown without frontmatter\n",
    "---\ndescription: no name here\n---\n",
    "---\nname: only-name\n---\n",
  ];
  for (const body of contents) {
    const error = await probeError(listing(), downloadWith(body));
    assert.equal(error.code, "ARTIFACT_MISSING");
    assert.match(error.reason, /frontmatter/);
  }
});

test("a mismatched frontmatter name throws ARTIFACT_MISMATCH", async () => {
  const error = await probeError(
    listing(),
    downloadWith(
      "---\nname: other-skill\ndescription: Something else.\n---\n",
    ),
  );
  assert.equal(error.code, "ARTIFACT_MISMATCH");
  assert.match(error.reason, /other-skill/);
  assert.match(error.reason, /mcp-cli/);
});

test("an exact pinned download hash overrides a name mismatch", async () => {
  const hash = "c".repeat(64);
  for (const pinnedRef of [`skills.sh:${hash}`, hash]) {
    const probed = await probeSkillsSh(
      listing({ pinnedRef }),
      async () => ({
        text: downloadWith(
          "---\nname: different-name\ndescription: Same artifact.\n---\n",
          hash,
        ),
      }),
    );
    assert.equal(probed.artifactProbe?.resolvedRef, `skills.sh:${hash}`);
    assert.equal(probed.artifactProbe?.name, "different-name");
  }
});

test("download probe failures are typed and name the candidate", async () => {
  const cases: Array<string | Error> = [
    "{not json",
    JSON.stringify({ files: [{ path: "SKILL.md", contents: "x" }] }),
    JSON.stringify({ files: "no", hash: "d".repeat(64) }),
    new Error("download unavailable"),
  ];
  for (const text of cases) {
    const error = await probeError(listing(), text);
    assert.equal(error.code, "ARTIFACT_MISSING");
    assert.equal(error.candidateId, "github/awesome-copilot/mcp-cli");
    assert.ok(error.reason.length > 0);
  }
});

test("bound snippets use only the frontmatter name and description", async () => {
  const description = `Long description ${"x".repeat(500)}`;
  const probed = await probeSkillsSh(
    listing(),
    async () => ({
      text: downloadWith(
        `---\nname: mcp-cli\ndescription: ${description}\nlicense: MIT\n---\n# Body\n`,
      ),
    }),
  );
  const evidence = probed.artifactProbe;
  assert.ok(evidence);
  assert.equal(evidence.license, "MIT");
  assert.equal(evidence.evidenceSnippets.length, 2);
  assert.ok(evidence.evidenceSnippets[0]?.startsWith("name: mcp-cli"));
  assert.ok(evidence.evidenceSnippets[1]?.startsWith("description: "));
  assert.ok((evidence.evidenceSnippets[1] ?? "").length <= 300);
});

test("a search candidate can be probed end to end", async () => {
  const fetch = await fetchSkillsSh({
    queries: ["mcp"],
    get: recordingGet([]),
  });
  const cli = fetch.raws.find(
    (raw) => raw.id === "github/awesome-copilot/mcp-cli",
  );
  assert.ok(cli);
  const probed = await probeSkillsSh(cli, async () => ({
    text: downloadText(),
  }));
  assert.equal(probed.id, cli.id);
  assert.equal(probed.artifactProbe?.name, "mcp-cli");
  assert.equal(probed.artifactProbe?.kind, "skill");
});

import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityRecord } from "@plugin-detector/core";
import {
  applyLatestVersions,
  createLatestVersionResolver,
  resolveLatestVersion,
  UPDATE_REQUESTS_PER_MINUTE,
} from "../src/updates.js";
import { SourceHttpError } from "../src/sources/http.js";
import type { RateLimiter } from "../src/sources/http.js";

const NPM_URL = "https://registry.npmjs.org/left-pad";
const SCOPED_NPM_URL = "https://registry.npmjs.org/%40acme%2Ftool";
const PYPI_URL = "https://pypi.org/pypi/acme-py-mcp/json";
const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/acme/tool/releases/latest";
const GITHUB_TAGS_URL =
  "https://api.github.com/repos/acme/tool/tags?per_page=1";

function getter(
  responses: Record<string, unknown>,
  calls: string[] = [],
): (url: string) => Promise<unknown> {
  return async (url: string) => {
    calls.push(url);
    const response = responses[url];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`unexpected URL: ${url}`);
    return response;
  };
}

test("npm dist-tags latest resolves the published version and time", async () => {
  const calls: string[] = [];
  const get = getter(
    {
      [NPM_URL]: {
        "dist-tags": { latest: "1.4.0" },
        versions: { "1.4.0": { version: "1.4.0" } },
        time: { "1.4.0": "2026-10-01T12:00:00.000Z" },
      },
    },
    calls,
  );
  const latest = await resolveLatestVersion(
    { kind: "plugin", sourceRef: "left-pad@1.2.0" },
    { get },
  );
  assert.deepEqual(latest, {
    version: "1.4.0",
    sourceUrl: NPM_URL,
    publishedAt: "2026-10-01T12:00:00.000Z",
  });
  assert.deepEqual(calls, [NPM_URL]);
});

test("scoped npm names stay one encoded path segment", async () => {
  const calls: string[] = [];
  const get = getter(
    { [SCOPED_NPM_URL]: { "dist-tags": { latest: "2.0.0" } } },
    calls,
  );
  const latest = await resolveLatestVersion(
    { kind: "mcp", packageName: "@acme/tool" },
    { get },
  );
  assert.equal(latest?.version, "2.0.0");
  assert.deepEqual(calls, [SCOPED_NPM_URL]);
});

test("explicit npm: and pypi: prefixes select the registry", async () => {
  const npmCalls: string[] = [];
  const npm = await resolveLatestVersion(
    { kind: "tool", sourceRef: "npm:left-pad" },
    { get: getter({ [NPM_URL]: { "dist-tags": { latest: "1.0.0" } } }, npmCalls) },
  );
  assert.equal(npm?.version, "1.0.0");

  const pypiCalls: string[] = [];
  const pypi = await resolveLatestVersion(
    { kind: "mcp", sourceRef: "pypi:acme-py-mcp" },
    {
      get: getter(
        {
          [PYPI_URL]: {
            info: { version: "3.1.4" },
            urls: [{ upload_time_iso_8601: "2026-09-15T08:30:00.000Z" }],
          },
        },
        pypiCalls,
      ),
    },
  );
  assert.deepEqual(pypi, {
    version: "3.1.4",
    sourceUrl: PYPI_URL,
    publishedAt: "2026-09-15T08:30:00.000Z",
  });
  assert.deepEqual(pypiCalls, [PYPI_URL]);
});

test("github: refs use the latest release", async () => {
  const calls: string[] = [];
  const get = getter(
    {
      [GITHUB_RELEASE_URL]: {
        tag_name: "v2.3.0",
        html_url: "https://github.com/acme/tool/releases/tag/v2.3.0",
        published_at: "2026-11-01T10:00:00Z",
      },
    },
    calls,
  );
  const latest = await resolveLatestVersion(
    { kind: "plugin", sourceRef: "github:acme/tool" },
    { get },
  );
  assert.deepEqual(latest, {
    version: "v2.3.0",
    sourceUrl: "https://github.com/acme/tool/releases/tag/v2.3.0",
    publishedAt: "2026-11-01T10:00:00.000Z",
  });
  assert.deepEqual(calls, [GITHUB_RELEASE_URL]);
});

test("repository URLs and git specs resolve as GitHub", async () => {
  for (const sourceRef of [
    "https://github.com/acme/tool",
    "https://www.github.com/acme/tool",
    "git+https://github.com/acme/tool.git",
    "git@github.com:acme/tool.git",
    "superpowers@git+https://github.com/acme/tool.git",
    "github:acme/tool.git",
  ]) {
    const calls: string[] = [];
    const latest = await resolveLatestVersion(
      { kind: "plugin", sourceRef },
      {
        get: getter(
          {
            [GITHUB_RELEASE_URL]: {
              tag_name: "v1.0.0",
              html_url: "https://github.com/acme/tool/releases/tag/v1.0.0",
            },
          },
          calls,
        ),
      },
    );
    assert.equal(latest?.version, "v1.0.0", sourceRef);
    assert.deepEqual(calls, [GITHUB_RELEASE_URL], sourceRef);
  }
});

test("github tags are the fallback when no release exists", async () => {
  const calls: string[] = [];
  const notFound = new SourceHttpError(
    GITHUB_RELEASE_URL,
    404,
    false,
    "not found",
  );
  const get = getter(
    {
      [GITHUB_RELEASE_URL]: notFound,
      [GITHUB_TAGS_URL]: [{ name: "v0.9.0" }, { name: "v0.8.0" }],
    },
    calls,
  );
  const latest = await resolveLatestVersion(
    { kind: "plugin", sourceRef: "github:acme/tool" },
    { get },
  );
  assert.deepEqual(latest, {
    version: "v0.9.0",
    sourceUrl: "https://github.com/acme/tool/releases/tag/v0.9.0",
  });
  assert.deepEqual(calls, [GITHUB_RELEASE_URL, GITHUB_TAGS_URL]);
});

test("repositoryUrl and an explicit package registry are accepted as hints", async () => {
  const repoLatest = await resolveLatestVersion(
    { kind: "plugin", repositoryUrl: "https://github.com/acme/tool" },
    {
      get: getter({
        [GITHUB_RELEASE_URL]: {
          tag_name: "v1.0.0",
          html_url: "https://github.com/acme/tool/releases/tag/v1.0.0",
        },
      }),
    },
  );
  assert.equal(repoLatest?.version, "v1.0.0");

  const pypiCalls: string[] = [];
  const pypi = await resolveLatestVersion(
    {
      kind: "mcp",
      packageName: "acme-py-mcp",
      packageRegistry: "pypi",
    },
    {
      get: getter(
        { [PYPI_URL]: { info: { version: "2.0.0" } } },
        pypiCalls,
      ),
    },
  );
  assert.equal(pypi?.version, "2.0.0");
  assert.deepEqual(pypiCalls, [PYPI_URL]);
});

test("missing sources, local paths, and marketplace keys resolve null offline", async () => {
  const calls: string[] = [];
  const get = getter({}, calls);
  for (const input of [
    {},
    { kind: "skill", sourceRef: "/home/me/.claude/skills/reviewer", name: "reviewer" },
    { kind: "plugin", sourceRef: "reviewer@official", name: "reviewer" },
    { kind: "plugin", sourceRef: "./local-plugin", name: "local-plugin" },
  ]) {
    assert.equal(await resolveLatestVersion(input, { get }), null);
  }
  assert.deepEqual(calls, []);
});

test("registry failures resolve null instead of failing the run", async () => {
  for (const response of [
    new Error("offline"),
    new SourceHttpError(NPM_URL, 500, true, "server error"),
    { "dist-tags": {} },
    { versions: {} },
  ]) {
    const latest = await resolveLatestVersion(
      { kind: "plugin", packageName: "left-pad" },
      { get: getter({ [NPM_URL]: response }) },
    );
    assert.equal(latest, null);
  }
  assert.equal(
    await resolveLatestVersion(
      { kind: "mcp", sourceRef: "pypi:empty" },
      { get: getter({ "https://pypi.org/pypi/empty/json": { info: {} } }) },
    ),
    null,
  );
  assert.equal(
    await resolveLatestVersion(
      { kind: "plugin", sourceRef: "github:acme/tool" },
      {
        get: getter({
          [GITHUB_RELEASE_URL]: new SourceHttpError(
            GITHUB_RELEASE_URL,
            404,
            false,
            "not found",
          ),
          [GITHUB_TAGS_URL]: [],
        }),
      },
    ),
    null,
  );
});

test("one resolver caches lookups for the whole run", async () => {
  const calls: string[] = [];
  const resolve = createLatestVersionResolver({
    get: getter(
      { [NPM_URL]: { "dist-tags": { latest: "1.0.0" } } },
      calls,
    ),
  });
  const input = { kind: "plugin", packageName: "left-pad" };
  assert.equal((await resolve(input))?.version, "1.0.0");
  assert.equal((await resolve(input))?.version, "1.0.0");
  assert.equal((await Promise.all([resolve(input), resolve(input)]))[0]?.version, "1.0.0");
  assert.deepEqual(calls, [NPM_URL]);
});

test("every request goes through the injected 60/min limiter", async () => {
  assert.equal(UPDATE_REQUESTS_PER_MINUTE, 60);
  const seen: string[] = [];
  const limiter = {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      seen.push("acquired");
      return await task();
    },
  } as unknown as RateLimiter;
  const latest = await resolveLatestVersion(
    { kind: "plugin", packageName: "left-pad" },
    {
      get: getter({ [NPM_URL]: { "dist-tags": { latest: "1.0.0" } } }),
      limiter,
    },
  );
  assert.equal(latest?.version, "1.0.0");
  assert.deepEqual(seen, ["acquired"]);
});

test("applyLatestVersions attaches latest fields and never invents a status", async () => {
  const record: CapabilityRecord = {
    id: "opencode:plugin:project:left-pad",
    name: "left-pad@1.0.0",
    harness: "opencode",
    kind: "plugin",
    capabilities: [],
    enabled: true,
    configRefs: ["/tmp/opencode.json"],
    contextCostClass: "per-session",
    sourceRef: "left-pad@1.0.0",
    updateStatus: "unknown",
  };
  const unknown: CapabilityRecord = {
    id: "opencode:skill:project:reviewer",
    name: "reviewer",
    harness: "opencode",
    kind: "skill",
    capabilities: [],
    enabled: true,
    configRefs: ["/tmp/reviewer/SKILL.md"],
    contextCostClass: "per-use",
    sourceRef: "/tmp/reviewer",
  };
  const out = await applyLatestVersions([record, unknown], async (input) =>
    input.packageName === "left-pad" || input.sourceRef === "left-pad@1.0.0"
      ? { version: "1.1.0", sourceUrl: NPM_URL }
      : null,
  );
  assert.equal(out[0]?.latestVersion, "1.1.0");
  assert.equal(out[0]?.latestSource, NPM_URL);
  assert.equal(out[0]?.updateStatus, "unknown");
  assert.equal(out[1]?.latestVersion, undefined);
  assert.equal(out[1]?.updateStatus, undefined);
});

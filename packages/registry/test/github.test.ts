import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RateLimiter } from "../src/sources/http.js";
import {
  fetchGithub,
  GITHUB_MAX_CANDIDATES,
  GITHUB_MAX_PER_QUERY,
  GITHUB_PER_PAGE,
  GITHUB_TOPIC_QUERIES,
  GITHUB_URL,
  parseGithubSearch,
} from "../src/sources/github.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../fixtures/registry/github-search.json", import.meta.url),
);

interface SearchItem {
  full_name: string;
  html_url: string;
  description?: string;
  default_branch?: string;
  stargazers_count?: number;
  pushed_at?: string;
  license?: { spdx_id?: string } | null;
}

interface SearchPayload {
  total_count: number;
  incomplete_results: boolean;
  items: SearchItem[];
}

function fixturePayload(): SearchPayload {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as SearchPayload;
}

function jsonResult(payload: unknown): { text: string } {
  return { text: JSON.stringify(payload) };
}

function queryOf(url: string): string {
  return new URL(url).searchParams.get("q") ?? "";
}

function slug(query: string): string {
  return query.replace(/[^a-z0-9-]/gi, "");
}

// Builds a page from the captured item shape: `unique` distinct repos repeated
// up to `total` items so full pages can still carry duplicate records.
function page(prefix: string, unique: number, total: number = unique): SearchPayload {
  const template = fixturePayload().items[0] as SearchItem;
  return {
    total_count: unique,
    incomplete_results: false,
    items: Array.from({ length: total }, (_, index) => {
      const name = `${prefix}-${index % unique}`;
      return {
        ...template,
        full_name: `acme/${name}`,
        html_url: `https://github.com/acme/${name}`,
      };
    }),
  };
}

function fastLimiter(): RateLimiter {
  // Tests exercise request shape, not pacing: keep the 10/min production cap out.
  return new RateLimiter();
}

test("requests all seven public topic queries with per_page=100 page 1", async () => {
  const calls: string[] = [];
  const result = await fetchGithub({
    get: async (url) => {
      calls.push(url);
      return jsonResult(page(slug(queryOf(url)), 100));
    },
    limiter: fastLimiter(),
  });

  assert.deepEqual([...GITHUB_TOPIC_QUERIES], [
    "mcp",
    "mcp-server",
    "claude-plugin",
    "claude-code-plugin",
    "opencode-plugin",
    "agent-skill",
    "llm-tools",
    "developer-tools",
    "code-review",
    "testing",
    "devops",
    "ai-coding",
    "software-engineering",
  ]);
  assert.equal(calls.length, GITHUB_TOPIC_QUERIES.length, "every default topic must be requested");
  const urls = calls.map((url) => new URL(url));
  assert.deepEqual(
    urls.map((url) => url.searchParams.get("q")),
    GITHUB_TOPIC_QUERIES.map((topic) => `topic:${topic} is:public`),
  );
  for (const url of urls) {
    assert.equal(`${url.origin}${url.pathname}`, GITHUB_URL);
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.equal(url.searchParams.get("page"), "1");
  }
  assert.equal(
    result.raws.length,
    GITHUB_TOPIC_QUERIES.length *
      Math.floor(GITHUB_MAX_CANDIDATES / GITHUB_TOPIC_QUERIES.length),
  );
  assert.ok(result.raws.length <= GITHUB_MAX_CANDIDATES);
  assert.equal(result.partial, undefined);
  assert.equal(result.failures, undefined);
});

test("paginates a full query up to the three-page cap", async () => {
  const pages: number[] = [];
  const result = await fetchGithub({
    queries: ["mcp"],
    get: async (url) => {
      pages.push(Number(new URL(url).searchParams.get("page")));
      // 100 items per page but only 60 distinct repos: the per-query budget is
      // never reached, so the page cap is what stops the scan.
      return jsonResult(page("loop", 60, GITHUB_PER_PAGE));
    },
    limiter: fastLimiter(),
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.raws.length, 60);
});

test("stops paginating when a page is not full", async () => {
  const pages: number[] = [];
  const result = await fetchGithub({
    queries: ["mcp"],
    get: async (url) => {
      pages.push(Number(new URL(url).searchParams.get("page")));
      return jsonResult(page("short", 50));
    },
    limiter: fastLimiter(),
  });

  assert.deepEqual(pages, [1]);
  assert.equal(result.raws.length, 50);
});

test("spreads the global cap across the plan; appended terms share the remainder", async () => {
  const queries = [...GITHUB_TOPIC_QUERIES, "extra-one", "extra-two"];
  const calls: string[] = [];
  const result = await fetchGithub({
    queries,
    get: async (url) => {
      calls.push(url);
      return jsonResult(page(slug(queryOf(url)), 100));
    },
    limiter: fastLimiter(),
  });

  const perQuery = Math.floor(GITHUB_MAX_CANDIDATES / queries.length);
  assert.equal(calls.length, queries.length, "every query gets a fair share");
  assert.equal(queryOf(calls[7] as string), "topic:developer-tools is:public");
  assert.equal(result.raws.length, queries.length * perQuery);
  const extraOne = slug("topic:extra-one is:public");
  assert.equal(
    result.raws.filter((raw) => raw.id?.startsWith(`acme/${extraOne}-`)).length,
    perQuery,
    "appended terms receive the same per-query budget",
  );
  assert.equal(result.partial, undefined);
});

test("parses default branch, stars, push time, license, and description", () => {
  const raws = parseGithubSearch(fixturePayload());
  assert.equal(raws.length, 3);

  const pony = raws.find((raw) => raw.id === "DietrichGebert/ponytail");
  assert.ok(pony);
  assert.equal(pony.name, "DietrichGebert/ponytail");
  assert.equal(pony.defaultBranch, "main");
  assert.equal(pony.defaultBranchFallback, undefined);
  assert.equal(pony.popularity?.stars, 187173);
  assert.equal(pony.pushedAt, "2026-10-29T11:59:31Z");
  assert.equal(pony.license, "MIT");
  assert.match(pony.description ?? "", /laziest senior dev/);
  assert.equal(pony.repositoryUrl, "https://github.com/DietrichGebert/ponytail");
  assert.equal(pony.artifactProbed, false);
  assert.equal(pony.sourceKind, "community");
  assert.equal(pony.artifact?.capabilities, undefined);
});

test("missing default_branch falls back to HEAD and is flagged", () => {
  const template = fixturePayload().items[0] as SearchItem;
  const { default_branch: _omitted, ...withoutBranch } = template;
  const raws = parseGithubSearch({
    items: [
      {
        ...withoutBranch,
        full_name: "acme/no-branch",
        html_url: "https://github.com/acme/no-branch",
        license: { spdx_id: "NOASSERTION" },
      },
      {
        full_name: "acme/no-license",
        html_url: "https://github.com/acme/no-license",
        default_branch: "trunk",
      },
    ],
  });

  assert.equal(raws.length, 2);
  const noBranch = raws[0];
  assert.ok(noBranch);
  assert.equal(noBranch.defaultBranch, "HEAD");
  assert.equal(noBranch.defaultBranchFallback, true);
  assert.equal(noBranch.license, "unknown", "NOASSERTION is not a license");

  const noLicense = raws[1];
  assert.ok(noLicense);
  assert.equal(noLicense.defaultBranch, "trunk");
  assert.equal(noLicense.defaultBranchFallback, undefined);
  assert.equal(noLicense.license, "unknown");
  assert.equal(noLicense.popularity, undefined);
});

test("sends the caller token only as an Authorization header", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify(fixturePayload()), { status: 200 });
  };
  try {
    await fetchGithub({
      queries: ["mcp"],
      token: "ghp_s3cret",
      limiter: fastLimiter(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.get("authorization"), "Bearer ghp_s3cret");
  assert.equal(seen[0]?.get("accept"), "application/vnd.github+json");
});

test("never reads GITHUB_TOKEN from the environment", async () => {
  const originalEnv = process.env.GITHUB_TOKEN;
  const originalFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = "env-secret";
  const seen: Headers[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify(fixturePayload()), { status: 200 });
  };
  try {
    await fetchGithub({ queries: ["mcp"], limiter: fastLimiter() });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalEnv;
  }

  assert.equal(seen[0]?.get("authorization"), null);
});

test("a failed query marks the harvest partial and records the failure", async () => {
  const result = await fetchGithub({
    queries: ["mcp", "claude-plugin"],
    get: async (url) => {
      if (queryOf(url) === "topic:mcp is:public") {
        throw new Error("github search rate limit exceeded");
      }
      return jsonResult(fixturePayload());
    },
    limiter: fastLimiter(),
  });

  assert.equal(result.raws.length, 3);
  assert.equal(result.partial, true);
  assert.deepEqual(result.failures, [
    { query: "mcp", error: "github search rate limit exceeded" },
  ]);
});

test("a total query failure surfaces the first error", async () => {
  await assert.rejects(
    fetchGithub({
      queries: ["mcp", "claude-plugin"],
      get: async (url) => {
        if (queryOf(url) === "topic:mcp is:public") {
          throw new Error("first failure");
        }
        throw new Error("second failure");
      },
      limiter: fastLimiter(),
    }),
    /first failure/,
  );
});

test("paces requests through the supplied limiter", async () => {
  const limiter = new RateLimiter({ concurrency: 1 });
  await limiter.acquire();
  let called = 0;
  const pending = fetchGithub({
    queries: ["mcp"],
    get: async () => {
      called += 1;
      return jsonResult(fixturePayload());
    },
    limiter,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(called, 0, "request must not start while the slot is held");
  limiter.release();
  const result = await pending;
  assert.equal(result.raws.length, 3);
});

test("malformed JSON fails only that query and marks the harvest partial", async () => {
  const result = await fetchGithub({
    queries: ["mcp", "claude-plugin"],
    get: async (url) =>
      queryOf(url) === "topic:mcp is:public"
        ? { text: "{not json" }
        : jsonResult(fixturePayload()),
    limiter: fastLimiter(),
  });

  assert.equal(result.raws.length, 3);
  assert.equal(result.partial, true);
  assert.equal(result.failures?.[0]?.query, "mcp");
  assert.match(result.failures?.[0]?.error ?? "", /returned invalid JSON/);
  assert.doesNotMatch(
    result.failures?.[0]?.error ?? "",
    /not json/,
    "the body must never be echoed",
  );
});

test("incomplete_results marks the harvest partial without discarding records", async () => {
  const payload = { ...fixturePayload(), incomplete_results: true };
  const result = await fetchGithub({
    queries: ["mcp"],
    get: async () => jsonResult(payload),
    limiter: fastLimiter(),
  });

  assert.equal(result.raws.length, 3);
  assert.equal(result.partial, true);
  assert.deepEqual(result.failures, [
    { query: "mcp", error: "incomplete results" },
  ]);
});

test("the first query wins when two queries conflict on full_name", async () => {
  const first = fixturePayload();
  const conflicting = fixturePayload();
  const cherry = conflicting.items[0] as SearchItem;
  cherry.stargazers_count = 1;
  cherry.description = "first query record";

  const result = await fetchGithub({
    queries: ["mcp", "claude-plugin"],
    get: async (url) =>
      jsonResult(
        queryOf(url) === "topic:mcp is:public" ? conflicting : first,
      ),
    limiter: fastLimiter(),
  });

  const pony = result.raws.find((raw) => raw.id === "DietrichGebert/ponytail");
  assert.ok(pony);
  assert.equal(pony.popularity?.stars, 1);
  assert.equal(pony.description, "first query record");
});

test("a payload without an items array fails the query", async () => {
  await assert.rejects(
    fetchGithub({
      queries: ["mcp"],
      get: async () => jsonResult({ unexpected: true }),
      limiter: fastLimiter(),
    }),
    /returned no items array/,
  );
});

test("a non-empty payload parsing to zero records fails the query", async () => {
  await assert.rejects(
    fetchGithub({
      queries: ["mcp"],
      get: async () => jsonResult({ items: [{ unexpected: { shape: true } }] }),
      limiter: fastLimiter(),
    }),
    /listed 1 repositories but none matched/,
  );
});

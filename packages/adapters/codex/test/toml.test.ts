import test from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../src/index.js";

test("parses tables, values, and comments", () => {
  const parsed = parseToml(`
    # leading comment
    model = "gpt-5-codex" # trailing comment
    flag = true
    count = 30
    ratio = 0.7
    name = 'literal \\n stays'

    [mcp_servers.db]
    command = "node"
    enabled = false
  `) as Record<string, unknown>;
  assert.equal(parsed["model"], "gpt-5-codex");
  assert.equal(parsed["flag"], true);
  assert.equal(parsed["count"], 30);
  assert.equal(parsed["ratio"], 0.7);
  assert.equal(parsed["name"], "literal \\n stays");
  assert.deepEqual((parsed["mcp_servers"] as Record<string, unknown>)["db"], {
    command: "node",
    enabled: false,
  });
});

test("parses table arrays, dotted keys, arrays, and inline tables", () => {
  const parsed = parseToml(`
    [[plugins]]
    name = "a"

    [[plugins]]
    name = "b"

    [mcp_servers]
    extra.enabled = false
    list = ["x", "y"]
    env = { TOKEN = "v", N = 1 }
  `) as Record<string, unknown>;
  assert.deepEqual(parsed["plugins"], [{ name: "a" }, { name: "b" }]);
  const servers = parsed["mcp_servers"] as Record<string, unknown>;
  assert.deepEqual(servers["extra"], { enabled: false });
  assert.deepEqual(servers["list"], ["x", "y"]);
  assert.deepEqual(servers["env"], { TOKEN: "v", N: 1 });
});

test("rejects malformed toml instead of guessing", () => {
  assert.throws(() => parseToml("[mcp_servers"), /TOML/);
  assert.throws(() => parseToml("key = = 1"), /TOML/);
  assert.throws(() => parseToml('bad = "unterminated'), /TOML/);
  assert.throws(() => parseToml("a = 1\na = 2"), /TOML/);
});

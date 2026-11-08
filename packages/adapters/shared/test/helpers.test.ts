import test from "node:test";
import assert from "node:assert/strict";
import {
  skillCapabilitiesFromFrontmatter,
  skillNameFromFrontmatter,
  stripJsonc,
} from "../src/index.js";

test("stripJsonc removes line and block comments outside strings", () => {
  const parsed = JSON.parse(
    stripJsonc(`{
      // a comment
      "a": 1, /* inline */ "b": "// not a comment"
    }`),
  ) as Record<string, unknown>;
  assert.deepEqual(parsed, { a: 1, b: "// not a comment" });
});

test("stripJsonc keeps escaped quotes intact", () => {
  const parsed = JSON.parse(
    stripJsonc(`{"a": "say \\"hi\\" // kept"}`),
  ) as Record<string, unknown>;
  assert.equal(parsed["a"], 'say "hi" // kept');
});

test("frontmatter name parses, malformed returns null", () => {
  assert.equal(
    skillNameFromFrontmatter('---\nname: good-skill\n---\nbody\n'),
    "good-skill",
  );
  assert.equal(skillNameFromFrontmatter("no frontmatter here"), null);
  assert.equal(skillNameFromFrontmatter('---\nname: [broken\n---\n'), null);
});

test("frontmatter capabilities map through taxonomy, absent is empty", () => {
  assert.deepEqual(
    skillCapabilitiesFromFrontmatter(
      "---\nname: x\ncapabilities: code-review.quality, e2e\n---\n",
    ),
    ["code-review.quality", "testing.e2e"],
  );
  assert.deepEqual(
    skillCapabilitiesFromFrontmatter("---\nname: x\n---\n"),
    [],
  );
  assert.equal(
    skillCapabilitiesFromFrontmatter("---\ncapabilities: [broken\n---\n"),
    null,
  );
});

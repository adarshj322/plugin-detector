import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, accessSync, constants } from "node:fs";

const TEMPLATE = new URL("../../assets/verdict-template.md", import.meta.url);
const SHIM = new URL("../../scripts/plugin-detector", import.meta.url);
const OPENAI = new URL("../../agents/openai.yaml", import.meta.url);

test("verdict template carries evidence pointers", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  assert.match(text, /evidence/i);
  assert.match(text, /sources?|provenance|last.?verified/i);
});

test("verdict template labels unverified candidates", () => {
  const text = readFileSync(TEMPLATE, "utf8");
  assert.match(text, /unverified/i);
  assert.match(text, /manual recipe|verdict/i);
});

test("shim is a POSIX sh wrapper resolving npx or the installed binary", () => {
  assert.ok(existsSync(SHIM), "scripts/plugin-detector must exist");
  accessSync(SHIM, constants.X_OK);
  const text = readFileSync(SHIM, "utf8");
  assert.match(text, /^#!\/bin\/sh/);
  assert.match(text, /npx/);
  assert.match(text, /plugin-detector/);
});

test("shim contains no install logic", () => {
  const text = readFileSync(SHIM, "utf8");
  assert.ok(!text.includes("npm install"), "shim must not install anything");
  assert.ok(
    text.split("\n").length < 30,
    "shim must stay a thin wrapper",
  );
});

test("openai.yaml declares display metadata and a default prompt", () => {
  assert.ok(existsSync(OPENAI), "agents/openai.yaml must exist");
  const text = readFileSync(OPENAI, "utf8");
  assert.match(text, /name:/);
  assert.match(text, /description:/);
  assert.match(text, /prompt|instructions:/);
});

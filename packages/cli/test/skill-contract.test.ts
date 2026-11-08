import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Resolves to packages/skill/SKILL.md both from src (ts) and dist (js).
const SKILL_MD = new URL("../../../skill/SKILL.md", import.meta.url);

function skill(): string {
  return readFileSync(SKILL_MD, "utf8");
}

test("SKILL.md states the no-write gate for read-only commands", () => {
  const text = skill();
  assert.match(text, /never writes?|no-write|read-only/i);
  assert.match(text, /inventory/);
  assert.match(text, /recommend/);
});

test("SKILL.md names all four supported v1 harnesses", () => {
  const text = skill();
  for (const harness of ["opencode", "claude-code", "codex", "cursor"]) {
    assert.ok(
      text.includes(harness),
      `SKILL.md must name harness ${harness}`,
    );
  }
});

test("SKILL.md documents the one-shot candidate+plan-scoped approval token", () => {
  const text = skill();
  assert.match(text, /approve --candidate/);
  assert.match(text, /--plan/);
  assert.match(text, /one-shot/i);
  assert.match(text, /TTL|30\s?min|10\s?min/i);
  assert.match(text, /TTY|confirmation/i);
});

test("SKILL.md forbids executing candidate code", () => {
  const text = skill();
  assert.match(text, /never execute|do not (execute|run) candidate/i);
});

test("SKILL.md forbids auto-installing unverified candidates", () => {
  const text = skill();
  assert.match(text, /never install|no .*automatic install|unverified/i);
  assert.match(
    text,
    /manual recipe|unapproved|without (explicit )?approval/i,
  );
});

test("SKILL.md requires on-demand invocation with no scheduled runs", () => {
  const text = skill();
  assert.match(text, /on demand|only when.*ask/i);
  assert.match(text, /no scheduled|cron|background/i);
});

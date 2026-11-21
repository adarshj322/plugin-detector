import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fileMtime,
  readCliVersion,
  readCliVersionAt,
  readPackageVersion,
  readSkillVersion,
} from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pd-versions-"));
}

test("package version reads package.json and ignores missing or invalid values", () => {
  const dir = tempDir();
  try {
    const manifest = path.join(dir, "package.json");
    writeFileSync(manifest, JSON.stringify({ version: "1.2.3" }));
    assert.equal(readPackageVersion(dir), "1.2.3");

    writeFileSync(manifest, JSON.stringify({ name: "no-version" }));
    assert.equal(readPackageVersion(dir), undefined);

    writeFileSync(manifest, JSON.stringify({ version: 42 }));
    assert.equal(readPackageVersion(dir), undefined);

    writeFileSync(manifest, "{ not json");
    assert.equal(readPackageVersion(dir), undefined);
    assert.equal(readPackageVersion(path.join(dir, "missing")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill version reads an optional plain frontmatter scalar", () => {
  assert.equal(
    readSkillVersion("---\nname: x\nversion: 2.4.0\n---\nbody\n"),
    "2.4.0",
  );
  assert.equal(readSkillVersion('---\nversion: "1.0.0"\n---\n'), "1.0.0");
  assert.equal(readSkillVersion("---\nname: x\n---\n"), undefined);
  assert.equal(readSkillVersion("no frontmatter here"), undefined);
  assert.equal(readSkillVersion("---\nversion: [1.0.0]\n---\n"), undefined);
});

test("file mtime returns an ISO timestamp and undefined when missing", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "artifact.md");
    writeFileSync(file, "content");
    const mtime = fileMtime(file);
    assert.ok(mtime);
    assert.equal(Number.isNaN(Date.parse(mtime)), false);
    assert.equal(fileMtime(path.join(dir, "missing")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli version probes --version without a shell and parses the first version token", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { timeout: number; shell: boolean };
  }> = [];
  const probe = (
    command: string,
    args: string[],
    options: { timeout: number; shell: boolean },
  ) => {
    calls.push({ command, args, options });
    return { stdout: "tool version 1.0.0 (build 2.0.0)\n", stderr: "" };
  };

  assert.equal(readCliVersion("git", probe), "1.0.0");
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["--version"],
      options: { timeout: 2000, shell: false },
    },
  ]);
});

test("cli version accepts real two-part forms and rejects arbitrary dotted text", () => {
  const output = (text: string) => () => ({ stdout: text, stderr: "" });

  assert.equal(readCliVersion("jq", output("jq-1.7\n")), "1.7");
  assert.equal(readCliVersion("git", output("git version 2.43\n")), "2.43");
  assert.equal(readCliVersion("node", output("v22.1.0\n")), "22.1.0");
  assert.equal(readCliVersion("ffmpeg", output("ffmpeg 6.1.1\n")), "6.1.1");

  assert.equal(readCliVersion("jq", output("build 42, no version\n")), undefined);
  assert.equal(readCliVersion("jq", output("commit abc1.2.3\n")), undefined);
  assert.equal(readCliVersion("jq", output("version 1.2.3.4\n")), undefined);
});

test("cli version at a resolved path probes that path, not a second PATH lookup", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { timeout: number; shell: boolean };
  }> = [];
  const probe = (
    command: string,
    args: string[],
    options: { timeout: number; shell: boolean },
  ) => {
    calls.push({ command, args, options });
    return { stdout: "git version 2.43\n", stderr: "" };
  };

  assert.equal(readCliVersionAt("git", "/opt/tools/git", probe), "2.43");
  assert.deepEqual(calls, [
    {
      command: "/opt/tools/git",
      args: ["--version"],
      options: { timeout: 2000, shell: false },
    },
  ]);

  assert.equal(readCliVersionAt("/tmp/pwned", "/tmp/pwned", probe), undefined);
  assert.equal(readCliVersionAt("git", "/tmp/pwned", probe), undefined);
  assert.equal(calls.length, 1);
});

test("cli version reads stderr and treats failure or empty output as unknown", () => {
  const stderrProbe = () => ({
    stdout: "",
    stderr: "Kubernetes v1.29.1\n",
  });
  assert.equal(readCliVersion("kubectl", stderrProbe), "1.29.1");

  const failing = () => {
    throw new Error("ETIMEDOUT");
  };
  assert.equal(readCliVersion("jq", failing), undefined);

  const empty = () => ({ stdout: "", stderr: "" });
  assert.equal(readCliVersion("jq", empty), undefined);
});

test("cli version never runs uncurated commands or a shell interpolation", () => {
  let called = false;
  const probe = () => {
    called = true;
    return { stdout: "9.9.9", stderr: "" };
  };

  assert.equal(readCliVersion("sh -c touch /tmp/pwned", probe), undefined);
  assert.equal(readCliVersion("git; rm -rf /", probe), undefined);
  assert.equal(readCliVersion("/tmp/pwned", probe), undefined);
  assert.equal(called, false);
});

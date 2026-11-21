import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CANONICAL_CAPABILITY_IDS } from "@plugin-detector/core";
import {
  CURATED_CLI_COMMANDS,
  CURATED_CLI_NAMES,
  detectExternalTools,
} from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pd-external-"));
}

// Stands in for an installed binary: the detector only checks the execute bit.
function stubBinary(dir: string, name: string, executable = true): string {
  const file = path.join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

test("detects curated tools with PATH evidence and parsed versions", () => {
  const dir = tempDir();
  try {
    const git = stubBinary(dir, "git");
    const gh = stubBinary(dir, "gh");
    const probed: Array<[string, string]> = [];
    const records = detectExternalTools({
      path: dir,
      readVersion: (command, installPath) => {
        probed.push([command, installPath]);
        return command === "git" ? "2.43.0" : undefined;
      },
    });

    assert.deepEqual(
      records.map((record) => record.name),
      ["git", "gh"],
    );
    assert.deepEqual(probed, [
      ["git", git],
      ["gh", gh],
    ]);
    const gitRecord = records.find((record) => record.name === "git");
    assert.ok(gitRecord);
    assert.deepEqual(gitRecord, {
      id: "external:cli:git",
      name: "git",
      harness: "unknown",
      kind: "cli",
      capabilities: ["vcs.workflow"],
      enabled: true,
      configRefs: [],
      contextCostClass: "zero",
      version: "2.43.0",
      sourceRef: "PATH:git",
      installPath: git,
    });
    const ghRecord = records.find((record) => record.name === "gh");
    assert.equal(ghRecord?.installPath, gh);
    assert.equal("version" in (ghRecord ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("omits missing, non-executable, and directory entries", () => {
  const dir = tempDir();
  try {
    stubBinary(dir, "jq", false);
    mkdirSync(path.join(dir, "docker"));
    const probed: string[] = [];
    const records = detectExternalTools({
      path: dir,
      readVersion: (command) => {
        probed.push(command);
        return "9.9.9";
      },
    });
    assert.deepEqual(records, []);
    assert.deepEqual(probed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probes only the curated names, never enumerating PATH", () => {
  const dir = tempDir();
  try {
    stubBinary(dir, "git");
    stubBinary(dir, "curl");
    stubBinary(dir, "not-a-curated-tool");
    const probed: string[] = [];
    const records = detectExternalTools({
      path: dir,
      readVersion: (command) => {
        probed.push(command);
        return "1.0.0";
      },
    });
    assert.deepEqual(
      records.map((record) => record.name),
      ["git"],
    );
    assert.deepEqual(probed, ["git"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every curated command is probed and mapped to canonical IDs", () => {
  const dir = tempDir();
  try {
    const names = [...CURATED_CLI_NAMES];
    for (const name of names) stubBinary(dir, name);
    const probed: string[] = [];
    const records = detectExternalTools({
      path: dir,
      readVersion: (command) => {
        probed.push(command);
        return "1.2.3";
      },
    });

    assert.equal(CURATED_CLI_COMMANDS.size, names.length);
    for (const name of names) assert.ok(CURATED_CLI_COMMANDS.has(name));
    assert.deepEqual(probed, names);
    assert.deepEqual(
      records.map((record) => record.name),
      names,
    );
    const canonical = new Set<string>(CANONICAL_CAPABILITY_IDS);
    for (const record of records) {
      for (const capability of record.capabilities) {
        assert.ok(
          canonical.has(capability),
          `${record.name} emitted non-canonical capability ${capability}`,
        );
      }
    }
    assert.deepEqual(
      Object.fromEntries(
        records.map((record) => [record.name, record.capabilities]),
      ),
      {
        git: ["vcs.workflow"],
        gh: ["vcs.workflow"],
        docker: ["containers.orchestration"],
        kubectl: ["containers.orchestration"],
        rg: [],
        jq: ["data.analysis"],
        playwright: ["browser.automation"],
        ffmpeg: ["media.transcode"],
        node: [],
        npm: [],
        python3: [],
        uv: [],
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default version probe executes the resolved binary, not a bare name", () => {
  const dir = tempDir();
  try {
    const git = path.join(dir, "git");
    writeFileSync(git, "#!/bin/sh\necho 'git version 2.43'\n");
    chmodSync(git, 0o755);
    const records = detectExternalTools({ path: dir });
    assert.equal(records[0]?.installPath, git);
    assert.equal(records[0]?.version, "2.43");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hostile PATH entry is matched as a literal path, not a shell command", () => {
  const base = tempDir();
  try {
    const dir = path.join(base, "bin; touch pwned");
    mkdirSync(dir);
    const git = stubBinary(dir, "git");
    const records = detectExternalTools({
      path: dir,
      readVersion: () => "2.43.0",
    });
    assert.equal(records[0]?.installPath, git);
    assert.equal(records[0]?.sourceRef, "PATH:git");
    assert.equal(records[0]?.version, "2.43.0");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

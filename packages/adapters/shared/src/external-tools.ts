import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type {
  CanonicalCapabilityId,
  CapabilityRecord,
} from "@plugin-detector/core";
import {
  CURATED_CLI_NAMES,
  readCliVersionAt,
  type CuratedCliCommand,
} from "./versions.js";

// Explicit capability map for the curated external CLIs. An empty list means
// the tool is inventoried but unclassified: language/package runtimes
// (`node`, `npm`, `python3`, `uv`) and `rg` (code search, not `search.web`)
// must not claim a capability they do not cover. Record keys are checked
// against CURATED_CLI_NAMES, so every inventoried tool has a decision here.
const CAPABILITIES_BY_TOOL: Record<
  CuratedCliCommand,
  readonly CanonicalCapabilityId[]
> = {
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
};

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

export interface ExternalToolOptions {
  // PATH value to search; injected by tests, defaults to the process PATH.
  path?: string;
  // Version probe seam; receives the resolved binary so tests can assert the
  // probe never falls back to a bare name lookup. Defaults to readCliVersionAt.
  readVersion?: (command: string, installPath: string) => string | undefined;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// which-style lookup for one known name: no directory listing, no shell.
function resolveOnPath(command: string, pathValue: string): string | undefined {
  const names =
    process.platform === "win32"
      ? [command, ...WINDOWS_EXTENSIONS.map((ext) => command + ext)]
      : [command];
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function detectExternalTools(
  options: ExternalToolOptions = {},
): CapabilityRecord[] {
  const pathValue = options.path ?? process.env["PATH"] ?? "";
  const readVersion = options.readVersion ?? readCliVersionAt;
  const records: CapabilityRecord[] = [];
  // Each probe is capped at 2s by readCliVersionAt; a fully wedged host can
  // therefore add up to 24s. `inventory --skip-external` bypasses this loop.
  for (const name of CURATED_CLI_NAMES) {
    const installPath = resolveOnPath(name, pathValue);
    if (installPath === undefined) continue;
    const version = readVersion(name, installPath);
    records.push({
      id: `external:cli:${name}`,
      name,
      harness: "unknown",
      kind: "cli",
      capabilities: [...CAPABILITIES_BY_TOOL[name]],
      enabled: true,
      configRefs: [],
      contextCostClass: "zero",
      sourceRef: `PATH:${name}`,
      installPath,
      ...(version === undefined ? {} : { version }),
    });
  }
  return records;
}

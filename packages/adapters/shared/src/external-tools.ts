import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type {
  CanonicalCapabilityId,
  CapabilityRecord,
} from "@plugin-detector/core";
import { readCliVersion } from "./versions.js";

// Curated external CLIs only. A full PATH scan would turn every unrelated
// binary into inventory noise, so the names are fixed and ordered.
const EXTERNAL_TOOLS: readonly (readonly [
  name: string,
  capabilities: readonly CanonicalCapabilityId[],
])[] = [
  ["git", ["vcs.workflow"]],
  ["gh", ["vcs.workflow"]],
  ["docker", ["containers.orchestration"]],
  ["kubectl", ["containers.orchestration"]],
  // ripgrep is code search; search.web means web search, so it stays unmapped.
  ["rg", []],
  ["jq", ["data.analysis"]],
  ["playwright", ["browser.automation"]],
  ["ffmpeg", ["media.transcode"]],
  ["node", ["harness.management"]],
  ["npm", ["harness.management"]],
  ["python3", ["data.analysis"]],
  ["uv", ["data.analysis"]],
];

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

export interface ExternalToolOptions {
  // PATH value to search; injected by tests, defaults to the process PATH.
  path?: string;
  // Version probe seam; defaults to the shared curated --version reader.
  readVersion?: (command: string) => string | undefined;
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
  const readVersion = options.readVersion ?? readCliVersion;
  const records: CapabilityRecord[] = [];
  for (const [name, capabilities] of EXTERNAL_TOOLS) {
    const installPath = resolveOnPath(name, pathValue);
    if (installPath === undefined) continue;
    const version = readVersion(name);
    records.push({
      id: `external:cli:${name}`,
      name,
      harness: "unknown",
      kind: "cli",
      capabilities: [...capabilities],
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

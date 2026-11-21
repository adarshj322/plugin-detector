import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Only curated inventory commands may be probed. Arbitrary command execution
// and whole-PATH enumeration stay out of the adapters. One list drives both
// the PATH inventory and this allowlist, so a tool cannot be inventoried
// without also being version-probed.
export const CURATED_CLI_NAMES = [
  "git",
  "gh",
  "docker",
  "kubectl",
  "rg",
  "jq",
  "playwright",
  "ffmpeg",
  "node",
  "npm",
  "python3",
  "uv",
] as const;
export type CuratedCliCommand = (typeof CURATED_CLI_NAMES)[number];
export const CURATED_CLI_COMMANDS: ReadonlySet<string> = new Set(
  CURATED_CLI_NAMES,
);

const VERSION_TIMEOUT_MS = 2000;
// First dotted token: `1.2.3`, `jq-1.7`, `git version 2.43`. Word and dot
// boundaries reject prose numbers and partial matches inside `1.2.3.4`.
const FIRST_VERSION = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?)(?!\.\d)(?!\d)/;

export interface CliVersionOptions {
  timeout: number;
  shell: false;
}

export type CliVersionProbe = (
  command: string,
  args: string[],
  options: CliVersionOptions,
) => { stdout: string; stderr: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// execFileSync never spawns a shell. On a timeout or a killed child the
// output is untrustworthy, so it reads as unknown rather than half a version.
function probeVersionCommand(
  command: string,
  args: string[],
  options: CliVersionOptions,
): { stdout: string; stderr: string } {
  try {
    return {
      stdout: execFileSync(command, args, {
        ...options,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
      stderr: "",
    };
  } catch (error) {
    if (isRecord(error) && error["signal"] !== null && error["signal"] !== undefined) {
      return { stdout: "", stderr: "" };
    }
    // A non-zero exit can still print a version; keep captured output.
    const captured = isRecord(error) ? error : {};
    return {
      stdout: typeof captured["stdout"] === "string" ? captured["stdout"] : "",
      stderr: typeof captured["stderr"] === "string" ? captured["stderr"] : "",
    };
  }
}

// Installed version from `<dir>/package.json`, or undefined when there is no
// readable manifest with a non-empty string version.
export function readPackageVersion(dir: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const version = parsed["version"];
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

// Optional plain `version:` scalar in a SKILL.md frontmatter block. A missing
// or malformed value is unknown; never inferred from dates or directory names.
export function readSkillVersion(frontmatterText: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(frontmatterText);
  if (!match?.[1]) return undefined;
  for (const line of match[1].split("\n")) {
    const value = /^\s*version\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (value === undefined) continue;
    if (/[[{\]]/.test(value)) return undefined;
    const unquoted = value.replace(/^["']|["']$/g, "");
    return unquoted.length > 0 ? unquoted : undefined;
  }
  return undefined;
}

// `metadata.homepage` from SKILL.md frontmatter. Only an http(s) URL is usable
// as a resolver source; anything else stays unknown rather than guessing.
export function readSkillHomepage(
  frontmatterText: string,
): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(frontmatterText);
  if (!match?.[1]) return undefined;
  const lines = match[1].split("\n");
  let inMetadata = false;
  let metadataIndent = 0;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    if (/^\s*metadata\s*:\s*$/.test(line)) {
      inMetadata = true;
      metadataIndent = indent;
      continue;
    }
    if (!inMetadata) continue;
    if (indent <= metadataIndent) {
      inMetadata = false;
      continue;
    }
    const value = /^\s*homepage\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (value === undefined) continue;
    const unquoted = value.replace(/^["']|["']$/g, "");
    try {
      const url = new URL(unquoted);
      return url.protocol === "http:" || url.protocol === "https:"
        ? unquoted
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// Best-effort MCP package identity from a config command. Only the documented
// `npx <package>` / `npm exec <package>` shapes count; nothing is executed.
export function readMcpPackageSource(
  command: unknown,
  args?: unknown,
): string | undefined {
  const tokens = Array.isArray(command)
    ? command.filter((token): token is string => typeof token === "string")
    : typeof command === "string"
      ? command.trim().split(/\s+/)
      : [];
  if (Array.isArray(args)) {
    tokens.push(...args.filter((token): token is string => typeof token === "string"));
  }
  if (tokens.length === 0) return undefined;
  let pkg: string | undefined;
  if (tokens[0] === "npx") {
    pkg = tokens.slice(1).find((token) => !token.startsWith("-"));
  } else if (tokens[0] === "npm" && tokens[1] === "exec") {
    pkg = tokens.slice(2).find((token) => !token.startsWith("-"));
  }
  if (pkg === undefined || pkg.startsWith("-")) return undefined;
  if (pkg.startsWith("/") || pkg.startsWith("./") || pkg.startsWith("../")) {
    return undefined;
  }
  return pkg;
}

// Local freshness evidence: the filesystem mtime as an ISO timestamp.
export function fileMtime(file: string): string | undefined {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return undefined;
  }
}

// `--version` for a curated command only, with a short timeout. The probe seam
// exists so tests never need the host toolchain installed.
export function readCliVersion(
  command: string,
  probe: CliVersionProbe = probeVersionCommand,
): string | undefined {
  if (!CURATED_CLI_COMMANDS.has(command)) return undefined;
  return probeVersion(command, probe);
}

// Same allowlist, but probes the binary inventory actually resolved instead of
// looking the name up on PATH a second time. The basename must still match the
// curated command, so this is not a general "execute any path" entry point.
export function readCliVersionAt(
  command: string,
  executablePath: string,
  probe: CliVersionProbe = probeVersionCommand,
): string | undefined {
  if (!CURATED_CLI_COMMANDS.has(command)) return undefined;
  const base = path.basename(executablePath).replace(/\.(?:exe|cmd|bat)$/i, "");
  if (base !== command) return undefined;
  return probeVersion(executablePath, probe);
}

function probeVersion(
  executable: string,
  probe: CliVersionProbe,
): string | undefined {
  let output: { stdout: string; stderr: string };
  try {
    output = probe(executable, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      shell: false,
    });
  } catch {
    return undefined;
  }
  return FIRST_VERSION.exec(`${output.stdout}\n${output.stderr}`)?.[1];
}

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Only curated inventory commands may be probed. Arbitrary command execution
// and whole-PATH enumeration stay out of the adapters.
export const CURATED_CLI_COMMANDS: ReadonlySet<string> = new Set([
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
]);

const VERSION_TIMEOUT_MS = 2000;
const FIRST_SEMVER = /\bv?(\d+\.\d+\.\d+)/;

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
  let output: { stdout: string; stderr: string };
  try {
    output = probe(command, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      shell: false,
    });
  } catch {
    return undefined;
  }
  return FIRST_SEMVER.exec(`${output.stdout}\n${output.stderr}`)?.[1];
}

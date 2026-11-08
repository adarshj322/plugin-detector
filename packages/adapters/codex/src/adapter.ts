import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  Candidate,
  CapabilityRecord,
  InstallPlan,
} from "@plugin-detector/core";
import { capabilityId } from "@plugin-detector/core";
import {
  skillCapabilitiesFromFrontmatter,
  skillNameFromFrontmatter,
  stripJsonc,
} from "@plugin-detector/adapter-shared";
import { parseToml } from "./toml.js";

export interface CodexAdapterOptions {
  // Project root holding .codex/. Defaults to cwd, or to `home` when only
  // `home` is given (fixture-friendly).
  root?: string;
  // Fakeable home for global ~/.codex config and ~/.agents skills.
  home?: string;
}

export interface DetectResult {
  harness: "codex";
  detected: boolean;
  evidence: string[];
}

export type InventoryStatus = "ok" | "partial";

export interface InventoryResult {
  harness: "codex";
  status: InventoryStatus;
  records: CapabilityRecord[];
  warnings: string[];
}

export type TrustLabel = "verified" | "curated" | "unverified";

export interface RollbackResult {
  restored: string[];
}

// v1 HarnessAdapter surface. Codex mutation is recipe-only: installPlan
// always returns manual recipes and applyPlan throws until installVerified
// flips after live verification and review (Task 13 owns writes).
export interface HarnessAdapter {
  detect(): Promise<DetectResult>;
  inventory(): Promise<InventoryResult>;
  compatibility(candidate: Candidate): number;
  installPlan(candidate: Candidate, trust?: TrustLabel): InstallPlan;
  applyPlan(plan: InstallPlan): Promise<unknown>;
  rollback(plan: InstallPlan): Promise<RollbackResult>;
}

type ContextCostClass = CapabilityRecord["contextCostClass"];

const COST_BY_KIND: Record<string, ContextCostClass> = {
  skill: "per-use",
  plugin: "per-session",
  mcp: "per-query",
};

interface ParsedConfig {
  path: string;
  scope: "project" | "global";
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CodexAdapter implements HarnessAdapter {
  // Stays false in every shipped v1 build: live Codex mutation is
  // unverified, so no plan may auto-apply. Flips only after live
  // verification and review (Task 13 owns writes).
  public readonly installVerified: boolean = false;

  private readonly root: string;
  private readonly home: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.home = options.home ?? homedir();
    this.root = options.root ?? options.home ?? process.cwd();
  }

  async detect(): Promise<DetectResult> {
    const evidence = this.evidencePaths().filter((entry) =>
      existsSync(entry),
    );
    return { harness: "codex", detected: evidence.length > 0, evidence };
  }

  async inventory(): Promise<InventoryResult> {
    const records: CapabilityRecord[] = [];
    const warnings: string[] = [];
    for (const config of this.readConfigs(warnings)) {
      this.inventoryConfig(config, records, warnings);
    }
    this.inventorySkills(records, warnings);
    return {
      harness: "codex",
      status: warnings.length > 0 ? "partial" : "ok",
      records,
      warnings,
    };
  }

  // Real 0-1 score consumed as-is by scoring: 1 for natively supported
  // artifacts with installable source evidence, 0.5 for partially supported
  // commands/hooks or missing source evidence, 0 for tools (no standalone
  // tool path in Codex v1; tools arrive via skills or MCP).
  compatibility(candidate: Candidate): number {
    let base: number;
    switch (candidate.artifactType) {
      case "skill":
      case "plugin":
      case "mcp-server":
        base = 1;
        break;
      case "command":
      case "hook":
        base = 0.5;
        break;
      default:
        return 0;
    }
    if (!candidate.repositoryUrl && !candidate.packageName) {
      base = Math.min(base, 0.5);
    }
    return Math.min(1, Math.max(0, base));
  }

  // Recipe-only: every trust level and artifact type yields manual recipes
  // with exact files/commands plus an unverified-mutation warning; nothing
  // here touches the filesystem.
  installPlan(candidate: Candidate, _trust: TrustLabel = "unverified"): InstallPlan {
    const source =
      candidate.packageName ?? candidate.repositoryUrl ?? candidate.id;
    const configFile = path.join(this.home, ".codex", "config.toml");
    let target: string;
    let how: string;
    if (candidate.artifactType === "skill") {
      target = path.join(
        this.home,
        ".agents",
        "skills",
        candidate.id,
        "SKILL.md",
      );
      how =
        `copy the skill directory for "${candidate.id}" (source ${source}) ` +
        `to ${path.dirname(target)} with "cp -r <skill-dir> ${path.dirname(target)}"`;
    } else if (candidate.artifactType === "plugin") {
      target = configFile;
      how =
        `append "${source}" to the "plugins" list in ${target} ` +
        `with an editor (no CLI installer is verified for Codex plugins)`;
    } else if (candidate.artifactType === "mcp-server") {
      target = configFile;
      how =
        `add an [mcp_servers."${candidate.id}"] table for "${candidate.id}" ` +
        `(source ${source}) to ${target} with an editor, ` +
        `e.g. command = "<server-command>" plus any required env names`;
    } else {
      target = configFile;
      how =
        `follow the candidate's documented install steps for "${candidate.name}" ` +
        `(${candidate.artifactType}) from ${source} and record the result in ${target} with an editor`;
    }
    return {
      candidateId: candidate.id,
      harness: "codex",
      operations: [
        {
          kind: "recipe",
          target,
          summary:
            `Manual install of "${candidate.name}" (${candidate.artifactType}) from ${source}: ${how}. ` +
            `Live Codex mutation is unverified; no files were changed.`,
        },
      ],
      backupRefs: [target],
      rollbackOperations: [
        {
          kind: "recipe",
          summary:
            `Remove the "${candidate.id}" entry from ${target} to restore the backed-up preimage.`,
        },
      ],
      approvalTokenRequired: true,
    };
  }

  async applyPlan(_plan: InstallPlan): Promise<never> {
    if (this.installVerified !== true) {
      throw new Error(
        "Codex live mutation is unverified: applyPlan is disabled until installVerified flips after live verification and review (Task 13 owns writes).",
      );
    }
    throw new Error(
      "Codex live mutation is unverified: no writer exists in v1 (Task 13 owns writes).",
    );
  }

  async rollback(_plan: InstallPlan): Promise<RollbackResult> {
    return { restored: [] };
  }

  private evidencePaths(): string[] {
    return [
      path.join(this.home, ".codex", "config.toml"),
      path.join(this.home, ".codex", "config.json"),
      // Credentials prove a harness install; the file is never read.
      path.join(this.home, ".codex", "auth.json"),
      path.join(this.root, ".codex", "config.toml"),
      path.join(this.root, ".codex", "config.json"),
      path.join(this.home, ".agents", "skills"),
      path.join(this.root, ".agents", "skills"),
    ];
  }

  private configPaths(): { file: string; scope: "project" | "global"; format: "toml" | "json" }[] {
    return [
      { file: path.join(this.home, ".codex", "config.toml"), scope: "global", format: "toml" },
      { file: path.join(this.home, ".codex", "config.json"), scope: "global", format: "json" },
      { file: path.join(this.root, ".codex", "config.toml"), scope: "project", format: "toml" },
      { file: path.join(this.root, ".codex", "config.json"), scope: "project", format: "json" },
    ];
  }

  private readConfigs(warnings: string[]): ParsedConfig[] {
    const configs: ParsedConfig[] = [];
    for (const { file, scope, format } of this.configPaths()) {
      if (!existsSync(file)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        warnings.push(
          `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed =
          format === "toml"
            ? (parseToml(text) as unknown)
            : (JSON.parse(stripJsonc(text)) as unknown);
      } catch (error) {
        warnings.push(
          `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!isRecord(parsed)) {
        warnings.push(`Ignoring ${file}: top-level value is not an object.`);
        continue;
      }
      configs.push({ path: file, scope, value: parsed });
    }
    return configs;
  }

  private inventoryConfig(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    this.inventoryPluginEntries(config, records, warnings);
    this.inventoryMcpEntries(config, records, warnings);
    this.inventoryUnknownSections(config, warnings);
  }

  private inventoryPluginEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const plugins = config.value["plugins"];
    if (plugins === undefined) return;
    if (!Array.isArray(plugins)) {
      warnings.push(
        `Ignoring "plugins" in ${config.path}: expected an array of package specs or tables.`,
      );
      return;
    }
    for (const entry of plugins) {
      if (typeof entry === "string") {
        if (entry.length === 0) {
          warnings.push(
            `Ignoring plugin entry in ${config.path}: expected a non-empty string.`,
          );
          continue;
        }
        records.push({
          id: `codex:plugin:${config.scope}:${entry}`,
          name: entry,
          harness: "codex",
          kind: "plugin",
          capabilities: [],
          enabled: true,
          configRefs: [config.path],
          contextCostClass: COST_BY_KIND["plugin"] as ContextCostClass,
        });
      } else if (isRecord(entry)) {
        const name = entry["name"];
        if (typeof name !== "string" || name.length === 0) {
          warnings.push(
            `Ignoring plugin entry in ${config.path}: expected a non-empty "name".`,
          );
          continue;
        }
        const version =
          typeof entry["version"] === "string" &&
          (entry["version"] as string).length > 0
            ? (entry["version"] as string)
            : null;
        records.push({
          id: `codex:plugin:${config.scope}:${name}${version ? `@${version}` : ""}`,
          name,
          harness: "codex",
          kind: "plugin",
          capabilities: [],
          enabled: entry["enabled"] !== false,
          configRefs: [config.path],
          contextCostClass: COST_BY_KIND["plugin"] as ContextCostClass,
        });
      } else {
        warnings.push(
          `Ignoring plugin entry in ${config.path}: expected a package spec string or table.`,
        );
      }
    }
  }

  // Only names and config refs are recorded; environment values stay on disk.
  private inventoryMcpEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const servers = config.value["mcp_servers"];
    if (servers === undefined) return;
    if (!isRecord(servers)) {
      warnings.push(
        `Ignoring "mcp_servers" in ${config.path}: expected a table of server entries.`,
      );
      return;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const detail = isRecord(entry) ? entry : {};
      const enabled = detail["enabled"];
      records.push({
        id: `codex:mcp:${config.scope}:${name}`,
        name,
        harness: "codex",
        kind: "mcp",
        capabilities: [],
        enabled: enabled === undefined ? true : enabled !== false,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["mcp"] as ContextCostClass,
      });
    }
  }

  // Unknown tables survive as warnings; scalar runtime prefs (model,
  // approval_policy, timeouts) are silently ignored, never inventoried.
  private inventoryUnknownSections(
    config: ParsedConfig,
    warnings: string[],
  ): void {
    for (const [key, value] of Object.entries(config.value)) {
      if (key === "plugins" || key === "mcp_servers") continue;
      const isSection =
        isRecord(value) ||
        (Array.isArray(value) &&
          value.length > 0 &&
          value.every((el) => isRecord(el)));
      if (isSection) {
        warnings.push(
          `Unknown section "${key}" in ${config.path}; ignored for inventory.`,
        );
      }
    }
  }

  private inventorySkills(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    this.inventorySkillRoot(
      path.join(this.home, ".agents", "skills"),
      "global",
      records,
      warnings,
    );
    this.inventorySkillRoot(
      path.join(this.root, ".agents", "skills"),
      "project",
      records,
      warnings,
    );
  }

  private inventorySkillRoot(
    skillRoot: string,
    scope: "project" | "global",
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(skillRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      const skillFile = path.join(skillRoot, entry, "SKILL.md");
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(skillFile);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let text: string;
      try {
        text = readFileSync(skillFile, "utf8");
      } catch (error) {
        warnings.push(
          `Cannot read ${skillFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      const name = skillNameFromFrontmatter(text);
      const capabilities = skillCapabilitiesFromFrontmatter(text);
      if (name === null || capabilities === null) {
        warnings.push(`Malformed frontmatter in ${skillFile}; kept by directory name.`);
      }
      const mapped = capabilities ?? [];
      const fromName = capabilityId(entry);
      records.push({
        id: `codex:skill:${scope}:${entry}`,
        name: name ?? entry,
        harness: "codex",
        kind: "skill",
        capabilities: fromName && !mapped.includes(fromName) ? [...mapped, fromName] : mapped,
        enabled: true,
        configRefs: [skillFile],
        contextCostClass: COST_BY_KIND["skill"] as ContextCostClass,
      });
    }
  }
}

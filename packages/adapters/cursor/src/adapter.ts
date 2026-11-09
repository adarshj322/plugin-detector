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

export interface CursorAdapterOptions {
  // Project root holding .cursor/. Defaults to cwd, or to `home` when only
  // `home` is given (fixture-friendly).
  root?: string;
  // Fakeable home for user-scope ~/.cursor/mcp.json and skills.
  home?: string;
}

export interface DetectResult {
  harness: "cursor";
  detected: boolean;
  evidence: string[];
}

export type InventoryStatus = "ok" | "partial";

export interface InventoryResult {
  harness: "cursor";
  status: InventoryStatus;
  records: CapabilityRecord[];
  warnings: string[];
}

export type TrustLabel = "verified" | "curated" | "unverified";

// How the candidate maps onto documented Cursor support: MCP servers are
// documented, everything else is inferred from adjacent support (skills,
// rules, commands) or unknown (no Cursor path at all). Inferred and unknown
// can never become verified-install paths: every installPlan is a manual
// recipe regardless of basis.
export type CompatibilityBasis = "documented" | "inferred" | "unknown";

export interface RollbackResult {
  restored: string[];
}

// v1 HarnessAdapter surface. Cursor mutation is recipe-only: installPlan
// always returns manual recipes and applyPlan throws until installVerified
// flips after live verification and review (Task 13 owns writes).
export interface HarnessAdapter {
  detect(): Promise<DetectResult>;
  inventory(): Promise<InventoryResult>;
  compatibility(candidate: Candidate): number;
  compatibilityBasis(candidate: Candidate): CompatibilityBasis;
  installPlan(candidate: Candidate, trust?: TrustLabel): InstallPlan;
  applyPlan(plan: InstallPlan): Promise<unknown>;
  rollback(plan: InstallPlan): Promise<RollbackResult>;
}

type ContextCostClass = CapabilityRecord["contextCostClass"];

const COST_BY_KIND: Record<string, ContextCostClass> = {
  skill: "per-use",
  rule: "per-session",
  command: "zero",
  mcp: "per-query",
};

const DOCUMENTED_TYPES = new Set(["mcp-server"]);
const INFERRED_TYPES = new Set(["skill", "plugin", "command", "hook"]);

interface ParsedConfig {
  path: string;
  scope: "project" | "user";
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CursorAdapter implements HarnessAdapter {
  // Stays false in every shipped v1 build: live Cursor mutation is
  // unverified, so no plan may auto-apply. Flips only after live
  // verification and review (Task 13 owns writes).
  public readonly installVerified: boolean = false;

  private readonly root: string;
  private readonly home: string;

  constructor(options: CursorAdapterOptions = {}) {
    this.home = options.home ?? homedir();
    this.root = options.root ?? options.home ?? process.cwd();
  }

  async detect(): Promise<DetectResult> {
    const evidence = this.evidencePaths().filter((entry) =>
      existsSync(entry),
    );
    return { harness: "cursor", detected: evidence.length > 0, evidence };
  }

  async inventory(): Promise<InventoryResult> {
    const records: CapabilityRecord[] = [];
    const warnings: string[] = [];
    for (const config of this.readConfigs(warnings)) {
      this.inventoryMcpEntries(config, records, warnings);
      this.inventoryUnknownSections(config, warnings);
    }
    this.inventorySkills(records, warnings);
    this.inventoryRules(records, warnings);
    this.inventoryCommands(records, warnings);
    return {
      harness: "cursor",
      status: warnings.length > 0 ? "partial" : "ok",
      records,
      warnings,
    };
  }

  // Documented support (MCP servers) scores 1 with installable source
  // evidence; inferred types (skills, plugins, commands, hooks) cap at 0.5
  // so scoring can never treat them as natively verified; unknown types
  // (tools) score 0. Missing source evidence caps at 0.5 either way.
  compatibilityBasis(candidate: Candidate): CompatibilityBasis {
    if (DOCUMENTED_TYPES.has(candidate.artifactType)) return "documented";
    if (INFERRED_TYPES.has(candidate.artifactType)) return "inferred";
    return "unknown";
  }

  // Real 0-1 score consumed as-is by scoring.
  compatibility(candidate: Candidate): number {
    const basis = this.compatibilityBasis(candidate);
    let base: number;
    if (basis === "documented") {
      base = 1;
    } else if (basis === "inferred") {
      base = 0.5;
    } else {
      return 0;
    }
    if (!candidate.repositoryUrl && !candidate.packageName) {
      base = Math.min(base, 0.5);
    }
    return Math.min(1, Math.max(0, base));
  }

  // Recipe-only: every trust level and artifact type yields manual recipes
  // with exact files/commands plus the Cursor experimental label and the
  // compatibility basis; nothing here touches the filesystem.
  installPlan(candidate: Candidate, _trust: TrustLabel = "unverified"): InstallPlan {
    const source =
      candidate.packageName ?? candidate.repositoryUrl ?? candidate.id;
    const basis = this.compatibilityBasis(candidate);
    let target: string;
    let how: string;
    if (candidate.artifactType === "mcp-server") {
      target = path.join(this.root, ".cursor", "mcp.json");
      how =
        `add an "${candidate.id}" entry for "${candidate.name}" (source ${source}) ` +
        `to the "mcpServers" object in ${target} with an editor, ` +
        `e.g. { "command": "<server-command>" } plus any required env names`;
    } else if (candidate.artifactType === "skill") {
      target = path.join(
        this.root,
        ".cursor",
        "skills",
        candidate.id,
        "SKILL.md",
      );
      how =
        `copy the skill directory for "${candidate.id}" (source ${source}) ` +
        `to ${path.dirname(target)} with "cp -r <skill-dir> ${path.dirname(target)}"`;
    } else if (candidate.artifactType === "command") {
      target = path.join(this.root, ".cursor", "commands", `${candidate.id}.md`);
      how =
        `create ${target} for "${candidate.id}" (source ${source}) with an editor, ` +
        `following the candidate's documented slash-command content`;
    } else {
      target = path.join(this.root, ".cursor", "rules", `${candidate.id}.mdc`);
      how =
        `follow the candidate's documented install steps for "${candidate.name}" ` +
        `(${candidate.artifactType}) from ${source} and record the result in ${target} with an editor`;
    }
    return {
      candidateId: candidate.id,
      harness: "cursor",
      operations: [
        {
          kind: "recipe",
          target,
          summary:
            `Manual install of "${candidate.name}" (${candidate.artifactType}) from ${source}: ${how}. ` +
            `Cursor compatibility: ${basis}; Cursor MCP/rules support is experimental. ` +
            `Live Cursor mutation is unverified; no files were changed.`,
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
        "Cursor live mutation is unverified: applyPlan is disabled until installVerified flips after live verification and review (Task 13 owns writes).",
      );
    }
    throw new Error(
      "Cursor live mutation is unverified: no writer exists in v1 (Task 13 owns writes).",
    );
  }

  async rollback(_plan: InstallPlan): Promise<RollbackResult> {
    return { restored: [] };
  }

  private evidencePaths(): string[] {
    return [
      path.join(this.home, ".cursor", "mcp.json"),
      path.join(this.root, ".cursor", "mcp.json"),
      path.join(this.root, ".cursorrules"),
      path.join(this.home, ".cursor"),
      path.join(this.root, ".cursor"),
      path.join(this.root, ".cursor", "rules"),
      path.join(this.root, ".cursor", "commands"),
    ];
  }

  private configPaths(): { file: string; scope: "project" | "user" }[] {
    return [
      { file: path.join(this.home, ".cursor", "mcp.json"), scope: "user" },
      { file: path.join(this.root, ".cursor", "mcp.json"), scope: "project" },
    ];
  }

  private readConfigs(warnings: string[]): ParsedConfig[] {
    const configs: ParsedConfig[] = [];
    for (const { file, scope } of this.configPaths()) {
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
        parsed = JSON.parse(stripJsonc(text)) as unknown;
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

  // Only names and config refs are recorded; environment values stay on disk.
  private inventoryMcpEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const servers = config.value["mcpServers"];
    if (servers === undefined) return;
    if (!isRecord(servers)) {
      warnings.push(
        `Ignoring "mcpServers" in ${config.path}: expected an object of server entries.`,
      );
      return;
    }
    for (const [name, entry] of Object.entries(servers)) {
      const detail = isRecord(entry) ? entry : {};
      const enabled = detail["enabled"];
      records.push({
        id: `cursor:mcp:${config.scope}:${name}`,
        name,
        harness: "cursor",
        kind: "mcp",
        capabilities: [],
        enabled: enabled === undefined ? true : enabled !== false,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["mcp"] as ContextCostClass,
      });
    }
  }

  // Unknown tables survive as warnings; scalar prefs are silently ignored,
  // never inventoried.
  private inventoryUnknownSections(
    config: ParsedConfig,
    warnings: string[],
  ): void {
    for (const [key, value] of Object.entries(config.value)) {
      if (key === "mcpServers") continue;
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
      path.join(this.home, ".cursor", "skills"),
      "user",
      records,
      warnings,
    );
    this.inventorySkillRoot(
      path.join(this.root, ".cursor", "skills"),
      "project",
      records,
      warnings,
    );
  }

  private inventorySkillRoot(
    skillRoot: string,
    scope: "project" | "user",
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
        id: `cursor:skill:${scope}:${entry}`,
        name: name ?? entry,
        harness: "cursor",
        kind: "skill",
        capabilities: fromName && !mapped.includes(fromName) ? [...mapped, fromName] : mapped,
        enabled: true,
        configRefs: [skillFile],
        contextCostClass: COST_BY_KIND["skill"] as ContextCostClass,
      });
    }
  }

  // Rules are listed by file name only; bodies and globs stay on disk.
  private inventoryRules(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const rulesDir = path.join(this.root, ".cursor", "rules");
    let entries: string[];
    try {
      entries = readdirSync(rulesDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".mdc")) continue;
      const full = path.join(rulesDir, entry);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        warnings.push(`Cannot stat ${full}; skipped.`);
        continue;
      }
      const base = path.basename(entry, ".mdc");
      const mapped = capabilityId(base);
      records.push({
        id: `cursor:rule:project:${base}`,
        name: base,
        harness: "cursor",
        kind: "rule",
        capabilities: mapped ? [mapped] : [],
        enabled: true,
        configRefs: [full],
        contextCostClass: COST_BY_KIND["rule"] as ContextCostClass,
      });
    }
    const legacy = path.join(this.root, ".cursorrules");
    if (existsSync(legacy)) {
      records.push({
        id: "cursor:rule:project:cursorrules",
        name: ".cursorrules",
        harness: "cursor",
        kind: "rule",
        capabilities: [],
        enabled: true,
        configRefs: [legacy],
        contextCostClass: COST_BY_KIND["rule"] as ContextCostClass,
      });
    }
  }

  // Slash commands are listed by file name only; bodies are never executed.
  private inventoryCommands(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const commandDir = path.join(this.root, ".cursor", "commands");
    let entries: string[];
    try {
      entries = readdirSync(commandDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = path.join(commandDir, entry);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        warnings.push(`Cannot stat ${full}; skipped.`);
        continue;
      }
      const base = path.basename(entry, ".md");
      const mapped = capabilityId(base);
      records.push({
        id: `cursor:command:project:${base}`,
        name: base,
        harness: "cursor",
        kind: "command",
        capabilities: mapped ? [mapped] : [],
        enabled: true,
        configRefs: [full],
        contextCostClass: COST_BY_KIND["command"] as ContextCostClass,
      });
    }
  }
}

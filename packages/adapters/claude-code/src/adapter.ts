import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  Candidate,
  CapabilityRecord,
  InstallPlan,
} from "@plugin-detector/core";
import { capabilityId } from "@plugin-detector/core";
import { stripJsonc } from "./jsonc.js";

export interface ClaudeCodeAdapterOptions {
  // Project root holding .claude/ and .mcp.json. Defaults to cwd, or to
  // `home` when only `home` is given (fixture-friendly).
  root?: string;
  // Fakeable home holding .claude.json and user-scope .claude/.
  home?: string;
}

export interface DetectResult {
  harness: "claude-code";
  detected: boolean;
  evidence: string[];
}

export type InventoryStatus = "ok" | "partial";

export interface InventoryResult {
  harness: "claude-code";
  status: InventoryStatus;
  records: CapabilityRecord[];
  warnings: string[];
}

export type TrustLabel = "verified" | "curated" | "unverified";

export interface RollbackResult {
  restored: string[];
}

// v1 HarnessAdapter surface. Task 13 owns applyPlan/rollback writes; until
// then applyPlan throws and rollback restores the (empty) nothing written.
export interface HarnessAdapter {
  detect(): Promise<DetectResult>;
  inventory(): Promise<InventoryResult>;
  compatibility(candidate: Candidate): number;
  installPlan(candidate: Candidate, trust?: TrustLabel): InstallPlan;
  applyPlan(plan: InstallPlan): Promise<unknown>;
  rollback(plan: InstallPlan): Promise<RollbackResult>;
}

type ContextCostClass = CapabilityRecord["contextCostClass"];

// One cost class per component kind: skills stream per use, MCP context
// arrives per query, hooks/agents/plugins persist per session, commands only
// cost what the model already spent reading them.
const COST_BY_KIND: Record<string, ContextCostClass> = {
  skill: "per-use",
  command: "zero",
  mcp: "per-query",
  hook: "per-session",
  agent: "per-session",
  plugin: "per-session",
};

// Mutable refs are pointers, never pins (mirrors core schema's MUTABLE_REFS;
// a candidate is installable only with a tag, version, or digest).
const MUTABLE_REFS = new Set([
  "main",
  "master",
  "mainline",
  "trunk",
  "latest",
  "stable",
  "head",
]);

// Compatibility for an unpinned candidate caps here, below every
// automatic-install threshold, so scoring can never auto-install it.
const UNPINNED_COMPATIBILITY_CAP = 0.4;

interface ParsedConfig {
  path: string;
  scope: "project" | "local" | "user";
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillNameFromFrontmatter(text: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return null;
  const body = match[1];
  for (const line of body.split("\n")) {
    const name = /^\s*name\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (name && !/[[{\]]/.test(name)) return name.replace(/^["']|["']$/g, "");
    if (name) return null;
  }
  return null;
}

function skillCapabilitiesFromFrontmatter(text: string): string[] | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) return null;
  for (const line of match[1].split("\n")) {
    const raw = /^\s*capabilities\s*:\s*(.+?)\s*$/.exec(line)?.[1];
    if (raw === undefined) continue;
    if (/[[{\]]/.test(raw)) return null;
    const out: string[] = [];
    for (const part of raw.split(",")) {
      const mapped = capabilityId(part.trim());
      if (mapped) out.push(mapped);
    }
    return out;
  }
  return [];
}

function hasPinnedRef(ref: unknown): boolean {
  if (typeof ref !== "string" || ref.trim().length === 0) return false;
  return !MUTABLE_REFS.has(ref.trim().toLowerCase());
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly root: string;
  private readonly home: string;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.home = options.home ?? homedir();
    this.root = options.root ?? options.home ?? process.cwd();
  }

  async detect(): Promise<DetectResult> {
    const evidence = this.evidencePaths().filter((entry) =>
      existsSync(entry),
    );
    return { harness: "claude-code", detected: evidence.length > 0, evidence };
  }

  async inventory(): Promise<InventoryResult> {
    const records: CapabilityRecord[] = [];
    const warnings: string[] = [];
    const globalConfig = this.readGlobalConfig(warnings);
    if (globalConfig) this.inventoryPlugins(globalConfig, records, warnings);
    if (globalConfig) this.inventoryGlobalMcp(globalConfig, records, warnings);
    this.inventoryProjectMcp(records, warnings);
    for (const settings of this.readSettings(warnings)) {
      this.inventoryHooks(settings, records, warnings);
    }
    this.inventoryArtifacts(records, warnings);
    return {
      harness: "claude-code",
      status: warnings.length > 0 ? "partial" : "ok",
      records,
      warnings,
    };
  }

  // Real 0-1 score consumed as-is by scoring: 1 for natively supported
  // artifacts with installable source evidence, 0.7 for commands and hooks
  // (runnable but not package-installable), 0 for tools. Provenance never
  // lowers compatibility — unverified third-party trust is decided by the
  // trust classifier and installPlan, not here. A missing or mutable
  // pinnedRef caps the score below automatic-install thresholds.
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
        base = 0.7;
        break;
      default:
        return 0;
    }
    if (!candidate.repositoryUrl && !candidate.packageName) {
      base = Math.min(base, 0.5);
    }
    if (!hasPinnedRef(candidate.pinnedRef)) {
      base = Math.min(base, UNPINNED_COMPATIBILITY_CAP);
    }
    return Math.min(1, Math.max(0, base));
  }

  // Verified + supported type yields a harness-native plan (skills into the
  // user skills dir, plugins via enabledPlugins in ~/.claude.json, MCP
  // servers via project .mcp.json). Anything else yields a manual recipe;
  // nothing here touches the filesystem.
  installPlan(candidate: Candidate, trust: TrustLabel = "unverified"): InstallPlan {
    const source =
      candidate.packageName ?? candidate.repositoryUrl ?? candidate.id;
    const supported =
      candidate.artifactType === "skill" ||
      candidate.artifactType === "plugin" ||
      candidate.artifactType === "mcp-server";
    const backupRefs: string[] = [];
    let operations: InstallPlan["operations"];
    let rollbackOperations: InstallPlan["rollbackOperations"];
    if (trust === "verified" && supported) {
      const claudeJson = path.join(this.home, ".claude.json");
      if (candidate.artifactType === "skill") {
        const dest = path.join(this.home, ".claude", "skills");
        backupRefs.push(dest);
        operations = [
          {
            kind: "run",
            summary: `npx skills add ${source} (installs into ${dest})`,
          },
        ];
        rollbackOperations = [
          {
            kind: "recipe",
            summary: `Remove the installed skill directory for "${candidate.id}" under ${dest}.`,
          },
        ];
      } else if (candidate.artifactType === "plugin") {
        backupRefs.push(claudeJson);
        operations = [
          {
            kind: "append",
            target: claudeJson,
            summary: `Append "${source}" to the "enabledPlugins" map in ${claudeJson}.`,
          },
        ];
        rollbackOperations = [
          {
            kind: "recipe",
            summary: `Remove "${source}" from the "enabledPlugins" map in ${claudeJson} to restore the backed-up preimage.`,
          },
        ];
      } else {
        const mcpJson = path.join(this.root, ".mcp.json");
        backupRefs.push(mcpJson);
        operations = [
          {
            kind: "write",
            target: mcpJson,
            summary:
              `Merge MCP server "${candidate.id}" (source ${source}) into the "mcpServers" object in ${mcpJson}.`,
          },
        ];
        rollbackOperations = [
          {
            kind: "recipe",
            summary:
              `Remove the "${candidate.id}" entry from the "mcpServers" object in ${mcpJson} to restore the backed-up preimage.`,
          },
        ];
      }
    } else {
      const reason = supported
        ? `trust is "${trust}", not verified`
        : `artifact type "${candidate.artifactType}" has no harness-native installer`;
      operations = [
        {
          kind: "recipe",
          summary:
            `Manual install of "${candidate.name}" (${candidate.artifactType}) from ${source}: ${reason}. ` +
            `No files were changed; follow the candidate's documented install steps for Claude Code.`,
        },
      ];
      rollbackOperations = [];
    }
    return {
      candidateId: candidate.id,
      harness: "claude-code",
      operations,
      backupRefs,
      rollbackOperations,
      approvalTokenRequired: true,
    };
  }

  async applyPlan(_plan: InstallPlan): Promise<never> {
    throw new Error("Inventory-only milestone: applyPlan lands in Task 13.");
  }

  async rollback(_plan: InstallPlan): Promise<RollbackResult> {
    return { restored: [] };
  }

  private evidencePaths(): string[] {
    return [
      path.join(this.home, ".claude.json"),
      path.join(this.home, ".claude"),
      path.join(this.home, ".claude", "settings.json"),
      path.join(this.root, ".claude"),
      path.join(this.root, ".claude", "settings.json"),
      path.join(this.root, ".claude", "settings.local.json"),
      path.join(this.root, ".mcp.json"),
    ];
  }

  private readJsonFile(
    file: string,
    warnings: string[],
  ): Record<string, unknown> | null {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      warnings.push(
        `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(text)) as unknown;
    } catch (error) {
      warnings.push(
        `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (!isRecord(parsed)) {
      warnings.push(`Ignoring ${file}: top-level value is not an object.`);
      return null;
    }
    return parsed;
  }

  private readGlobalConfig(warnings: string[]): ParsedConfig | null {
    const file = path.join(this.home, ".claude.json");
    if (!existsSync(file)) return null;
    const value = this.readJsonFile(file, warnings);
    return value ? { path: file, scope: "user", value } : null;
  }

  private settingsPaths(): { file: string; scope: "project" | "local" | "user" }[] {
    return [
      { file: path.join(this.root, ".claude", "settings.json"), scope: "project" },
      { file: path.join(this.root, ".claude", "settings.local.json"), scope: "local" },
      { file: path.join(this.home, ".claude", "settings.json"), scope: "user" },
    ];
  }

  private readSettings(warnings: string[]): ParsedConfig[] {
    const settings: ParsedConfig[] = [];
    for (const { file, scope } of this.settingsPaths()) {
      if (!existsSync(file)) continue;
      const value = this.readJsonFile(file, warnings);
      if (value) settings.push({ path: file, scope, value });
    }
    return settings;
  }

  // Plugins merge installedPlugins metadata (marketplace source, pinned
  // version, scope) with the enabledPlugins on/off switch. Missing fields
  // stay "unknown" in the id; only unusable entries warn and skip.
  private inventoryPlugins(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const installed = config.value["installedPlugins"];
    const enabledMap = config.value["enabledPlugins"];
    const marketplaces = config.value["installedMarketplaces"];
    if (installed === undefined && enabledMap === undefined) return;
    if (installed !== undefined && !isRecord(installed)) {
      warnings.push(
        `Ignoring "installedPlugins" in ${config.path}: expected an object of plugin entries.`,
      );
      return;
    }
    if (enabledMap !== undefined && !isRecord(enabledMap)) {
      warnings.push(
        `Ignoring "enabledPlugins" in ${config.path}: expected an object of plugin flags.`,
      );
      return;
    }
    const entries = new Map<string, Record<string, unknown>>();
    if (installed) {
      for (const [key, entry] of Object.entries(installed)) {
        if (!isRecord(entry)) {
          warnings.push(
            `Ignoring plugin entry "${key}" in ${config.path}: expected an object.`,
          );
          continue;
        }
        entries.set(key, entry);
      }
    }
    if (enabledMap) {
      for (const key of Object.keys(enabledMap)) {
        if (!entries.has(key)) entries.set(key, {});
      }
    }
    for (const [key, entry] of entries) {
      const rawName = entry["name"];
      const name =
        typeof rawName === "string" && rawName.length > 0
          ? rawName
          : key.includes("@")
            ? key.slice(0, key.indexOf("@"))
            : key;
      if (name.length === 0) {
        warnings.push(
          `Ignoring plugin entry "${key}" in ${config.path}: expected a non-empty name.`,
        );
        continue;
      }
      const marketplace =
        typeof entry["marketplace"] === "string" &&
        (entry["marketplace"] as string).length > 0
          ? (entry["marketplace"] as string)
          : key.includes("@")
            ? key.slice(key.indexOf("@") + 1)
            : "unknown";
      const version =
        typeof entry["version"] === "string" &&
        (entry["version"] as string).length > 0
          ? (entry["version"] as string)
          : null;
      const scope =
        entry["scope"] === "user" ||
        entry["scope"] === "project" ||
        entry["scope"] === "local"
          ? (entry["scope"] as string)
          : "unknown";
      const flag = enabledMap?.[key];
      const enabled =
        typeof flag === "boolean" ? flag : entry["enabled"] !== false;
      if (
        isRecord(marketplaces) &&
        marketplace !== "unknown" &&
        !(marketplace in marketplaces)
      ) {
        warnings.push(
          `Plugin "${name}" references marketplace "${marketplace}" with no entry in "installedMarketplaces" in ${config.path}; kept as unknown source.`,
        );
      }
      records.push({
        id: `claude-code:plugin:${scope}:${marketplace}:${name}${version ? `@${version}` : ""}`,
        name,
        harness: "claude-code",
        kind: "plugin",
        capabilities: [],
        enabled,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["plugin"] as ContextCostClass,
      });
    }
  }

  // Only names and config refs are recorded; environment values stay on disk.
  private inventoryGlobalMcp(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    this.inventoryMcpEntries(config, "user", records, warnings);
  }

  private inventoryProjectMcp(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const file = path.join(this.root, ".mcp.json");
    if (!existsSync(file)) return;
    const value = this.readJsonFile(file, warnings);
    if (!value) return;
    this.inventoryMcpEntries(
      { path: file, scope: "project", value },
      "project",
      records,
      warnings,
    );
  }

  private inventoryMcpEntries(
    config: ParsedConfig,
    scope: "project" | "user",
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
        id: `claude-code:mcp:${scope}:${name}`,
        name,
        harness: "claude-code",
        kind: "mcp",
        capabilities: [],
        enabled: enabled === undefined ? true : enabled !== false,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["mcp"] as ContextCostClass,
      });
    }
  }

  // Hook commands are never executed and their text never enters records;
  // only event and matcher names are inventoried.
  private inventoryHooks(
    settings: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const hooks = settings.value["hooks"];
    if (hooks === undefined) return;
    if (!isRecord(hooks)) {
      warnings.push(
        `Ignoring "hooks" in ${settings.path}: expected an object of event entries.`,
      );
      return;
    }
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) {
        warnings.push(
          `Ignoring hook event "${event}" in ${settings.path}: expected an array of matcher entries.`,
        );
        continue;
      }
      const bare: { name: string }[] = [];
      for (const matcher of matchers) {
        if (!isRecord(matcher)) {
          warnings.push(
            `Ignoring hook matcher for "${event}" in ${settings.path}: expected an object.`,
          );
          continue;
        }
        const name = matcher["matcher"];
        if (name === undefined) {
          bare.push({ name: event });
        } else if (typeof name === "string" && name.length > 0) {
          records.push({
            id: `claude-code:hook:${settings.scope}:${event}/${name}`,
            name: `${event}/${name}`,
            harness: "claude-code",
            kind: "hook",
            capabilities: [],
            enabled: true,
            configRefs: [settings.path],
            contextCostClass: COST_BY_KIND["hook"] as ContextCostClass,
          });
        } else {
          warnings.push(
            `Ignoring hook matcher for "${event}" in ${settings.path}: expected a non-empty matcher string.`,
          );
        }
      }
      for (const entry of bare) {
        records.push({
          id: `claude-code:hook:${settings.scope}:${entry.name}`,
          name: entry.name,
          harness: "claude-code",
          kind: "hook",
          capabilities: [],
          enabled: true,
          configRefs: [settings.path],
          contextCostClass: COST_BY_KIND["hook"] as ContextCostClass,
        });
      }
    }
  }

  private inventoryArtifacts(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const seen = new Set<string>();
    const projectClaude = path.join(this.root, ".claude");
    const homeClaude = path.join(this.home, ".claude");
    this.inventorySkillRoot(
      path.join(projectClaude, "skills"),
      "project",
      records,
      warnings,
      seen,
    );
    this.inventorySkillRoot(
      path.join(homeClaude, "skills"),
      "user",
      records,
      warnings,
      seen,
    );
    this.inventoryMarkdownDir(
      path.join(projectClaude, "agents"),
      "project",
      "agent",
      records,
      warnings,
      seen,
    );
    this.inventoryMarkdownDir(
      path.join(homeClaude, "agents"),
      "user",
      "agent",
      records,
      warnings,
      seen,
    );
    this.inventoryMarkdownDir(
      path.join(projectClaude, "commands"),
      "project",
      "command",
      records,
      warnings,
      seen,
    );
    this.inventoryMarkdownDir(
      path.join(homeClaude, "commands"),
      "user",
      "command",
      records,
      warnings,
      seen,
    );
  }

  private inventorySkillRoot(
    skillRoot: string,
    scope: "project" | "user",
    records: CapabilityRecord[],
    warnings: string[],
    seen: Set<string>,
  ): void {
    const resolved = path.resolve(skillRoot);
    if (seen.has(resolved)) return;
    seen.add(resolved);
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
        warnings.push(
          `Malformed frontmatter in ${skillFile}; kept by directory name.`,
        );
      }
      const mapped = capabilities ?? [];
      const fromName = capabilityId(entry);
      records.push({
        id: `claude-code:skill:${scope}:${entry}`,
        name: name ?? entry,
        harness: "claude-code",
        kind: "skill",
        capabilities: fromName && !mapped.includes(fromName) ? [...mapped, fromName] : mapped,
        enabled: true,
        configRefs: [skillFile],
        contextCostClass: COST_BY_KIND["skill"] as ContextCostClass,
      });
    }
  }

  // Agents and commands are single markdown files listed by name only; their
  // bodies are never imported or executed.
  private inventoryMarkdownDir(
    dir: string,
    scope: "project" | "user",
    kind: "agent" | "command",
    records: CapabilityRecord[],
    warnings: string[],
    seen: Set<string>,
  ): void {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = path.join(dir, entry);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        warnings.push(`Cannot stat ${full}; skipped.`);
        continue;
      }
      const base = path.basename(entry, ".md");
      let name = base;
      let capabilities: string[] = [];
      if (kind === "agent") {
        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch (error) {
          warnings.push(
            `Cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        const frontmatterName = skillNameFromFrontmatter(text);
        const frontmatterCaps = skillCapabilitiesFromFrontmatter(text);
        if (frontmatterName === null || frontmatterCaps === null) {
          warnings.push(`Malformed frontmatter in ${full}; kept by file name.`);
        } else {
          name = frontmatterName;
          capabilities = frontmatterCaps;
        }
      }
      const fromBase = capabilityId(base);
      records.push({
        id: `claude-code:${kind}:${scope}:${base}`,
        name,
        harness: "claude-code",
        kind,
        capabilities:
          fromBase && !capabilities.includes(fromBase)
            ? [...capabilities, fromBase]
            : capabilities,
        enabled: true,
        configRefs: [full],
        contextCostClass: COST_BY_KIND[kind] as ContextCostClass,
      });
    }
  }
}

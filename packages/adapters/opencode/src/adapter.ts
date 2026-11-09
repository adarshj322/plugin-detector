import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  Candidate,
  CapabilityRecord,
  InstallPlan,
} from "@plugin-detector/core";
import {
  atomicWriteFile,
  backupFile,
  capabilityId,
  defaultRunCommand,
  InstallError,
  isRunnableSource,
  parseAppendOp,
  parseMcpOp,
  parseRunSource,
  restoreBackups,
  verifyParseableJson,
  type RunCommand,
} from "@plugin-detector/core";
import {
  skillCapabilitiesFromFrontmatter,
  skillNameFromFrontmatter,
  stripJsonc,
} from "@plugin-detector/adapter-shared";

export interface OpenCodeAdapterOptions {
  // Project root holding opencode.json(c) and .opencode/. Defaults to cwd,
  // or to `home` when only `home` is given (fixture-friendly).
  root?: string;
  // Fakeable home for global ~/.config/opencode config and skills.
  home?: string;
  // Runs `npx skills add` for verified skill installs. Inject a stub in
  // tests; the default spawns npx and never runs during inventory.
  runCommand?: RunCommand;
}

export interface DetectResult {
  harness: "opencode";
  detected: boolean;
  evidence: string[];
}

export type InventoryStatus = "ok" | "partial";

export interface InventoryResult {
  harness: "opencode";
  status: InventoryStatus;
  records: CapabilityRecord[];
  warnings: string[];
}

export type TrustLabel = "verified" | "curated" | "unverified";

export interface RollbackResult {
  restored: string[];
}

// v1 HarnessAdapter surface. applyPlan executes only verified, fully
// structured plans (consent is enforced upstream by applyInstallPlan);
// recipe-only or mixed plans throw and change nothing.
export interface HarnessAdapter {
  detect(): Promise<DetectResult>;
  inventory(): Promise<InventoryResult>;
  compatibility(candidate: Candidate): number;
  installPlan(candidate: Candidate, trust?: TrustLabel): InstallPlan;
  applyPlan(plan: InstallPlan): Promise<{ applied: string[] }>;
  rollback(plan: InstallPlan): Promise<RollbackResult>;
}

type ContextCostClass = CapabilityRecord["contextCostClass"];

const COST_BY_KIND: Record<string, ContextCostClass> = {
  skill: "per-use",
  hook: "per-session",
  mcp: "per-query",
  command: "zero",
  plugin: "per-session",
};

const PROJECT_SKILL_ROOTS = [".opencode/skills", ".skills"];
const GLOBAL_SKILL_ROOTS = [
  ".config/opencode/skills",
  ".opencode/skills",
  ".skills",
];
const PLUGIN_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

interface ParsedConfig {
  path: string;
  scope: "project" | "global";
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Missing file reads as an empty config; anything unparseable or
// non-object throws so the caller's backup + rollback path engages.
function readExistingObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(readFileSync(file, "utf8"))) as unknown;
  } catch (error) {
    throw new InstallError(
      "apply-failed",
      `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new InstallError(
      "apply-failed",
      `Ignoring ${file}: top-level value is not an object.`,
    );
  }
  return parsed;
}

export class OpenCodeAdapter implements HarnessAdapter {
  private readonly root: string;
  private readonly home: string;
  private readonly runCommand: RunCommand;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.home = options.home ?? homedir();
    this.root = options.root ?? options.home ?? process.cwd();
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  async detect(): Promise<DetectResult> {
    const evidence = this.evidencePaths().filter((entry) =>
      existsSync(entry),
    );
    return { harness: "opencode", detected: evidence.length > 0, evidence };
  }

  async inventory(): Promise<InventoryResult> {
    const records: CapabilityRecord[] = [];
    const warnings: string[] = [];
    for (const config of this.readConfigs(warnings)) {
      this.inventoryConfig(config, records, warnings);
    }
    this.inventorySkills(records, warnings);
    this.inventoryLocalPlugins(records);
    this.inventoryCommands(records, warnings);
    return {
      harness: "opencode",
      status: warnings.length > 0 ? "partial" : "ok",
      records,
      warnings,
    };
  }

  // Real 0-1 score consumed as-is by scoring: 1 for natively supported
  // artifacts with installable source evidence, 0.5 for partially supported
  // commands/hooks or missing source evidence, 0 for tools (no standalone
  // tool path in OpenCode v1; tools arrive via plugins or MCP).
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

  // Verified + supported type yields a harness-native plan (`npx skills add`
  // for skills, config merge for npm plugins and MCP servers). Anything else
  // yields a manual recipe; nothing here touches the filesystem.
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
    const jsoncPath = path.join(this.root, "opencode.jsonc");
    // JSONC comments cannot be preserved by the JSON merge writer. When a
    // JSONC config exists (with or without a sibling .json), the config write
    // is recipe-only rather than silently replacing the file OpenCode reads.
    const configWriteBlocked =
      candidate.artifactType !== "skill" && existsSync(jsoncPath);
    if (trust === "verified" && supported && !configWriteBlocked) {
      const configPath = path.join(this.root, "opencode.json");
      if (candidate.artifactType === "skill") {
        const dest = path.join(this.home, ".config", "opencode", "skills");
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
        backupRefs.push(configPath);
        operations = [
          {
            kind: "append",
            target: configPath,
            summary: `Append "${source}" to the "plugin" array in ${configPath}.`,
          },
        ];
        rollbackOperations = [
          {
            kind: "recipe",
            summary: `Remove "${source}" from the "plugin" array in ${configPath} to restore the backed-up preimage.`,
          },
        ];
      } else {
        backupRefs.push(configPath);
        operations = [
          {
            kind: "write",
            target: configPath,
            summary:
              `Merge MCP server "${candidate.id}" (source ${source}) into the "mcp" object in ${configPath}.`,
          },
        ];
        rollbackOperations = [
          {
            kind: "recipe",
            summary:
              `Remove the "${candidate.id}" entry from the "mcp" object in ${configPath} to restore the backed-up preimage.`,
          },
        ];
      }
    } else {
      const reason = configWriteBlocked
        ? `an existing opencode.jsonc cannot be rewritten without losing comments; edit it manually`
        : supported
          ? `trust is "${trust}", not verified`
          : `artifact type "${candidate.artifactType}" has no harness-native installer`;
      operations = [
        {
          kind: "recipe",
          summary:
            `Manual install of "${candidate.name}" (${candidate.artifactType}) from ${source}: ${reason}. ` +
            `No files were changed; follow the candidate's documented install steps for OpenCode.`,
        },
      ];
      rollbackOperations = [];
    }
    return {
      candidateId: candidate.id,
      harness: "opencode",
      operations,
      backupRefs,
      rollbackOperations,
      approvalTokenRequired: true,
    };
  }

  async applyPlan(plan: InstallPlan): Promise<{ applied: string[] }> {
    if (
      plan.operations.length === 0 ||
      plan.operations.some((op) => op.kind === "recipe")
    ) {
      throw new InstallError(
        "recipe-only",
        "OpenCode applyPlan refuses recipe-only or mixed plans: follow the manual recipe instead.",
      );
    }
    const applied: string[] = [];
    try {
      for (const op of plan.operations) {
        if (op.kind === "append") applied.push(this.applyPluginAppend(op));
        else if (op.kind === "write") applied.push(this.applyMcpWrite(op));
        else applied.push(this.applySkillRun(op));
      }
    } catch (error) {
      restoreBackups(plan.backupRefs);
      throw error instanceof InstallError
        ? error
        : new InstallError(
            "apply-failed",
            `OpenCode install failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
    return { applied };
  }

  // Byte-for-byte restore of every backed-up preimage. Directories created
  // by external commands are never deleted; the plan's rollback recipe
  // covers their manual removal.
  async rollback(plan: InstallPlan): Promise<RollbackResult> {
    return { restored: restoreBackups(plan.backupRefs) };
  }

  private applyPluginAppend(op: InstallPlan["operations"][number]): string {
    const edit = parseAppendOp(op);
    if (edit.mode !== "array" || edit.key !== "plugin") {
      throw new InstallError(
        "apply-failed",
        `Unsupported append target for OpenCode: ${op.summary}`,
      );
    }
    backupFile(edit.file);
    const current = readExistingObject(edit.file);
    const list = current["plugin"] ?? [];
    if (!Array.isArray(list)) {
      throw new InstallError(
        "apply-failed",
        `Cannot append in ${edit.file}: "plugin" is not an array.`,
      );
    }
    if (!list.includes(edit.source)) list.push(edit.source);
    current["plugin"] = list;
    atomicWriteFile(edit.file, `${JSON.stringify(current, null, 2)}\n`);
    verifyParseableJson(edit.file);
    return edit.file;
  }

  private applyMcpWrite(op: InstallPlan["operations"][number]): string {
    const edit = parseMcpOp(op);
    if (edit.section !== "mcp") {
      throw new InstallError(
        "apply-failed",
        `Unsupported MCP section for OpenCode: ${op.summary}`,
      );
    }
    if (!isRunnableSource(edit.source)) {
      throw new InstallError(
        "apply-failed",
        `Cannot derive an MCP command from URL source "${edit.source}"; follow the plan's manual recipe.`,
      );
    }
    backupFile(edit.file);
    const current = readExistingObject(edit.file);
    const section = current["mcp"] ?? {};
    if (!isRecord(section)) {
      throw new InstallError(
        "apply-failed",
        `Cannot merge in ${edit.file}: "mcp" is not an object.`,
      );
    }
    // shortcut: minimal local-stdio form; richer transports (env, args,
    // remote URLs) need a manual edit — upgrade if a verified spec lands.
    if (!(edit.serverId in section)) {
      section[edit.serverId] = {
        type: "local",
        command: ["npx", edit.source],
      };
    }
    current["mcp"] = section;
    atomicWriteFile(edit.file, `${JSON.stringify(current, null, 2)}\n`);
    verifyParseableJson(edit.file);
    return edit.file;
  }

  private applySkillRun(op: InstallPlan["operations"][number]): string {
    const source = parseRunSource(op.summary);
    const result = this.runCommand("npx", ["skills", "add", source]);
    if (result.status !== 0) {
      throw new InstallError(
        "apply-failed",
        `npx skills add ${source} failed with status ${result.status}.`,
      );
    }
    return `npx skills add ${source}`;
  }

  private evidencePaths(): string[] {
    return [
      path.join(this.root, "opencode.json"),
      path.join(this.root, "opencode.jsonc"),
      path.join(this.root, ".opencode"),
      path.join(this.home, ".config", "opencode", "opencode.json"),
      path.join(this.home, ".config", "opencode", "opencode.jsonc"),
      ...PROJECT_SKILL_ROOTS.map((dir) => path.join(this.root, dir)),
      ...GLOBAL_SKILL_ROOTS.map((dir) => path.join(this.home, dir)),
    ];
  }

  private configPaths(): { file: string; scope: "project" | "global" }[] {
    const project = ["opencode.json", "opencode.jsonc"].map((file) => ({
      file: path.join(this.root, file),
      scope: "project" as const,
    }));
    const globalFiles = ["opencode.json", "opencode.jsonc"].flatMap((file) => [
      {
        file: path.join(this.home, ".config", "opencode", file),
        scope: "global" as const,
      },
      {
        file: path.join(this.home, ".opencode", file),
        scope: "global" as const,
      },
    ]);
    return [...project, ...globalFiles];
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

  private inventoryConfig(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    this.inventoryPluginEntries(config, records, warnings);
    this.inventoryMcpEntries(config, records, warnings);
    this.inventoryHookEntries(config, records, warnings);
    this.inventoryCommandEntries(config, records, warnings);
  }

  private inventoryPluginEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const plugin = config.value["plugin"];
    if (plugin === undefined) return;
    if (!Array.isArray(plugin)) {
      warnings.push(
        `Ignoring "plugin" in ${config.path}: expected an array of package specs.`,
      );
      return;
    }
    for (const entry of plugin) {
      if (typeof entry !== "string" || entry.length === 0) {
        warnings.push(
          `Ignoring plugin entry in ${config.path}: expected a non-empty string.`,
        );
        continue;
      }
      records.push({
        id: `opencode:plugin:${config.scope}:${entry}`,
        name: entry,
        harness: "opencode",
        kind: "plugin",
        capabilities: [],
        enabled: true,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["plugin"] as ContextCostClass,
      });
    }
  }

  // Only names and config refs are recorded; environment values stay on disk.
  private inventoryMcpEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const mcp = config.value["mcp"];
    if (mcp === undefined) return;
    if (!isRecord(mcp)) {
      warnings.push(
        `Ignoring "mcp" in ${config.path}: expected an object of server entries.`,
      );
      return;
    }
    for (const [name, entry] of Object.entries(mcp)) {
      const detail = isRecord(entry) ? entry : {};
      const enabled = detail["enabled"];
      records.push({
        id: `opencode:mcp:${config.scope}:${name}`,
        name,
        harness: "opencode",
        kind: "mcp",
        capabilities: [],
        enabled: enabled === undefined ? true : enabled !== false,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["mcp"] as ContextCostClass,
      });
    }
  }

  private inventoryHookEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const hooks = config.value["hooks"];
    if (hooks === undefined) return;
    const names: string[] = [];
    if (isRecord(hooks)) {
      names.push(...Object.keys(hooks));
    } else if (Array.isArray(hooks)) {
      for (const entry of hooks) {
        if (typeof entry === "string" && entry.length > 0) names.push(entry);
        else if (isRecord(entry) && typeof entry["name"] === "string") {
          names.push(entry["name"] as string);
        } else {
          warnings.push(
            `Ignoring hook entry in ${config.path}: expected a name string.`,
          );
        }
      }
    } else {
      warnings.push(
        `Ignoring "hooks" in ${config.path}: expected an object or array.`,
      );
      return;
    }
    for (const name of names) {
      records.push({
        id: `opencode:hook:${config.scope}:${name}`,
        name,
        harness: "opencode",
        kind: "hook",
        capabilities: [],
        enabled: true,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["hook"] as ContextCostClass,
      });
    }
  }

  private inventoryCommandEntries(
    config: ParsedConfig,
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const commands = config.value["commands"];
    if (commands === undefined) return;
    if (!Array.isArray(commands)) {
      warnings.push(
        `Ignoring "commands" in ${config.path}: expected an array of names.`,
      );
      return;
    }
    for (const entry of commands) {
      if (typeof entry !== "string" || entry.length === 0) {
        warnings.push(
          `Ignoring command entry in ${config.path}: expected a non-empty string.`,
        );
        continue;
      }
      records.push({
        id: `opencode:command:${config.scope}:${entry}`,
        name: entry,
        harness: "opencode",
        kind: "command",
        capabilities: [],
        enabled: true,
        configRefs: [config.path],
        contextCostClass: COST_BY_KIND["command"] as ContextCostClass,
      });
    }
  }

  private inventorySkills(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    for (const dir of PROJECT_SKILL_ROOTS) {
      this.inventorySkillRoot(path.join(this.root, dir), "project", records, warnings);
    }
    for (const dir of GLOBAL_SKILL_ROOTS) {
      this.inventorySkillRoot(path.join(this.home, dir), "global", records, warnings);
    }
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
        id: `opencode:skill:${scope}:${entry}`,
        name: name ?? entry,
        harness: "opencode",
        kind: "skill",
        capabilities: fromName && !mapped.includes(fromName) ? [...mapped, fromName] : mapped,
        enabled: true,
        configRefs: [skillFile],
        contextCostClass: COST_BY_KIND["skill"] as ContextCostClass,
      });
    }
  }

  // Local plugins are listed by file name only and never imported.
  private inventoryLocalPlugins(records: CapabilityRecord[]): void {
    const pluginDir = path.join(this.root, ".opencode", "plugins");
    let entries: string[];
    try {
      entries = readdirSync(pluginDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(pluginDir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile() || !PLUGIN_EXTENSIONS.has(path.extname(entry))) continue;
      const base = path.basename(entry, path.extname(entry));
      const mapped = capabilityId(base);
      records.push({
        id: `opencode:plugin:project:${base}`,
        name: base,
        harness: "opencode",
        kind: "plugin",
        capabilities: mapped ? [mapped] : [],
        enabled: true,
        configRefs: [full],
        contextCostClass: COST_BY_KIND["plugin"] as ContextCostClass,
      });
    }
  }

  private inventoryCommands(
    records: CapabilityRecord[],
    warnings: string[],
  ): void {
    const commandDir = path.join(this.root, ".opencode", "commands");
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
        id: `opencode:command:project:${base}`,
        name: base,
        harness: "opencode",
        kind: "command",
        capabilities: mapped ? [mapped] : [],
        enabled: true,
        configRefs: [full],
        contextCostClass: COST_BY_KIND["command"] as ContextCostClass,
      });
    }
  }
}

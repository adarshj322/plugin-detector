# Harness adapters

plugin-detector v0.1 ships four first-class research and inventory adapters:
**OpenCode**, **Claude Code**, **Codex**, and **Cursor**. Discovery is broad;
mutation is deliberately narrow.

The adapter contract is `detect`, `inventory`, `compatibility`, `installPlan`,
`applyPlan`, and `rollback`. Fixtures are repository test data (`fixtures/`), not
a runtime adapter method. Config discovery is performed inside `detect` /
`inventory`: there is no separate public `discoverConfig` method yet. Both the
`fixtures` descriptor and `discoverConfig` are tracked as v1.0 API gates in
[CHANGELOG.md](../CHANGELOG.md#unresolved-v10-gates).

## Support matrix

| Capability | OpenCode | Claude Code | Codex | Cursor |
| --- | --- | --- | --- | --- |
| Detect installation / config roots | Yes | Yes | Yes | Yes |
| Inventory installed capabilities | Yes | Yes | Yes | Yes |
| MCP server inventory | Yes | Yes | Yes | Yes |
| Skills inventory | Yes | Yes | Yes | Yes (experimental) |
| Hooks / commands inventory | Yes | Yes | Partial | Yes (commands) |
| Automatic install writer | **Yes, verified only** | **Skills/MCP only, verified only** | **No — recipe-only** | **No — recipe-only** |
| Rollback for managed writes | Yes | Yes | Recipe only | Recipe only |
| Live upstream verification | Fixture-tested; re-check before release | Fixture-tested; re-check before release | **Not verified** | **Not verified** |

"Verified only" means the plan is written only when the candidate's trust class
is `verified` **and** the candidate's artifact was actually probed. Everything
else, including `curated` and every source-declared unprobed refresh record,
gets a manual recipe. Codex and Cursor never write in v0.1: their `applyPlan`
throws until live verification plus review flips `installVerified`.

v0.1 live refresh does not fetch each candidate's manifest/package metadata, so
its records are marked unprobed: they are excluded from `recommend` and can never
reach a write plan. Automatic install in v0.1 therefore requires a manually
reviewed, probed snapshot. A publisher/official source policy plus live artifact
probing is an explicit v1.0 gate.

## OpenCode

**Detects**

- project `opencode.json` / `opencode.jsonc`
- `.opencode/` (plugins, skills, commands)
- global `~/.config/opencode/opencode.json(c)` and `~/.opencode/opencode.json(c)`
- project and global skill roots

**Inventories**: npm and local plugins, skills, MCP servers, commands, and hooks.
JSONC comments are stripped without evaluating the file. Invalid JSON or
frontmatter produces `status: "partial"` with warnings; it never crashes the
inventory or invents records.

**Writes** (verified trust only):

| Artifact | Operation | Rollback |
| --- | --- | --- |
| Skill | `npx skills add <source>` into the OpenCode user skill root | Remove the installed skill directory |
| Plugin | Append/merge the source into the `plugin` array in `opencode.json` | Restore the backed-up config |
| MCP server | Merge the server into the `mcp` object in `opencode.json` | Restore the backed-up config |

If resolver order finds an existing `opencode.jsonc` (with or without a sibling
`opencode.json`), plugin/MCP config writes are **recipe-only**: the JSON merge
writer cannot preserve comments, and writing a second JSON config could shadow
the file OpenCode actually reads. Skills still use the skills CLI.

**Recipe fallback**: unverified candidates, commands, hooks, tools, and artifacts
with no source evidence. Config is backed up before a write, validated after,
and restored on failure.

## Claude Code

**Detects**

- `~/.claude.json` and `~/.claude/` (settings, skills, commands, agents)
- project `.claude/settings.json`, `.claude/settings.local.json`
- project `.mcp.json`
- marketplace metadata referenced from config

**Inventories**: plugins and their enabled state, MCP servers (global and
project), hooks, commands, skills, and marketplace references. Hook/command/
skill/MCP cost classes are kept distinct.

**Writes** (verified trust only):

| Artifact | Operation | Rollback |
| --- | --- | --- |
| Skill | `npx skills add <source>` into `~/.claude/skills` | Remove the installed skill directory |
| MCP server | Merge into `mcpServers` in project `.mcp.json` | Restore the backed-up config |

**Plugins are recipe-only.** Claude's plugin install is the documented
marketplace/plugin flow (`plugin@marketplace`, `installedPlugins` metadata).
Writing only `enabledPlugins[source] = true` enables nothing that is not already
installed, so v0.1 never claims or performs automatic plugin install. The plan
prints the manual marketplace flow instead.

**Recipe fallback**: unverified candidates, plugins, commands, hooks, tools, and
artifacts with no source evidence.

## Codex

**Detects**

- `~/.codex/config.toml`, `~/.codex/config.json`, `~/.codex/auth.json`
  (`auth.json` proves installation and is **never read**)
- project `.codex/config.toml` / `.codex/config.json`
- `~/.agents/skills` and project `.agents/skills`

**Inventories**: skills, plugins, and MCP servers from Codex config. The TOML
reader is a deliberate subset (no multiline strings, dates, or numeric
underscores); an unsupported file yields `status: "partial"` with a warning
instead of a guessed inventory.

**Writes**: **none in v0.1.** Every candidate — including verified ones —
returns a manual recipe with the exact file, a suggested command or edit, and a
rollback instruction. `applyPlan` throws with an explicit "live mutation is
unverified" error. This is a first-class research/inventory adapter, not a
verified installer.

## Cursor

**Detects**

- `~/.cursor/mcp.json` and project `.cursor/mcp.json`
- project `.cursorrules`, `.cursor/rules`, `.cursor/commands`, `.cursor/skills`
- `~/.cursor/` (evidence only)

**Inventories**: MCP servers, rules, commands, and skills. Cursor MCP support is
the documented path; skills/rules/commands are treated as **experimental** and
cap at a lower compatibility score.

**Writes**: **none in v0.1.** MCP, skill, command, and rule candidates all return
manual recipes. `applyPlan` throws until live verification flips
`installVerified`. Do not treat Cursor installation as equal in stability to
OpenCode or Claude Code.

## Compatibility scores

Adapters return a 0–1 compatibility score used by the production scorer in both
`recommend` and `explain`:

- `1` — documented artifact type with installable source evidence
- `0.7` — Claude Code commands/hooks (runnable, not package-installable)
- `0.5` — partially supported type (commands/hooks in OpenCode/Codex, inferred
  Cursor types), missing source evidence, or an unpinned Claude Code artifact
- `0` — unsupported type (for example a standalone `tool`)

Compatibility multiplies the fit term and compatibility `0` is a hard gate: such
a candidate can never receive `required`, is excluded from the returned top set,
and `explain` prints its `risky` verdict. A displayed `1` still means "this
harness has a supported path", not "the artifact was verified".

## Fixtures

Each adapter is exercised against committed fixtures under `fixtures/`:
`opencode/`, `claude-code/`, `codex/`, `cursor/`, plus red-team fixtures for
typo-squats, prompt injection, malicious hooks, silent drift, stale/archived
servers, and dependency confusion. Tests run in temporary `$HOME` trees and
assert that inventory never reads secret values.

## Adding or promoting an adapter

1. Add or extend fixtures first; include malformed, partial, and hostile cases.
2. Implement the full contract and keep `applyPlan` refusing until the mutation
   path is covered by tests and live-verified against current upstream docs.
3. Flips `installVerified` only in a dedicated pull request with review evidence.
4. Update this matrix and the README table in the same change.

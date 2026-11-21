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
| Lifecycle rows (`version`, `sourceRef`, scope) | Yes | Yes | Yes | Yes |
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

Live refresh now fetches each candidate's manifest or package metadata. Only
candidates with real artifact evidence enter the snapshot; listing-only records
are kept in the manifest as `unprobed` and can never reach a write plan. A hard
probe/normalize rejection removes any prior record for that id, while a
transient source failure preserves the prior evidence at its old age. Automatic
install still requires a manually reviewed, probed snapshot. A package claim is
also revalidated at plan/install time against the probed artifact, so a stored
`verified` label cannot turn an unrelated `packageName` into an install source.

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

## External CLI inventory

`inventory` also probes a fixed, curated list of host CLIs: `git`, `gh`,
`docker`, `kubectl`, `rg`, `jq`, `playwright`, `ffmpeg`, `node`, `npm`,
`python3`, and `uv`. It checks only those names on `PATH` with a per-name
`which`-style lookup (no directory listing, no shell), records the resolved
binary as `installPath` and `PATH:<name>` as `sourceRef`, and runs only
`--version` against that resolved binary with a 2s cap.

Capabilities are explicit and canonical: `git`/`gh` → `vcs.workflow`,
`docker`/`kubectl` → `containers.orchestration`, `jq` → `data.analysis`,
`playwright` → `browser.automation`, `ffmpeg` → `media.transcode`. `rg` and the
language/package runtimes `node`, `npm`, `python3`, and `uv` stay unclassified
(`capabilities: []`): being installed does not make them cover a workflow
domain.

Records appear in a separate `external` group in both `inventory` text and
`inventory --json` output. The group is host-wide, not attributed to a harness.
`recommend` includes the same records in its installed inventory and
`lifecycle` rows, so an enabled external CLI suppresses duplicate capability
recommendations and appears as a `keep` row. `explain external:cli:<name>`
resolves the record and shows its version, status, and keep action. It can never
be a replacement target: candidate artifact kinds are
skill/plugin/MCP/hook/command/tool, not `cli`, so lifecycle comparison keeps it
even when a candidate shares a capability. Because `PATH:<name>` has no registry mapping, `--check-updates`
leaves these records unchanged for manual review. A wedged tool can cost up to
2s per probe; `inventory --skip-external` skips the group entirely. `recommend`
probes the same list on every run and has no `--skip-external` flag in v0.1.

## Installed lifecycle

`recommend` inventories every detected harness plus the curated external CLIs,
then compares each installed record with the scored candidate set. The result is
a separate `lifecycle` array in JSON and an `installed lifecycle` section in
text output:

| Action | Meaning | Recipe |
| --- | --- | --- |
| `keep` | No better candidate, current/unknown version, no added capability, or a lost capability | None |
| `upgrade` | Same tool identity with a newer comparable version | Print-only backup + update + rollback |
| `replace` | Same kind, capability superset, threshold met, and installed freshness proven `outdated` | Print-only backup + remove + install + rollback |
| `review` | Locally modified installed artifact; manual review first | None |

Text output omits unchanged `keep` rows that carry neither a candidate nor
latest-version evidence, and prints how many rows were omitted; `--json` keeps
every row.

Applicability is narrower than inventory in v1.0:

| Artifact kind | Upgrade / replace support |
| --- | --- |
| Config-declared plugin with source and installed version | Yes: same identity + newer version upgrades; same-kind capability superset replaces only when freshness is proven `outdated`. |
| Skill with `metadata.homepage` and `version` | Yes for resolver-backed sources; remove/add pass `-a <harness>` so other harnesses are untouched (`update` has no agent flag). |
| Skill without homepage/version | Inventory-only; stays `keep`. |
| MCP server | Inventory-only unless source/version evidence exists. `sourceRef` is best-effort from a clear `npx <package>` / `npm exec <package>` command; installed versions are usually unknown. |
| Agent | Inventory-only unless version metadata exists. `agent` is a valid candidate artifact type, but installed agents normally have no version. |
| External CLI | Inventory-only; always `keep` because no candidate artifact kind is `cli`. |

The comparison is deliberately conservative. It requires the same artifact
kind, a candidate that adds at least one capability not already covered by an
enabled install, no unpreserved installed capability, a candidate score at or
above the profile threshold, and installed freshness proven `outdated`. Unknown
installed versions stay `keep`; current versions are not churned for novelty.

`review` requires a recorded baseline, and v1.0 does not populate one. Adapters
report `modified: unknown`, so a locally edited artifact is never classified as
modified from comparison alone and is never automatically replaced. `review`
stays reserved for a future baseline.

Lifecycle version/source fields are best-effort. A missing manifest, a
config-only declaration, or a partial adapter inventory yields `unknown` rather
than a guess; Codex and Cursor inventories can be partial because their formats
or upstream support are less complete.

Recipes are documented `opencode`, `claude`, `npx skills`, or config-edit
commands where the harness and scope are known, and manual instructions
everywhere else (external CLIs, unknown harness/scope, local paths, unsafe
arguments). Every recipe starts with an explicit backup step naming the config
file or installed directory, then the remove/update and install steps, then an
explicit rollback step naming the same target, and finally:
`Run only after explicit approval; back up config before editing.`
For installed explain, `latestVersion` is the installed artifact's upstream
latest; a replacement/upgrade candidate's version is shown separately as
`candidateVersion`. No lifecycle command writes files, executes a recipe,
removes an artifact, or consumes an approval token. `--check-updates` is the
only network path; without it, versions stay `unknown`.

Known limits: there is no standalone `remove` action in v0.1, recipes may need
adaptation for local layouts, many path-installed skills have no version
evidence, and not every harness exposes installed plugin or MCP versions.

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

# plugin-detector — all harness artifacts and lifecycle recommendations

Date: 2026-11-10  
Status: proposed for approval  
Supersedes/extends: `2026-11-08-plugin-detector-design.md` and the v1.0 evidence plan  
Niche: software development first

## Intent

A harness can use more than plugins: skills, MCP servers, CLIs, hooks, commands, agents, and local tools. The recommender must understand all of them, know what is installed and how old it is, and recommend:

- install a missing capability;
- upgrade an installed but outdated tool;
- replace an installed tool when a materially better current tool exists;
- keep an installed tool when the alternative is not clearly better.

The user must never be nudged to churn tools for novelty. “Better” needs evidence: newer version, more capabilities, better maintenance, or materially better fit.

## Current findings that drive this

- Dogfood inventory missed auto-discovered OpenCode plugins (`open-code-review`, `rtk`) because it read only `opencode.jsonc`.
- Installed plugins (`superpowers`, `ponytail`, `hindsight`, `open-code-review`) had empty capabilities, so redundancy could not be detected.
- `agent-reach` and `browser-skill` are skills, not plugins; `browser-skill` uses the external `bsk` CLI.
- No installed version/freshness model exists.
- No recommendation can say “upgrade this” or “replace this with X.”

## Goals

1. Inventory every artifact class the harness can use:
   - skills, plugins, MCP servers, hooks, commands, agents, and external CLIs/tools.
2. Record for each installed artifact: name, kind, source, version/ref, install path/config ref, enabled state, capabilities, last update evidence.
3. Compare installed versions with latest known versions from the same source.
4. Detect when another candidate has a superset of capabilities and stronger maintenance/evidence than an installed tool.
5. Produce a recommendation with an action: `install`, `upgrade`, `replace`, `remove`, or `keep`.
6. For replace/upgrade, show a plan that removes/disables the old artifact and installs the new one, with backup and rollback, only after approval.
7. Keep discovery broad; keep installation conservative.

## Non-goals

- No automatic removal, replacement, or upgrade.
- No scanning every binary on PATH by default.
- No background watcher or scheduled checks.
- No hosted version database in v1.
- No forced migration when versions cannot be established.
- No recommendation based only on stars/recency.

## Anti-goals

- Churn users onto newer tools that are not better.
- Treat every outdated package as a recommended replacement.
- Remove a locally modified or actively used tool automatically.
- Claim freshness when the source has no version metadata.

## Approaches considered

### A. Extend the existing inventory and recommendation model — chosen

Extend `CapabilityRecord` with lifecycle fields (`version`, `sourceRef`, `installPath`, `lastUpdated`, `latestVersion`, `latestSource`, `updateStatus`, `replacementFor`, `action`). Extend adapters to read actual runtime state and manifests; add a version resolver over npm/PyPI/GitHub releases; extend recommendation output with `action` and `replaces`.

Pros: uses the existing evidence/verdict/plan pipeline; one model for all artifact types; testable; preserves consent.
Cons: schema/adapters get broader; version resolution has source-specific rules.

### B. Separate `outdated` command

A new command lists outdated artifacts, independent of recommendation.

Pros: simpler first step.
Cons: does not answer “replace with what”; duplicates scoring and inventory; weaker product.

### C. Hosted freshness service

Central service tracks latest versions and replacements.

Pros: freshest data.
Cons: ops, trust, privacy, moderation; contradicts local-first v1.

## Locked decisions

- **Inventory source of truth**: per harness, combine declared config with actual auto-discovered artifacts. For OpenCode, scan `~/.config/opencode/plugins/` and project `.opencode/plugins/`, plus config entries. Prefer runtime-derived state where available.
- **All artifact classes**: skills, plugins, MCP servers, hooks, commands, agents, and a curated external-CLI set. External CLIs are inventoried only from a known list (e.g. `git`, `gh`, `docker`, `kubectl`, `rg`, `jq`, `playwright`) and configured tool paths; never enumerate the whole PATH by default.
- **Version evidence**: installed version from `package.json`, plugin manifest, MCP package metadata, skill metadata if present, or CLI `--version`. If unknown, `updateStatus: unknown`; do not call it outdated.
- **Latest version**: same registry/source when possible: npm dist-tag, PyPI release, GitHub latest release/tag, skills.sh snapshot hash. If no comparable source, no upgrade recommendation.
- **Better tool rule**: a replacement must have (a) a superset of the installed tool’s capabilities, or cover the same capability with better evidence; (b) better maintenance/freshness and no higher risk; and (c) a compatible install path. Stars/install counts are tiebreakers only.
- **Action field**: add `action: "install"|"upgrade"|"replace"|"remove"|"keep"` to recommendation output. Keep existing verdicts for value/risk; action answers what to do.
- **Replacement plan**: includes disable/remove old, install new, backup, rollback; requires explicit approval; never auto-executes.
- **Local modifications**: if the installed artifact differs from its recorded ref or has local edits, `updateStatus: modified`; recommend manual review, not replacement.
- **Thresholds**: upgrade (same tool, newer version) can be `required` when maintenance/fit justify it; replace requires a capability superset and a higher score than the installed tool, otherwise `keep` or `useful-optional`.

## Scope

### v1.0 slice

- OpenCode first for full inventory/version/replacement.
- Claude Code inventory parity for skills/plugins/MCP where version data exists.
- Version/update support for skills installed from skills.sh/GitHub and npm/PyPI-backed plugins/MCP.
- Curated CLI inventory for a small software-development tool set.
- Recommendations include upgrade/replace for the software-development niche.
- CLI: `recommend` output includes action; `explain` shows installed-vs-latest evidence.
- No standalone `remove` flow in v1.0; only replace plans that include removal.

### Deferred

- Automatic upgrade/removal.
- Hosted freshness service.
- Full PATH inventory.
- Native plugin version checks for Codex/Cursor where no version metadata exists.
- Standalone cleanup command beyond replacement/audit.

## Builder decisions

These resolve the implementation questions the spec left open:

1. **Installed tools are not scored with `scoreCandidate`.** Lifecycle comparison is separate: version delta, capability superset, maintenance/freshness evidence, and the candidate’s own recommendation score. This avoids treating unknown installed metadata as a near-zero score and replacing everything.
2. **Two output sections.** `recommendations` stays the existing top-5 registry-candidate list. A separate `lifecycle` section carries installed-artifact rows (`keep`, `upgrade`, `replace`, `review`) so installed-only records do not break the precision@5 benchmark contract. `action` and `replaces` live on those rows.
3. **Replace plans are print-only in v1.0.** The tool recommends a remove/disable + install recipe with backup/rollback instructions, but does not execute removal or upgrade automatically. This preserves the consent and non-goals contract. A future version can add an approved apply path.
4. **Latest versions are checked only with an explicit flag.** `recommend --check-updates` and `inventory --check-updates` may use npm/PyPI/GitHub; the default path stays offline. Offline/unknown versions become `updateStatus: unknown`, never `outdated`.
5. **`modified` requires a recorded baseline.** Plugin-detector records the content hash/ref it installed in state. If no record exists, local artifacts are `modified: unknown`; do not mark vendor-customized files as modified based only on upstream differences.
6. **`lastUpdated` is labeled.** Use upstream publish/release time when available; otherwise local filesystem mtime. The output says which.
7. **Upgrade/replace rule.** Upgrade: same artifact identity + newer comparable version. Replace: same artifact kind, candidate has at least one capability the installed artifact lacks that is not already covered by another installed tool, candidate clears its profile threshold, and the installed artifact is stale/outdated or the candidate has materially better evidence. Do not replace two active tools that cover the same role with overlapping capabilities.
8. **No standalone `remove` action in v1.0.** `replace` carries the removal recipe. Redundant/risky installed tools get `review`, not a remove recommendation.

## Acceptance

- Dogfood inventory includes `superpowers`, `ponytail`, `hindsight`, `open-code-review`, `rtk`, `agent-reach`, and `browser-skill`; each has correct kind and capabilities.
- A fixture harness with an older installed review skill and a newer superset candidate yields `action: replace` with evidence and a remove+install plan.
- A current installed tool yields `keep`.
- Unknown version yields `updateStatus: unknown`, not `replace`.
- A locally modified tool yields `modified`, not automatic replacement.
- No command writes without an approval token or TTY confirmation.
- Full suite, benchmark, pack, and dogfood acceptance pass.

## Open builder decisions

- Exact curated external-CLI list.
- Version comparison for skills with no version metadata.
- Whether to use `opencode plugin list` as a runtime probe or only filesystem/config parsing.
- How to score “superset capabilities” when the installed tool is unclassified.

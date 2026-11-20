# Lifecycle Inventory and Upgrade/Replace Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inventory every artifact a harness can use, track versions/freshness, and recommend keep/upgrade/replace with evidence — without auto-removing or churning tools.

**Architecture:** Extend the shared capability record with lifecycle fields; read actual installed state and versions per adapter; resolve latest versions on explicit request; compare installed versus candidates with a separate lifecycle rule; add a lifecycle section to recommendation output and print-only replace recipes.

**Tech Stack:** TypeScript/Node 22, npm workspaces, node:test, existing core/registry/adapters/CLI packages.

**Spec:** `docs/superpowers/specs/2026-11-10-plugin-detector-lifecycle-design.md`

## Global Constraints

- Local-first; network only for explicit `registry refresh` or `--check-updates`.
- No automatic removal, replacement, or upgrade. Replace/upgrade plans are print-only in v1.0.
- No command writes without approval token or TTY confirmation.
- All artifact kinds: skills, plugins, MCP servers, hooks, commands, agents, external CLIs.
- Unknown version is `updateStatus: unknown`; never call it outdated.
- Same-kind comparison only. Replace requires a new capability not covered by another installed tool.
- Top-5 registry recommendation contract and precision@5 benchmark remain unchanged.
- Installed lifecycle rows are separate from registry recommendations.
- No full-PATH scanning; curated CLI list only.
- Keep strict TS, ESM, no new deps unless already present.

## Review Focus

1. **Auto-discovered plugin is missed** — inventory must include `open-code-review` and `rtk` from `~/.config/opencode/plugins/`; test Task 2.
2. **Installed tool wrongly marked modified** — no recorded baseline must yield `modified: unknown`, not `modified: true`; test Task 3.
3. **Offline recommendation claims outdated** — no latest data must yield `unknown`, not `outdated`; test Task 4/5.
4. **Replace churn** — a weaker/same-role tool must not be replaced when another installed tool covers the candidate’s extra capability; test Task 5.
5. **Top-5 benchmark regression** — lifecycle rows must not consume registry recommendation slots; test Task 6.
6. **Replace plan executes removal** — v1.0 must emit a recipe only and never write; test Task 7.

---

### Task 1: Lifecycle schemas and record fields

**Files:**
- Modify: `packages/core/src/schema.ts`, `packages/core/src/index.ts`
- Create: `packages/core/src/lifecycle.ts`
- Test: `packages/core/test/lifecycle-schema.test.ts`

**Interfaces:**
- Produces: `UpdateStatus = "current" | "outdated" | "unknown" | "modified"`; `LifecycleAction = "keep" | "upgrade" | "replace" | "review"`; `CapabilityRecord` optional fields `version`, `sourceRef`, `installPath`, `lastUpdated`, `latestVersion`, `latestSource`, `updateStatus`, `modified`; `LifecycleRow` schema `{ installedId, candidateId?, action, reasons: string[], installedVersion?, latestVersion?, capabilitiesAdded: string[], recipe?: string[] }`.

- [ ] **Step 1: Write failing schema tests** — accepts optional lifecycle fields, rejects invalid action/updateStatus, accepts lifecycle row with/without candidateId, and round-trips.
- [ ] **Step 2: Verify red** — `npm test -- lifecycle-schema` fails on missing exports.
- [ ] **Step 3: Implement fields and Zod schemas** — all optional; no existing record required to change.
- [ ] **Step 4: Run focused + full suite** — green.
- [ ] **Step 5: Commit** — `feat(core): add lifecycle schemas`.

---

### Task 2: OpenCode runtime inventory and plugin capabilities

**Files:**
- Modify: `packages/adapters/opencode/src/adapter.ts`
- Modify: `packages/adapters/opencode/test/inventory.test.ts`
- Create: `fixtures/opencode/known-plugins/...`, `fixtures/opencode/inferred-capability/...`
- Test: same inventory tests

**Interfaces:**
- Consumes: `inferCapabilities` from registry; `CapabilityRecord` lifecycle fields from Task 1.
- Produces: inventory records for config plugins, global `~/.config/opencode/plugins`, project `.opencode/plugins`; known plugin capability hints for superpowers, ponytail, open-code-review, hindsight, rtk, i-have-adhd; skill capability inference from frontmatter description.

- [ ] **Step 1: Write failing tests** — known config plugins get capabilities; global open-code-review/rtk are inventoried; local plugin path is scoped; skill description inference works.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — scan both plugin roots, add explicit hint map, dedupe IDs, keep project/global precedence. Do not execute plugins.
- [ ] **Step 4: Run inventory tests + full suite**.
- [ ] **Step 5: Commit** — `feat(opencode): inventory plugins and capabilities completely`.

*Note: partial uncommitted work already exists in the worktree for this task; fold it in and verify tests.*

---

### Task 3: Installed version, source and freshness collection

**Files:**
- Modify: `packages/adapters/opencode/src/adapter.ts`, `packages/adapters/claude-code/src/adapter.ts`
- Create: `packages/adapters/shared/src/versions.ts`
- Test: `packages/adapters/shared/test/versions.test.ts`, adapter inventory tests

**Interfaces:**
- Produces: `readPackageVersion(dir)`, `readSkillVersion(frontmatterText)`, `readCliVersion(command)`, `fileMtime(path)`; lifecycle fields populated where evidence exists; `lastUpdatedSource: "upstream"|"local"` if added.

- [ ] **Step 1: Write failing tests** — package.json version; SKILL.md optional version; CLI `--version` stub; missing version → undefined; local mtime for install path.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — no shell execution of installed plugin code; only known CLIs and `--version` with timeout; never run plugin hooks.
- [ ] **Step 4: Run tests**.
- [ ] **Step 5: Commit** — `feat(adapters): collect installed versions`.

---

### Task 4: Latest-version resolver behind explicit flag

**Files:**
- Create: `packages/registry/src/updates.ts`, `packages/registry/src/sources/updates-*.ts`
- Modify: `packages/cli/src/commands/inventory.ts`, `recommend.ts`
- Test: `packages/registry/test/updates.test.ts`, CLI tests

**Interfaces:**
- Produces: `resolveLatestVersion({ kind, sourceRef, name, packageName }): Promise<LatestVersion | null>`; `LatestVersion = { version, sourceUrl, publishedAt? }`; CLI `--check-updates` flag.
- Sources: npm dist-tags, PyPI info.version, GitHub latest release/tag. No network by default.

- [ ] **Step 1: Write failing tests** — npm/PyPI/GitHub fixtures, missing source → null, offline → unknown, CLI flag only triggers resolver.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — 60/min limiter, timeout, no token required; cache per run; never call on default offline path.
- [ ] **Step 4: Run tests**.
- [ ] **Step 5: Commit** — `feat(registry): resolve latest versions on demand`.

---

### Task 5: Lifecycle comparison rule

**Files:**
- Create: `packages/core/src/lifecycle-compare.ts`
- Test: `packages/core/test/lifecycle-compare.test.ts`

**Interfaces:**
- Produces: `compareLifecycle({ installed, candidate, installedInventory, profileDomains, threshold }): LifecycleRow`.
- Rules: same kind; upgrade when newer comparable version; replace when candidate adds at least one capability not covered by any enabled installed record, candidate score ≥ profile threshold, installed is outdated/stale/unknown with weaker evidence; otherwise keep/review.

- [ ] **Step 1: Write failing tests** — current → keep; older same tool → upgrade; superset new capability → replace; candidate extra capability already installed elsewhere → keep; unknown version → keep/unknown.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run core tests + benchmark**.
- [ ] **Step 5: Commit** — `feat(core): compare installed lifecycle`.

---

### Task 6: Lifecycle output in recommend/explain

**Files:**
- Modify: `packages/cli/src/output.ts`, `packages/cli/src/commands/recommend.ts`, `explain.ts`
- Test: `packages/cli/test/recommend.test.ts`, `explain.test.ts`

**Interfaces:**
- Produces: `RecommendJson` optional `lifecycle: LifecycleRow[]`; text section “installed lifecycle”; `replaces`/recipe on rows; top-5 `recommendations` unchanged.
- `explain <installed-id>` shows installed vs latest, action, capabilities added, reason, recipe.

- [ ] **Step 1: Write failing tests** — lifecycle rows do not change top-5 count/benchmark; text output shows upgrade/replace/keep; explain unknown installed id works.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run CLI + benchmark**.
- [ ] **Step 5: Commit** — `feat(cli): show lifecycle recommendations`.

---

### Task 7: Print-only replace recipes

**Files:**
- Modify: `packages/cli/src/commands/recommend.ts`, `packages/cli/src/output.ts`
- Test: `packages/cli/test/lifecycle-plan.test.ts`

**Interfaces:**
- Produces: `lifecyclePlan(row): string[]` with exact remove/disable + install commands, backup/rollback notes; no write.

- [ ] **Step 1: Write failing tests** — replace row emits recipe; recipe names old and new source; no filesystem writes; approval required if applied in future.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run tests + pack**.
- [ ] **Step 5: Commit** — `feat(cli): add replace recipes`.

---

### Task 8: Curated external-CLI inventory

**Files:**
- Create: `packages/adapters/shared/src/external-tools.ts`
- Modify: `packages/cli/src/commands/inventory.ts`
- Test: `packages/adapters/shared/test/external-tools.test.ts`, CLI inventory tests

**Interfaces:**
- Produces: curated list `git`, `gh`, `docker`, `kubectl`, `rg`, `jq`, `playwright`, `ffmpeg`; `detectExternalTools(): CapabilityRecord[]` with version where `--version` works; missing tools omitted.
- No full PATH scan.

- [ ] **Step 1: Write failing tests** — known stub binaries detected; missing omitted; version parsed; no arbitrary path enumeration.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run tests**.
- [ ] **Step 5: Commit** — `feat(adapters): inventory curated external CLIs`.

---

### Task 9: Dogfood and acceptance

**Files:**
- Modify: `docs/adapters.md`, `README.md`, `CHANGELOG.md`
- Test: `packages/cli/test/lifecycle-acceptance.test.ts`

**Interfaces:**
- Produces: acceptance report/fixtures proving installed superpowers/ponytail/hindsight/open-code-review/rtk/agent-reach/browser-skill are detected; replace/keep/upgrade outcomes; no writes.

- [ ] **Step 1: Add acceptance fixture** — synthetic harness with installed superpowers and a competing candidate; expected `keep/replace` logic.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Run real dogfood** — `inventory --check-updates` and `recommend --use-case software-development --check-updates`; capture output.
- [ ] **Step 4: Full acceptance** — `npm ci`, typecheck, test, build, audit, pack, benchmark.
- [ ] **Step 5: Commit docs + fixtures** — `test: add lifecycle acceptance`.

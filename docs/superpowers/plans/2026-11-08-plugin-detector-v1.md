# plugin-detector v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `plugin-detector` v1: a local-first, MIT-licensed TypeScript/Node CLI + portable harness skill that broadly researches current skills/MCP servers/tools/plugins, compares them with the installed harness and declared use case, explains a short verified recommendation set, and installs only after explicit approval.

**Architecture:** A deterministic monorepo core owns schemas, taxonomy, scoring, verdicts, registry normalization, and install planning. Harness adapters provide detection/inventory/install paths. The invoking agent—not the CLI—owns natural-language deliberation; the skill enforces a no-write-before-consent contract.

**Tech Stack:** TypeScript strict ESM, Node.js >= 22, npm workspaces, Zod, YAML, Node’s built-in test runner, GitHub Actions, npm provenance.

**Spec:** `docs/superpowers/specs/2026-11-08-plugin-detector-design.md`

## Global Constraints

- License must remain MIT; release artifacts publish with npm provenance/checksums.
- Node.js floor: `>=22`; TypeScript must use `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `verbatimModuleSyntax: true`.
- Local-first: network may read public discovery sources or refresh a local cache only on user-invoked commands; no telemetry by default; no hosted dependency required.
- On-demand only: no daemon, cron, scheduled run, harness hook on every message, or background polling in v1.
- Discovery is broad; installation is trust-aware and conservative.
- Verified means: official/standards-backed source or verified publisher, active maintainer/release history, open license, immutable pinned ref, checksum/attestation where available, and no known critical audit finding for that ref.
- Unverified candidates remain visible but may only receive informational output/manual recipes, never automatic writes.
- Four first-class research/inventory adapters are required in v1: OpenCode, Claude Code, Codex, Cursor.
- OpenCode and Claude Code may auto-install only through documented/verified native paths. Codex and Cursor mutation is recipe-only until live verification explicitly flips the adapter’s `installVerified` flag.
- The CLI never calls an LLM and never executes installation during `recommend`, `explain`, `inventory`, or `registry refresh`.
- `install` refuses without an explicit approval token or a TTY confirmation. Tokens are candidate-scoped, plan-scoped, expire immediately after one use, and are created by the skill only after explicit approval.
- Every recommendation explains its evidence and confidence; estimates are labeled editorial estimates until calibrated.
- Recommendation output must never include low-value star-count findings that the user could find manually without value; the benchmark gate is release-blocking.
- Secrets are never written, stored, logged, or requested by the CLI.
- Rollback is mandatory for every managed write; rollback paths carry 100% test coverage.

## Review Focus

1. **Malformed or missing harness configuration** — adapters treat it as partial/unknown inventory rather than crashing or silently inventing installed tools; test in Tasks 6–9.
2. **Prompt injection embedded in candidate metadata/descriptions** — scoring reads only normalized evidence fields and never turns candidate text into an install action; test in Tasks 4–5 and 12.
3. **Offline/network failure during registry refresh** — bundled snapshot still answers; stale entries are labeled and not silently served as fresh; test in Tasks 5 and 11.
4. **Consent token is absent, forged, candidate-mismatched, or already used** — `install` refuses and performs zero writes; test in Task 13.
5. **Repo rename/silent drift or stale registry data** — artifact probing and pinned refs reject or re-flag changed candidates; test in Tasks 4–5 and 14.
6. **"No good candidates" is a valid answer** — the CLI returns that verdict instead of padding output with weak matches; test in Tasks 3, 11, and 15.

---

### Task 1: Monorepo scaffold and CI baseline

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `.gitignore`, `.npmrc`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/core/test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, workspace package `@plugin-detector/core`.

- [ ] **Step 1: Write the failing workspace smoke test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME } from "../src/index.js";

test("core package exports identity", () => {
  assert.equal(PACKAGE_NAME, "@plugin-detector/core");
});
```

- [ ] **Step 2: Run it to verify the missing workspace fails**

Run: `npm test`
Expected: FAIL because the workspace and export do not exist.

- [ ] **Step 3: Create the npm workspaces scaffold**

Use npm workspaces with packages `packages/*` and `packages/adapters/*`; set `private: true`, `type: module`, `engines.node: ">=22"`, and scripts: `build` = `tsc -b`, `test` = compile then `node --test` over `packages/*/test/*.test.mjs`, `typecheck` = `tsc -b --noEmit`, `lint` = `tsc -b --noEmit`. Configure `tsconfig.base.json` with the strict flags above and project references; emit only into each package’s `dist`.

- [ ] **Step 4: Add CI workflow**

In `.github/workflows/ci.yml`, run on push/PR: checkout, setup-node 22 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `npm audit --omit=dev`.

- [ ] **Step 5: Run all checks**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS; worktree has only intended scaffold files.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json tsconfig.json .gitignore .npmrc packages .github
git commit -m "chore: scaffold plugin-detector monorepo"
```

---

### Task 2: Shared schemas and capability taxonomy

**Files:**
- Create: `packages/core/src/schema.ts`, `packages/core/src/taxonomy.ts`, `packages/core/src/artifacts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schema.test.ts`, `packages/core/test/taxonomy.test.ts`

**Interfaces:**
- Produces: Zod schemas `CapabilityRecordSchema`, `CandidateSchema`, `RecommendationSchema`, `InstallPlanSchema`; enums `HarnessId`, `ArtifactType`, `Verdict`; `CANONICAL_CAPABILITY_IDS`; `capabilityId(value: string): string | null`.

- [ ] **Step 1: Write failing schema tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { CandidateSchema, Verdict } from "../src/index.js";

test("candidate requires pinned immutable ref and license", () => {
  assert.throws(() => CandidateSchema.parse({ id: "x", name: "x", artifactType: "skill", sources: [], pinnedRef: "main", license: null }));
});

test("verdict is closed enum", () => {
  assert.equal(Verdict.enum.required, "required");
  assert.throws(() => Verdict.enum.banana);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test`
Expected: FAIL on missing exports.

- [ ] **Step 3: Define schemas exactly around the spec**

`CandidateSchema` fields: `id`, `name`, `artifactType`, `sources: string[]`, `useCaseDomains: string[]`, `capabilities: string[]`, `license`, `pinnedRef`, `repositoryUrl?`, `packageName?`, `installMode: "verified" | "manual"`, `lastVerified` (ISO date), `provenance: "official" | "publisher" | "community" | "unknown"`, `risk: "low" | "medium" | "high" | "critical"`, `maintenance: "active" | "stale" | "archived" | "unknown"`, `auditStatus: "clean" | "warning" | "critical" | "unknown"`, `popularity: { stars?: number; installs?: number; velocity30d?: number }`, `rawUntrustedCopy?: string`. `CapabilityRecordSchema` fields: `id`, `name`, `harness`, `kind`, `capabilities`, `enabled`, `configRefs`, `usageCount90d?`, `contextCostClass: "per-use" | "per-session" | "per-query" | "zero"`. `InstallPlanSchema` fields: `candidateId`, `harness`, `operations: Array<{ kind: "write" | "append" | "run" | "recipe"; target?: string; summary: string }>`, `backupRefs`, `rollbackOperations`, `approvalTokenRequired: true`.

- [ ] **Step 4: Define the v1 canonical taxonomy**

Create at least these stable IDs: `testing.runner`, `testing.e2e`, `code-review.quality`, `code-review.security`, `planning.orchestration`, `planning.brainstorm`, `debugging.systematic`, `vcs.workflow`, `ci.release`, `containers.orchestration`, `docs.writing`, `design.frontend`, `design.thumbnail`, `data.analysis`, `media.transcode`, `speech.captions`, `publishing.delivery`, `security.dependencies`, `harness.management`. Add `capabilityId` that lowercases, strips punctuation, collapses separators, and returns `null` unless the ID exactly matches or maps through one explicit alias table.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- schema taxonomy`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add shared schemas and capability taxonomy"
```

---

### Task 3: Deterministic scoring and verdict engine

**Files:**
- Create: `packages/core/src/scoring.ts`, `packages/core/src/verdicts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/scoring.test.ts`, `packages/core/test/verdicts.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `CapabilityRecord`, `HarnessId`, `Verdict`.
- Produces: `scoreCandidate(input: ScoreInput): Recommendation`; `decideVerdict(input: VerdictInput): Verdict`; `ScoreInput`, `ScoreBreakdown`.

`ScoreInput` is exactly: `{ candidate, installedCapabilities, profileDomains, harness, useCaseMatch, projectSignalMatch }`. `ScoreBreakdown` returns `{ relevance, value, immediacy, compatibility, overlap, setupCost, risk, score, confidence }`.

- [ ] **Step 1: Write failing scoring tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate } from "../src/index.js";

test("popular candidate that duplicates installed capability is redundant", () => {
  const result = scoreCandidate({ candidate: candidate({ capabilities: ["code-review.quality"], popularity: { stars: 50000 } }), installedCapabilities: [installed({ capabilities: ["code-review.quality"], usageCount90d: 12 })], profileDomains: ["code-review.quality"], harness: "opencode", useCaseMatch: 1, projectSignalMatch: 1 });
  assert.equal(result.verdict, "redundant");
  assert.ok(result.overlap < 1);
});

test("critical audit candidate can never be required", () => {
  const result = scoreCandidate({ candidate: candidate({ capabilities: ["testing.runner"], auditStatus: "critical" }), installedCapabilities: [], profileDomains: ["testing.runner"], harness: "opencode", useCaseMatch: 1, projectSignalMatch: 1 });
  assert.equal(result.verdict, "risky");
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- scoring verdicts`
Expected: FAIL missing functions.

- [ ] **Step 3: Implement explainable scoring**

Compute `value` from credibility/maintenance/audit, `immediacy` from profile-domain strength, `compatibility` from adapter compatibility score, `overlap` as noisy-or of capability redundancy (`1` = no overlap; each same-capability installed item multiplies downward), `setupCost`/`risk` as 0–1 penalties, then apply `fit = relevance × (0.55 + 0.25 × value + 0.2 × immediacy) × compatibility × overlap` and `score = clamp(100 × (fit − setupCost − risk), 0, 100)`. Hard gates: license missing, `provenance=unknown` with high/critical risk, audit critical, archived maintenance, or incompatible harness force `risky`; capability fully present with enabled installed item forces `redundant` unless candidate is explicitly incompatible or riskier, in which case `risky` still wins.

- [ ] **Step 4: Add no-good-candidates decision**

`decideVerdict` returns `no-good-candidates` when the top candidate score is below the profile threshold, confidence is below `medium`, or no candidate clears hard gates; it never fabricates a required pick to fill output.

- [ ] **Step 5: Run all core tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): add deterministic scoring and verdicts"
```

---

### Task 4: Candidate normalization, artifact probing, and trust policy

**Files:**
- Create: `packages/registry/package.json`, `packages/registry/tsconfig.json`, `packages/registry/src/normalize.ts`, `packages/registry/src/probe.ts`, `packages/registry/src/trust.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/registry/test/normalize.test.ts`, `packages/registry/test/probe.test.ts`, `packages/registry/test/trust.test.ts`

**Interfaces:**
- Consumes: `CandidateSchema`, `Candidate`, `ArtifactType`.
- Produces: `normalizeCandidate(input: RawCandidate): Candidate`; `probeArtifact(input: RawCandidate): ArtifactProbe`; `classifyTrust(candidate: Candidate, evidence: TrustEvidence): "verified" | "curated" | "unverified"`.

- [ ] **Step 1: Write failing artifact-probing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidate, classifyTrust } from "../src/index.js";

test("self-declared topic with no probed artifact is rejected", () => {
  assert.throws(() => normalizeCandidate(rawCandidate({ tags: ["mcp"], artifact: null })));
});

test("official marketplace with pinned version and clean audit classifies verified", () => {
  const candidate = normalizeCandidate(rawCandidate({ artifact: { kind: "mcp", file: "server.json" }, sourceKind: "official-registry", pinnedRef: "1.4.2", license: "MIT", auditStatus: "clean" }));
  assert.equal(classifyTrust(candidate, { maintainerVerified: true, activity: "active" }), "verified");
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- normalize probe trust`
Expected: FAIL.

- [ ] **Step 3: Implement evidence-only normalization**

Map source-specific raw records into `Candidate`; never trust `topics`, `keywords`, `description`, or `README` claims by themselves. Require an artifact probe (`SKILL.md`, plugin manifest, MCP manifest, package manifest, documented release config, or verified marketplace artifact ID) plus immutable `pinnedRef`, license, repository or registry URL, and last-verified timestamp. Keep prompt-injection text in `rawUntrustedCopy` purely for display diagnostics with a fixed label; no scoring field reads it except an explicit `untrustedCopyRisk` boolean.

- [ ] **Step 4: Implement v1 trust policy exactly as the spec**

`classifyTrust` returns `verified` only with official/standards-backed source or verified publisher + pinned immutable ref + active maintenance/recent release + open license + checksum/attestation where supported + no critical audit finding. Return `curated` only when in-repo review evidence is present. Everything else returns `unverified`; popularity alone cannot promote trust.

- [ ] **Step 5: Run registry tests**

Run: `npm test -- normalize probe trust`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/registry packages/core/src
git commit -m "feat(registry): normalize candidates and classify trust"
```

---

### Task 5: Bundled snapshot and on-demand refresh pipeline

**Files:**
- Create: `packages/registry/src/cache.ts`, `packages/registry/src/sources/skills-sh.ts`, `packages/registry/src/sources/mcp-registry.ts`, `packages/registry/src/sources/github.ts`, `packages/registry/src/sources/awesome-lists.ts`
- Create: `packages/cli/src/commands/registry-refresh.ts`, `packages/registry/src/snapshot.ts`
- Modify: `package.json`, `packages/registry/package.json`
- Test: `packages/registry/test/cache.test.ts`, `packages/registry/test/snapshot.test.ts`

**Interfaces:**
- Consumes: `normalizeCandidate`, `classifyTrust`, `CandidateSchema`.
- Produces: `buildSnapshot(sources): RegistrySnapshot`; `refreshSnapshot({ cacheDir, limit }): Promise<RefreshResult>`; snapshot file `registry-snapshot.json` with `{ schemaVersion, generatedAt, candidates, provenance }`.

- [ ] **Step 1: Write failing snapshot round-trip tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, parseSnapshot } from "../src/index.js";

test("snapshot is deterministic and timestamped", () => {
  const a = buildSnapshot([candidate], new Date("2026-11-08T00:00:00Z"));
  const b = parseSnapshot(JSON.stringify(a));
  assert.deepEqual(a, b);
  assert.equal(a.schemaVersion, 1);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- snapshot cache`
Expected: FAIL.

- [ ] **Step 3: Implement snapshot build/parse with provenance**

Snapshot generation sorts candidates by stable ID, strips volatile stats into `volatility` buckets, records source URL + retrieval timestamp + trust classification, and validates the whole file with Zod. The bundled snapshot is a generated artifact committed separately from source code; tests assert schema and stability but not network contents.

- [ ] **Step 4: Implement refresh with graceful degradation**

`registry refresh` fetches only configured public sources with timeout, ETag/last-modified where available, and per-source failure isolation. On total network failure it exits 2 with zero cache mutation; on partial failure it writes the refreshed subset and records failures in the cache manifest; stale candidates remain marked with `lastVerified` age rather than silently becoming “fresh.”

- [ ] **Step 5: Run registry tests**

Run: `npm test -- snapshot cache`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/registry packages/cli/src/commands/registry-refresh.ts
git commit -m "feat(registry): build snapshot and refresh cache safely"
```

---

### Task 6: OpenCode adapter inventory

**Files:**
- Create: `packages/adapters/opencode/package.json`, `packages/adapters/opencode/tsconfig.json`, `packages/adapters/opencode/src/*.ts`
- Test: `packages/adapters/opencode/test/detect.test.ts`, `packages/adapters/opencode/test/inventory.test.ts`, `fixtures/opencode/*.json`

**Interfaces:**
- Produces: `OpenCodeAdapter` implementing `HarnessAdapter`: `detect`, `inventory`, `compatibility`, `installPlan`, `applyPlan`, `rollback`.

- [ ] **Step 1: Write failing OpenCode inventory fixtures**

Create fixtures for: (a) empty harness, (b) `.opencode/plugins/local-plugin.ts`, (c) npm plugin entry in `opencode.json`, (d) project and global skills with malformed frontmatter, (e) MCP servers configured in `opencode.json`, (f) invalid JSON with recovery to `unknown` inventory plus warning.

```ts
test("invalid opencode config does not crash inventory", async () => {
  const adapter = new OpenCodeAdapter({ home: fixture("invalid-config") });
  const inventory = await adapter.inventory();
  assert.equal(inventory.status, "partial");
  assert.ok(inventory.warnings.length > 0);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- opencode`
Expected: FAIL.

- [ ] **Step 3: Implement detection and inventory normalization**

Read `opencode.json`, `opencode.jsonc`, global config paths, `.opencode/plugins`, and project/global skill roots. Parse JSONC tolerantly; on parse failure return partial inventory with `unknown` enabled state and warning. Normalize plugins/skills/MCP/hooks/commands to `CapabilityRecord` with config references but no secret values; never execute discovered plugins.

- [ ] **Step 4: Implement compatibility and plan stub**

`compatibility` returns score 1 for skills/npm plugins/MCP with valid config, 0 for impossible harness mismatch, fractional otherwise. `installPlan` returns verified OpenCode `skills add`/`npm plugin add` plan when candidate trust is verified and artifact type is supported; otherwise manual recipe. `applyPlan` is Task 13 scope; leave it throwing `Inventory-only milestone` until Task 13.

- [ ] **Step 5: Run OpenCode tests**

Run: `npm test -- opencode`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/opencode fixtures/opencode
git commit -m "feat(opencode): inventory harness capabilities"
```

---

### Task 7: Claude Code adapter inventory

**Files:**
- Create: `packages/adapters/claude-code/package.json`, `packages/adapters/claude-code/tsconfig.json`, `packages/adapters/claude-code/src/*.ts`
- Test: `packages/adapters/claude-code/test/inventory.test.ts`, `fixtures/claude-code/*.json`

**Interfaces:**
- Produces: `ClaudeCodeAdapter` implementing the same `HarnessAdapter` contract as Task 6.

- [ ] **Step 1: Write failing Claude inventory fixtures**

Fixtures must cover user/project/local-scope enabled plugins, marketplace metadata, `.claude/skills`, `.claude/agents`, hooks, commands, MCP servers from `~/.claude.json` and project `.mcp.json`, malformed settings, and disabled-but-installed plugins.

- [ ] **Step 2: Verify red**

Run: `npm test -- claude-code`
Expected: FAIL.

- [ ] **Step 3: Implement normalization**

Compute enabled/disabled/unknown states without executing hooks or MCP servers. Record component kinds separately (`skill`, `command`, `hook`, `mcp`, `agent`, `plugin`) because context cost differs. Preserve marketplace source and pinned version where present; missing/malformed fields are unknown, not guessed.

- [ ] **Step 4: Implement compatibility**

Official/community marketplace + supported component kinds score high; unverified third-party plugin scores compatibility but trust remains non-verified; missing pinned ref caps compatibility below automatic-install threshold.

- [ ] **Step 5: Run Claude tests**

Run: `npm test -- claude-code`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/claude-code fixtures/claude-code
git commit -m "feat(claude-code): inventory plugins skills hooks and mcp"
```

---

### Task 8: Codex adapter inventory and recipe-only mutation posture

**Files:**
- Create: `packages/adapters/codex/package.json`, `packages/adapters/codex/tsconfig.json`, `packages/adapters/codex/src/*.ts`
- Test: `packages/adapters/codex/test/inventory.test.ts`, `fixtures/codex/*.toml`, `fixtures/codex/*.json`

**Interfaces:**
- Produces: `CodexAdapter` implementing `HarnessAdapter`; public readonly `installVerified = false`.

- [ ] **Step 1: Write failing Codex fixtures**

Fixtures: global/project `config.toml`, `~/.agents/skills` and project `.agents/skills`, plugin configuration, MCP server entries, malformed TOML/JSON, unknown fields, and duplicate capability across roots.

- [ ] **Step 2: Verify red**

Run: `npm test -- codex`
Expected: FAIL.

- [ ] **Step 3: Implement read-only detection/inventory**

Parse TOML/JSON defensively without dependencies that execute plugin code. Normalize roots and enabled state; unknown sections survive as warnings. Do not infer missing credentials; record env-var names only.

- [ ] **Step 4: Force recipe-only plans**

`installPlan` always returns `installMode: "manual"` with exact files/commands and a warning that live Codex mutation is unverified; `applyPlan` throws unless `installVerified === true`, which no shipped v1 build may flip before live verification and review. Add a test asserting that flipping the flag without verification is impossible to express in fixtures.

- [ ] **Step 5: Run Codex tests**

Run: `npm test -- codex`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/codex fixtures/codex
git commit -m "feat(codex): detect and inventory safely"
```

---

### Task 9: Cursor adapter inventory and recipe-only mutation posture

**Files:**
- Create: `packages/adapters/cursor/package.json`, `packages/adapters/cursor/tsconfig.json`, `packages/adapters/cursor/src/*.ts`
- Test: `packages/adapters/cursor/test/inventory.test.ts`, `fixtures/cursor/*.json`

**Interfaces:**
- Produces: `CursorAdapter` implementing `HarnessAdapter`; public readonly `installVerified = false`.

- [ ] **Step 1: Write failing Cursor fixtures**

Fixtures cover documented Cursor MCP configuration locations, project/user scope where present, absent directories, malformed config, and candidate artifacts that claim Cursor compatibility without config evidence.

- [ ] **Step 2: Verify red**

Run: `npm test -- cursor`
Expected: FAIL.

- [ ] **Step 3: Implement detection/inventory**

Use only current documented config paths; make paths injectable for fixtures. Parse defensively, never start MCP servers, and return partial inventory with warnings for unknown schemas. Compatibility distinguishes `documented`, `inferred`, and `unknown`; inferred/unknown cannot become verified-install paths.

- [ ] **Step 4: Force recipe-only plans**

As in Task 8, every `installPlan` is manual with exact edits/commands and Cursor compatibility label; no code path permits automatic mutation in v1.

- [ ] **Step 5: Run Cursor tests**

Run: `npm test -- cursor`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/cursor fixtures/cursor
git commit -m "feat(cursor): detect and inventory safely"
```

---

### Task 10: v1 use-case profiles and corroboration resolver

**Files:**
- Create: `packages/profiles/package.json`, `packages/profiles/tsconfig.json`, `packages/profiles/src/schema.ts`, `packages/profiles/src/resolve.ts`, `packages/profiles/src/index.ts`, `packages/profiles/profiles/*.yaml`
- Modify: none
- Test: `packages/profiles/test/resolve.test.ts`, `packages/profiles/test/profiles.test.ts`

**Interfaces:**
- Produces: `V1Profile`, `UseCaseProfileSchema`, `resolveProfile({ declaration, projectSignals }): ProfileResolution`; profile YAMLs for software-development, video-editing, research-writing, data-analysis, devops-infrastructure, design-frontend.

- [ ] **Step 1: Write failing resolver tests**

```ts
test("video editing in an unrelated python repo asks for corroboration instead of overriding", () => {
  const result = resolveProfile({ declaration: "video-editing", projectSignals: ["python-manifest", "pytest"] });
  assert.equal(result.status, "contradiction");
  assert.equal(result.requiresQuestion, true);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- profiles`
Expected: FAIL.

- [ ] **Step 3: Author six versioned profiles**

Each YAML includes canonical capability IDs, 5–12 signal queries, negative signals, default domains, and expected value tiers. `video-editing` must include `media.transcode`, `speech.captions`, `design.thumbnail` (added to taxonomy), publishing and optional cleanup domains; it must not include generic coding domains without a signal.

- [ ] **Step 4: Implement contradiction-never-override**

Resolver returns `match`, `partial`, `contradiction`, or `unknown`. Contradictions always set `requiresQuestion: true` and no search executes until the agent/user resolves the mismatch; project signals never silently replace `declaration`.

- [ ] **Step 5: Run profile tests**

Run: `npm test -- profiles`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/profiles
git commit -m "feat(profiles): add v1 use-case profiles and corroboration"
```

---

### Task 11: CLI inventory, registry, and recommend commands

**Files:**
- Modify: `packages/cli/package.json`, `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/inventory.ts`, `packages/cli/src/commands/recommend.ts`, `packages/cli/src/commands/explain.ts`, `packages/cli/src/commands/profiles-validate.ts`, `packages/cli/src/output.ts`
- Test: `packages/cli/test/recommend.test.ts`, `packages/cli/test/inventory.test.ts`, `packages/cli/test/explain.test.ts`

**Interfaces:**
- Consumes: `OpenCodeAdapter`, `ClaudeCodeAdapter`, `CodexAdapter`, `CursorAdapter`, `loadSnapshot`, `scoreCandidate`, profiles, profile schema.
- Produces: `plugin-detector inventory [--json]`, `plugin-detector recommend --use-case <id> [--json]`, `plugin-detector explain <candidate-id>`, `plugin-detector profiles validate <file>`; output always separates `facts`, `estimates`, and `untrustedCopy`.

- [ ] **Step 1: Write failing CLI behavior tests**

Use fixture HOME trees and injected clock/network. Assert: empty harness returns all inventories as empty records; recommend returns at most five candidates; no-good-candidates path emits the exact verdict; explain prints component breakdown; `--json` has schema-validated keys; recommend performs zero writes (assert fixture tree hash before/after).

- [ ] **Step 2: Verify red**

Run: `npm test -- cli`
Expected: FAIL.

- [ ] **Step 3: Implement inventory command**

Auto-detect all four harnesses, merge partial inventories without claiming conflicts, print concise enabled/disabled/unknown counts and config reference paths with secrets redacted. JSON output is Zod-validated.

- [ ] **Step 4: Implement recommend command**

Load declared profile (must call `resolveProfile`; contradiction exits with `needs-clarification` and no candidate output), load snapshot (bundled default, cache override), normalize candidates, score against inventory, apply hard gates, and emit top ≤5 with evidence pointers. Include explicit `No good candidates found.` output when resolver/scorer cannot justify one.

- [ ] **Step 5: Implement explain command**

Print pinned ref, source, trust class, score components, overlap records, risk flags, and snapshot age. `rawUntrustedCopy` is shown only behind `--show-untrusted` with a warning header.

- [ ] **Step 6: Implement profiles validate command**

Validate one YAML profile file against `UseCaseProfileSchema`; print field errors in a table and exit 1 on any error; never fetch network.

- [ ] **Step 7: Run CLI tests**

Run: `npm test -- cli`
Expected: PASS; fixture trees unchanged except intended stdout/stderr behavior.

- [ ] **Step 8: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): inventory recommend and explain without writes"
```

---

### Task 12: Portable SKILL.md and agent consent contract

**Files:**
- Create: `packages/skill/package.json`, `packages/skill/SKILL.md`, `packages/skill/agents/openai.yaml`, `packages/skill/assets/verdict-template.md`, `packages/skill/scripts/plugin-detector`
- Modify: `.gitignore`
- Test: `packages/cli/test/skill-contract.test.ts`, `packages/skill/test/skill.test.ts`

**Interfaces:**
- Produces: Skill instructions that call the CLI but never bypass it; exact install consent sequence; artifact output template.

- [ ] **Step 1: Write failing contract tests**

Assert `SKILL.md` contains the no-write gate, the four supported harnesses, the approval-token rule, and never instructs the agent to execute candidate code or install unverified items automatically. Assert template includes required evidence pointers and unverified labels.

- [ ] **Step 2: Verify red**

Run: `npm test -- skill-contract`
Expected: FAIL.

- [ ] **Step 3: Write the skill deliberation procedure**

Procedure: invoke only on demand; declare and corroborate use case; call `inventory`; ask missing clarifiers one question at a time; call `recommend`; show evidence/reasoning; present accept/adopt-scoped/reject options; on approval, create a one-shot candidate-scoped token via CLI `approve --candidate <id> --plan <hash>`; then invoke install; never install unapproved/unverified candidates; no scheduled runs or background work.

- [ ] **Step 4: Add agents metadata and thin wrapper**

Wrapper is a POSIX shell shim that resolves `npx plugin-detector` or installed binary; it contains no logic and is executable. `agents/openai.yaml` declares the skill display name, short description, and default prompt using the v1 product language.

- [ ] **Step 5: Run skill tests**

Run: `npm test -- skill`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/skill .gitignore
git commit -m "feat(skill): add portable consent-gated harness skill"
```

---

### Task 13: Consent tokens and install execution for OpenCode/Claude

**Files:**
- Create: `packages/core/src/approval.ts`, `packages/core/src/install.ts`, `packages/cli/src/commands/approve.ts`, `packages/cli/src/commands/install.ts`
- Modify: `packages/adapters/opencode/src/plans.ts`, `packages/adapters/claude-code/src/plans.ts`
- Test: `packages/core/test/approval.test.ts`, `packages/core/test/install.test.ts`, `packages/cli/test/install.test.ts`

**Interfaces:**
- Produces: `createApprovalToken({ candidateId, planHash, ttlMs? }): ApprovalToken`; `verifyApprovalToken(token, plan): ApprovalResult`; `applyInstallPlan(plan, approval, adapter): InstallReceipt`.

- [ ] **Step 1: Write failing consent tests**

Cover missing/expired/candidate-mismatched/plan-mismatched/reused token, TTY approval path, non-TTY without token, untrusted candidate manual recipe, write failure restore, parse-back validation failure restore, and 100% rollback path execution.

```ts
test("reused approval token performs zero writes", async () => {
  const plan = makePlan(); const token = approve(plan);
  await applyInstallPlan(plan, token, adapter);
  await assert.rejects(applyInstallPlan(plan, token, adapter));
  assert.deepEqual(tree(home), before);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- approval install`
Expected: FAIL.

- [ ] **Step 3: Implement one-shot scoped tokens**

Store tokens in a 0600 file under managed state with candidate ID, SHA-256 plan hash, expiry, nonce, and `usedAt`. TTL defaults to 10 minutes and is capped at 30. Verification hashes exactly the plan and consumes atomically; no `--yes` path bypasses verification. TTY prompt explicitly prints candidate name, source, trust label, operations, and rollback.

- [ ] **Step 4: Implement verified OpenCode/Claude writers**

OpenCode: write global/project config only through documented config merge; project skills may use `npx skills add` only after token verification; backup exact preimages; parse JSONC/JSON after write; rollback byte-for-byte. Claude Code: use verified marketplace/plugin command path when documented and available, else recipe-only; backup settings/config; never call hooks during install validation. Unverified candidates print a recipe and exit without mutation.

- [ ] **Step 5: Run install/rollback tests**

Run: `npm test -- approval install`
Expected: PASS; every write test asserts rollback success on failure.

- [ ] **Step 6: Commit**

```bash
git add packages/core packages/cli packages/adapters
git commit -m "feat(install): add consent tokens and verified writers"
```

---

### Task 14: Red-team and drift fixtures

**Files:**
- Create: `fixtures/red-team/*.json`, `fixtures/red-team/*.md`, `packages/cli/test/red-team.test.ts`, `packages/core/test/provenance.test.ts`
- Modify: `packages/registry/src/probe.ts`, `packages/registry/src/trust.ts`

**Interfaces:**
- Produces: `runRedTeamFixtures({ fixtureRoot }): RedTeamResult[]`; CI-visible failure when any hostile fixture yields `required`/automatic install.

- [ ] **Step 1: Write failing hostile fixtures**

Required fixtures: prompt-injection README, typo-squat package, archived-but-popular repo, repo renamed with old links, dependency-confusion name, malicious `postinstall`, MCP with shell/exec language, silent capability drift (tag same, manifest changed), stale audit, and impossible Cursor auto-install claim.

- [ ] **Step 2: Verify red**

Run: `npm test -- red-team provenance`
Expected: FAIL on at least one fixture.

- [ ] **Step 3: Tighten gates only where tests demand**

Add drift detection tolerance checks (tag/manifest changed = re-review), reserved-name/dependency-confusion blocking by known namespace, archive/stale hard gates, and suppression of automatic handling for shell/exec metadata. Do not add heuristics without a fixture.

- [ ] **Step 4: Run red-team suite**

Run: `npm test -- red-team provenance`
Expected: PASS; print report of fixtures and outcomes.

- [ ] **Step 5: Commit**

```bash
git add fixtures/red-team packages
git commit -m "test(security): add hostile candidate fixtures"
```

---

### Task 15: Recommendation benchmark and precision@5 gate

**Files:**
- Create: `packages/cli/src/commands/benchmark.ts`, `fixtures/benchmark/workflows/*.yaml`, `fixtures/benchmark/baselines/popular-repo.json`, `packages/cli/test/benchmark.test.ts`, `docs/benchmark.md`
- Modify: `packages/cli/src/index.ts`, `packages/cli/package.json`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `plugin-detector benchmark` report and CI job `benchmark`; documented protocol and owner-review process.

- [ ] **Step 1: Write failing benchmark harness tests**

Assert benchmark runner computes true-positive required artifacts per workflow, false-positive low-value recommendations, precision@5, and baseline delta; fails CI when any low-value/popular-but-irrelevant candidate is returned as required.

- [ ] **Step 2: Add 30 labeled workflow fixtures**

Author six workflows per research domain: software-development, video-editing, research-writing, data-analysis, devops-infrastructure, design-frontend. Each fixture includes declaration, fixture harness inventory, expected required/optional/redundant IDs or ID patterns, unacceptable popular-but-irrelevant IDs, and label rationale. Existing research sources inform expected candidates, but labels must not leak hidden answers into runtime code.

- [ ] **Step 3: Create fixed popular baseline**

`popular-repo.json` is a hand-frozen list of top relevant repos by raw GitHub/skills.sh popularity with no fit filtering; benchmark compares the engine against it on identical fixtures.

- [ ] **Step 4: Implement report and CI gate**

`plugin-detector benchmark --fixtures fixtures/benchmark --fail-on-low-value` prints workflow-level precision@5, baseline beat/fail, and every offending recommendation. CI runs it as a non-secret job; no network required.

- [ ] **Step 5: Document owner review protocol**

`docs/benchmark.md` lists how labels are reviewed, how a label changes (rationale + commit), and what “low-value” means. State plainly that passing CI does not prove safety; it proves the recommendation gate defined by this project.

- [ ] **Step 6: Run benchmark**

Run: `npm test -- benchmark && npx plugin-detector benchmark --fixtures fixtures/benchmark --fail-on-low-value`
Expected: PASS before v1.0.

- [ ] **Step 7: Commit**

```bash
git add fixtures/benchmark docs/benchmark.md packages/cli .github/workflows/ci.yml
git commit -m "test(benchmark): add precision@5 recommendation gate"
```

---

### Task 16: Release packaging, docs, and final acceptance

**Files:**
- Create: `README.md`, `.github/GITHUB_RELEASE_NOTES.template`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `.github/workflows/release.yml`, `docs/adapters.md`, `docs/security-model.md`, `docs/profile-schema.md`
- Modify: `package.json`, `.npmrc`, `README.md` (existing), `LICENSE` (create MIT license)
- Test: `packages/cli/test/release.test.ts`, `docs/*` reviewed manually

**Interfaces:**
- Produces: provenance npm release workflow, v0.1/0.5/1.0 tags, installation quick starts, adapter matrix, security disclosure path.

- [ ] **Step 1: Write release metadata test**

Assert package exports only intended binaries, files includes skill/snapshot/docs, `publishConfig.access=public`, `license=MIT`, `engines.node>=22`, and no dev-only/private files are packed (`npm pack --dry-run`).

- [ ] **Step 2: Write OSS docs**

README includes one-line promise, four-harness quick start, no-auto-install safety model, sample recommendation, manual install recipe, benchmark summary, and links to security/contributing. Adapter matrix honestly labels OpenCode/Claude Code verified where applicable and Codex/Cursor recipe-only until live verification.

- [ ] **Step 3: Configure release workflow**

Tag `v*` triggers release: clean checkout, setup-node 22, `npm ci`, full tests, benchmark, build, `npm pack`, npm publish with `--provenance`, GitHub Release with checksums and signed tag notes. No publish runs on PRs. Before `1.0`, the release checklist additionally requires: `npm run registry:refresh` against live public sources, review of generated `registry-snapshot.json`, explicit approval of the reviewed diff, and commit/pin of `registry-snapshot.json` with its `generatedAt` timestamp; no v1.0 artifact may ship without that artifact.

- [ ] **Step 4: Run final acceptance commands**

Run: `npm ci && npm run typecheck && npm test && npm run build && npm audit --omit=dev && npm pack --dry-run && npx plugin-detector inventory --json`
Expected: PASS; pack output contains no tokens, caches, fixtures with personal paths, or secrets.

- [ ] **Step 5: Self-review spec coverage**

Check every spec section against Tasks 1–15; any uncovered requirement is added here as a concrete task before commit. Update changelog with v0.1.0 and unresolved v1.0 gates explicitly.

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md CHANGELOG.md docs package.json .npmrc .github/workflows/release.yml packages/cli/test/release.test.ts
git commit -m "docs(release): add production OSS release surface"
```

---

## Execution notes

- Native implementation can proceed task-by-task in this session; subagent-driven execution should use one fresh implementer and one fresh reviewer per task, then a whole-branch review after Task 16.
- Tasks 13 and 15 are the release-blocking surfaces; do not advance to release work with either failing.
- Codex and Cursor remain recipe-only in v1 unless live verification plus review flips `installVerified` in a dedicated follow-up PR.

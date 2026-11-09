# plugin-detector v1.0 Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live discovery trustworthy: every recommendation carries real artifact evidence, expanded GitHub/skills.sh/registry harvesting works against live APIs, and the release ships a reviewed, probed registry snapshot rather than placeholders.

**Architecture:** Extend the registry source layer from “listing parser” to “listing + evidence probe.” Source adapters discover candidate references; a separate prober fetches the referenced artifact (skills.sh blob, GitHub raw manifest, npm/PyPI metadata), verifies its identity, infers capabilities only from that evidence, and records provenance. The snapshot builder stores only probed candidates as recommendable; unprobed/refused candidates remain visible in the manifest for review.

**Tech Stack:** Existing TypeScript/Node 22 monorepo, `node:test`, global `fetch`, Zod, GitHub REST API, skills.sh API, official MCP registry v0, npm registry and PyPI JSON APIs.

**Spec:** `docs/superpowers/specs/2026-11-08-plugin-detector-design.md` (authority) and the v1.0 roadmap in the release notes/CHANGELOG.

## Global Constraints

- Local-first and deterministic: no LLM in the CLI; network only on explicit `registry refresh`/`recommend --refresh` invocations, with cache-first behavior.
- No source listing field may become scoring evidence. Only fetched, validated artifacts can set `artifactProbed: true` and capabilities.
- Unprobed candidates stay visible for review but cannot be `required` or auto-installed.
- All network calls use timeout, conditional validators where supported, response size limits, and per-source/per-candidate isolation.
- Optional `GITHUB_TOKEN` may raise rate limits but is never required and never written/logged.
- Never execute downloaded code; never run package install scripts or MCP servers.
- Secrets and credentials are never recorded; env-var names only.
- Existing consent gate, plan→approve→install→rollback flow, release workflow, and MIT/provenance rules must not weaken.
- Full suite, benchmark, typecheck, build, audit, pack, and inventory smoke tests stay green.

## Review Focus

1. **Listing-only candidate leaks into recommendations** — test every source with a non-probed record and assert `recommend` excludes it (Task 9–10).
2. **Artifact mismatch** — a repo/package whose fetched manifest name/version does not match the listing must be rejected, not merged (Tasks 5–6).
3. **Source non-empty but unparseable** — must be recorded as source failure and must not erase previous candidates (Task 9).
4. **Rate-limit/offline degradation** — cache and prior snapshot still answer; partial refresh records failures; no crash (Tasks 2, 9).
5. **Prompt-injected artifact text** — fetched README/SKILL.md text is untrusted and cannot become an install instruction or fields; only bounded evidence snippets are stored (Tasks 5, 7).
6. **Capability inference overreach** — no generic substring guessing; every capability must map to explicit taxonomy keywords and evidence, else candidate remains unclassified and cannot be required (Task 7).
7. **Snapshot reproducibility** — same inputs produce byte-identical snapshot given fixed clock; dedupe and source provenance stable (Tasks 9–11).

---

### Task 1: Source and evidence contract

**Files:**
- Modify: `packages/registry/src/probe.ts`, `packages/registry/src/types.ts` (create if absent), `packages/registry/src/index.ts`
- Test: `packages/registry/test/evidence-contract.test.ts`

**Interfaces:**
- Produces: `ArtifactEvidence` type `{ kind: "skill"|"plugin"|"mcp-server"|"tool"; sourceUrl: string; resolvedRef: string; contentHash: string; license: string; name?: string; version?: string; capabilities: string[]; evidenceSnippets: string[]; retrievedAt: string }`; `RawCandidate.artifactProbe?: ArtifactEvidence`; source query plan types.

- [ ] **Step 1: Write failing contract tests**

```ts
test("a listing alone cannot produce artifact evidence", () => {
  const raw = makeRaw({ artifactProbed: false });
  assert.equal(raw.artifactProbe, undefined);
});
test("artifact evidence requires content hash and resolved ref", () => {
  assert.throws(() => ArtifactEvidenceSchema.parse({ kind: "skill" }));
});
```

- [ ] **Step 2: Verify red** — `npm test -- evidence-contract` fails on missing types.
- [ ] **Step 3: Implement exact types/schema** — add `ArtifactEvidenceSchema` (Zod) with required `kind`, `sourceUrl`, `resolvedRef`, `contentHash`, `license`, `retrievedAt`; optional name/version/capabilities/evidenceSnippets. Keep `artifactProbed` derived from presence of `artifactProbe`; no parallel mutable flags.
- [ ] **Step 4: Run focused tests** — `npm test -- evidence-contract` passes.
- [ ] **Step 5: Commit** — `git add packages/registry && git commit -m "feat(registry): define artifact evidence contract"`.

---

### Task 2: Resilient HTTP client and rate limiting

**Files:**
- Modify: `packages/registry/src/sources/http.ts`
- Test: `packages/registry/test/http.test.ts`

**Interfaces:**
- Produces: `httpGetJson<T>(url, opts)`, `httpGetText(url, opts)` with `timeoutMs`, `maxBytes`, `etag`, `lastModified`, `headers`, `fetchImpl`; `RateLimiter` with `acquire(): Promise<void>`; `SourceHttpError` with `status`, `url`, `retryable`.

- [ ] **Step 1: Write failing tests** — cover timeout, non-OK status, body > `maxBytes`, retryable 429/5xx, non-retryable 401/404, ETag 304, and that `Authorization` header values never appear in thrown messages.
- [ ] **Step 2: Verify red** — `npm test -- http` fails.
- [ ] **Step 3: Implement** — 15s default timeout, 2 retries with bounded exponential delay for 429/5xx, respect `Retry-After` when numeric, 5 MiB default text cap, content-type validation per caller, request rate limiter (default 5 concurrent, 10 req/min for GitHub search, 60 req/min for raw/registry). Accept optional token from caller, never read env inside the module.
- [ ] **Step 4: Run test + typecheck** — `npm test -- http && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "feat(registry): harden source HTTP client"`.

---

### Task 3: Real skills.sh search and blob probing

**Files:**
- Modify: `packages/registry/src/sources/skills-sh.ts`
- Create: `packages/registry/src/probe-skills-sh.ts`
- Test: `packages/registry/test/skills-sh.test.ts`
- Fixtures: `fixtures/registry/skills-sh-search.json`, `fixtures/registry/skills-sh-download.json`

**Interfaces:**
- Produces: `fetchSkillsSh({ queries, get }): Promise<SourceFetch>`; `probeSkillsSh(raw, get): Promise<RawCandidate>`; query set from `DEFAULT_SKILL_QUERIES` (agent, mcp, claude, testing, review, video, design, data, docs).

- [ ] **Step 1: Write failing tests** — search endpoint is `/api/search?q=<query>` (captured live shape), dedupe by `id`, download endpoint `/api/download/{owner}/{repo}/{slug}` returns `{files,hash}`, valid `SKILL.md` frontmatter → evidence; missing/invalid → throws `ARTIFACT_MISSING`; merged query results dedupe.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement search** — replace the 404 `/api/skills` endpoint with `/api/search?q=`. Each query yields `skills[]` with `id`, `source`, `skillId`, `name`, `installs`; map to raw candidate with repository `https://github.com/<source>`; cap total unique candidates at 400, rate limited.
- [ ] **Step 4: Implement download probe** — split `source` owner/repo and slug from `skillId`; fetch blob; require `SKILL.md`; parse frontmatter; require name matching listing `skillId` (case-insensitive, separator-normalized) or exact download hash; record `resolvedRef` as `skills.sh:<hash>`; content hash SHA-256; capabilities filled by Task 7, not here.
- [ ] **Step 5: Tests green + commit** — `git commit -am "feat(registry): probe skills.sh artifacts"`.

---

### Task 4: Expanded GitHub query plan and pagination

**Files:**
- Modify: `packages/registry/src/sources/github.ts`
- Test: `packages/registry/test/github.test.ts`
- Fixtures: `fixtures/registry/github-search.json`

**Interfaces:**
- Produces: `GITHUB_TOPIC_QUERIES` (mcp, mcp-server, claude-plugin, claude-code-plugin, opencode-plugin, agent-skill, llm-tools), `fetchGithub({ queries, token, get })`, `parseGithubSearch` carrying `defaultBranch`, `stars`, `pushedAt`, `license`, `description`; profile-derived query terms may be appended by the refresh command.

- [ ] **Step 1: Write failing tests** — 7 independent queries, `per_page=100&page=1..3` pagination cap, `GITHUB_TOKEN` sent only as Authorization, dedupe by `full_name`, missing `default_branch` defaults to `HEAD` but is flagged, rate-limit failure does not erase other queries.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — run independent queries with `RateLimiter`, max 3 pages each, cap 500 unique repos; parse `stargazers_count`, `pushed_at`, `default_branch`, `license.spdx_id`; never use topics as capabilities.
- [ ] **Step 4: Tests green + commit** — `git commit -am "feat(registry): expand github discovery queries"`.

---

### Task 5: GitHub artifact prober

**Files:**
- Create: `packages/registry/src/probe-github.ts`
- Modify: `packages/registry/src/sources/github.ts`, `packages/registry/src/sources/awesome-lists.ts`
- Test: `packages/registry/test/probe-github.test.ts`

**Interfaces:**
- Produces: `probeGithub(raw, get): Promise<RawCandidate>`; tries in order: `SKILL.md`, `.claude-plugin/plugin.json`, `plugin.json`, `package.json`, `server.json`; returns ArtifactEvidence; sets artifactType `skill|plugin|mcp-server|tool`; throws typed `PROBE_*` errors.

- [ ] **Step 1: Write failing fixtures** — valid skill, valid plugin manifest, valid package.json, MCP server.json, missing artifact, mismatched name, archived repo, giant file, non-UTF8.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement raw fetch** — `https://raw.githubusercontent.com/{owner}/{repo}/{resolvedRef}/{path}`; try branch `defaultBranch`, then `HEAD`; max 256 KiB per manifest; reject symlinks/redirect to non-GitHub; require manifest name/package name match listing ID or exact repo; license from manifest/package; content hash from bytes; never store full body, only bounded snippets (≤2, 300 chars).
- [ ] **Step 4: Capability inference hook** — call `inferCapabilities` (Task 7) on validated text; no capability if no explicit keyword.
- [ ] **Step 5: Tests green + commit** — `git commit -am "feat(registry): probe GitHub artifacts"`.

---

### Task 6: npm/PyPI metadata prober for MCP and package artifacts

**Files:**
- Create: `packages/registry/src/probe-package.ts`, `packages/registry/src/sources/package-registries.ts`
- Test: `packages/registry/test/probe-package.test.ts`
- Fixtures: `fixtures/registry/npm-package.json`, `fixtures/registry/pypi-package.json`

**Interfaces:**
- Produces: `probePackage(packageName, version, { get }): Promise<ArtifactEvidence>`; `parseNpmRegistry`, `parsePypiRegistry`; handles scoped packages, dist-tags, latest version, license, repository, homepage, maintainers, deprecated flag, `dist.tarball` (metadata only; never fetch/execute).

- [ ] **Step 1: Write failing tests** — npm scoped package, PyPI project, missing version, deprecated package, license missing, repository mismatch, 404.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — npm `https://registry.npmjs.org/{name}` (URL-encode scoped name), PyPI `https://pypi.org/pypi/{name}/json`; require version exists; record `resolvedRef`, license, repository, maintainer names; only these feed evidence.
- [ ] **Step 4: Tests green + commit** — `git commit -am "feat(registry): probe npm and pypi package metadata"`.

---

### Task 7: Deterministic capability inference and taxonomy expansion

**Files:**
- Modify: `packages/core/src/taxonomy.ts`, `packages/registry/src/normalize.ts`
- Create: `packages/registry/src/classify.ts`
- Test: `packages/core/test/taxonomy.test.ts`, `packages/registry/test/classify.test.ts`

**Interfaces:**
- Produces: `inferCapabilities(text: string, artifactName: string): { capabilities: string[]; evidence: string[] }`; taxonomy additions for `data.database`, `browser.automation`, `search.web`, `cloud.infra`, `media.video`, `media.image`, `collaboration.chat` as needed by evidence fixtures.

- [ ] **Step 1: Write failing tests** — explicit terms map; ambiguous term does not map; two capabilities require two evidence snippets; no match → empty; every returned ID is canonical; hidden Unicode/prompt injection text is ignored.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement keyword table** — each capability has 2–6 explicit regex phrases and a minimum evidence length. Match against name + bounded description + manifest keywords only; never use README secrets or arbitrary text. Return snippets with offsets.
- [ ] **Step 4: Tests green + commit** — `git commit -am "feat(registry): infer capabilities from probed evidence"`.

---

### Task 8: Trust evidence and publisher policy

**Files:**
- Modify: `packages/registry/src/trust.ts`, `packages/registry/src/normalize.ts`, `packages/registry/src/cache.ts`
- Test: `packages/registry/test/trust.test.ts`, `packages/registry/test/publisher-policy.test.ts`

**Interfaces:**
- Produces: `OFFICIAL_PUBLISHERS` (exact GitHub orgs and npm/pypi namespaces approved for v1), `classifyTrust` using probed evidence + publisher policy + pinned ref + license + active maintenance; no listed-only verification.

- [ ] **Step 1: Write failing tests** — official MCP registry + official org → verified; community probed repo → unverified; publisher without evidence → unverified; archived → unverified/risky; missing license → unverified; no listing-only verified path.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement exact policy** — allowlist only explicit known-official orgs (`anthropics`, `modelcontextprotocol`, `vercel-labs`, `microsoft`, `supabase`, `playwright`, `github`, etc.) and official registry provenance; verify through `artifactProbe`; never use stars as trust.
- [ ] **Step 4: Tests green + commit** — `git commit -am "feat(registry): require probed evidence for trust"`.

---

### Task 9: Refresh integration and snapshot semantics

**Files:**
- Modify: `packages/registry/src/cache.ts`, `packages/registry/src/snapshot.ts`, `packages/cli/src/commands/registry-refresh.ts`
- Test: `packages/registry/test/cache.test.ts`, `packages/registry/test/snapshot.test.ts`, `packages/cli/test/registry-refresh.test.ts`

**Interfaces:**
- Produces: refresh pipeline `discover → probe → normalize → dedupe → snapshot`; `refreshSnapshot({ cacheDir, useCase? })` appends profile-derived query terms to source queries; `RegistrySnapshot` candidates only probed records; `cache-manifest.json` retains unprobed/rejected with reason; source failure preserved; `plugin-detector registry refresh [--use-case <id>]`.

- [ ] **Step 1: Write failing tests** — listing-only candidates excluded from snapshot but listed in manifest; two sources same ID dedupe and merge sources; probe failure preserves prior probed candidate; non-empty parse failure preserves prior source; deterministic snapshot with fixed clock; zero candidates is valid only if all sources empty.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement** — probe each discovered candidate with bounded concurrency (4), cache results by URL+ref+hash, dedupe ID with source precedence official > publisher > community, merge provenance; `buildSnapshot` only entry with `artifactProbe`; preserve `lastVerified`; `--use-case` adds profile signal terms to source queries but never changes evidence thresholds.
- [ ] **Step 4: Tests green + commit** — `git commit -am "feat(registry): integrate evidence probing into refresh"`.

---

### Task 10: Review report and curated snapshot generation

**Files:**
- Create: `packages/registry/src/review.ts`, `packages/cli/src/commands/registry-review.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/registry/test/review.test.ts`, `packages/cli/test/registry-review.test.ts`
- Docs: `docs/registry-review.md`

**Interfaces:**
- Produces: `buildReviewReport(snapshot, rejected): ReviewReport`; CLI `plugin-detector registry review --cache-dir <dir> [--json]`; `plugin-detector registry snapshot --from-review <file>`? Keep v1 simple: review prints accepted/rejected/unprobed counts and per-candidate evidence; snapshot writer uses reviewed IDs.

- [ ] **Step 1: Write failing tests** — review groups by source/artifact type, includes license/ref/hash/evidence snippets, refuses empty snapshot, prints unprobed/rejected reasons; JSON schema validated.
- [ ] **Step 2: Verify red**.
- [ ] **Step 3: Implement report CLI** — no file writes by default; `--out` writes review JSON; no candidate changes.
- [ ] **Step 4: Run tests + commit** — `git commit -am "feat(registry): add review report for curated snapshot"`.

---

### Task 11: Generate and commit reviewed v1.0 snapshot

**Files:**
- Modify: `packages/registry/data/registry-snapshot.json`, `packages/registry/data/registry-manifest.json` (create if needed)
- Docs: `CHANGELOG.md`, `docs/registry-review.md`
- Test: `packages/registry/test/snapshot-integrity.test.ts`

**Interfaces:**
- Produces: a non-empty snapshot with schemaVersion 1, reviewed candidates, provenance entries, generatedAt, and a review summary committed next to it.

- [ ] **Step 1: Run live refresh** — `npm run registry:refresh` after Task 10; capture output.
- [ ] **Step 2: Review every candidate** — use `registry review --json`, inspect source/license/pin/evidence/type; remove rejected/unprobed from snapshot; record reasons in `registry-review.md`.
- [ ] **Step 3: Write integrity test** — every candidate has `artifactProbe`, provenance, pinned ref, license, evidence snippet, canonical capabilities; no `0.0.0` pins; no duplicate IDs; generatedAt not seed timestamp.
- [ ] **Step 4: Commit snapshot + review evidence** — `git add packages/registry/data docs/registry-review.md CHANGELOG.md && git commit -m "data(registry): add reviewed v1.0 snapshot"`.
- [ ] **Step 5: Verify recommend works** — `node packages/cli/dist/src/index.js recommend --use-case software-development --json` returns at least one non-no-good candidate on the reviewed snapshot; capture output in report.

---

### Task 12: Quality gate on real evidence and release docs

**Files:**
- Modify: `fixtures/benchmark/baselines/popular-repo.json`, `packages/cli/test/benchmark.test.ts`, `README.md`, `CHANGELOG.md`
- Test: `packages/cli/test/benchmark.test.ts`

**Interfaces:**
- Produces: baseline entries backed by real candidate IDs/evidence; benchmark remains ≥0.80 precision and strict beat; README says evidence-probed snapshot required for v1.0; CHANGELOG removes fixed gaps and lists remaining harness/release gates.

- [ ] **Step 1: Write failing quality test** — real baseline IDs resolve to actual popular candidates; benchmark still passes; a listing-only candidate cannot be required.
- [ ] **Step 2: Update baseline with real entries** — use reviewed snapshot candidates and real star/install data; keep synthetic labels out.
- [ ] **Step 3: Run full acceptance** — `npm ci && npm run typecheck && npm test && npm run build && npm audit --omit=dev && npm run benchmark && node packages/cli/dist/src/index.js inventory --json`.
- [ ] **Step 4: Update docs** — README/CHANGELOG accurately describe probed snapshot, sources, rate limits, and remaining v1.0 gates.
- [ ] **Step 5: Commit** — `git commit -am "test: gate v1.0 evidence quality"`.

---

## Out of scope for this plan

- Live install verification on the four harnesses (separate plan).
- Claude plugin marketplace automation / OpenCode global JSONC writer (separate plan).
- Permission/env consent enrichment beyond the evidence fields (separate plan).
- Hosted registry service.
- npm publishing credentials (release operation, not code).

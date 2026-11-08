# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release stages: `0.1` alpha, `0.5` beta, `1.0` stable.

## [Unreleased]

### Added

- Nothing yet.

## [0.1.0] - 2026-11-08

First alpha of the local-first harness plugin detector. This release proves the
core, adapters, consent gate, and recommendation benchmark; it is **not** a v1.0
artifact and does not claim that the registry corpus or every install path is
production-verified.

### Added

- TypeScript/Node 22 ESM monorepo with strict typechecking and no native runtime
  dependencies beyond Zod.
- Shared core: candidate/capability/install-plan schemas, versioned capability
  taxonomy, deterministic scoring, verdicts (`required`, `useful-optional`,
  `redundant`, `risky`, `no-good-candidates`), approval-token primitives, and
  install/rollback helpers.
- Six bundled use-case profiles: `software-development`, `video-editing`,
  `research-writing`, `data-analysis`, `devops-infrastructure`,
  `design-frontend`.
- Registry package: source fetchers for skills.sh, the MCP registry, GitHub, and
  an awesome list; deterministic normalization; trust classification; drift
  detection; intake refusal recording; local cache and bundled snapshot loading.
- Four harness adapters:
  - OpenCode — detection, inventory, compatibility, verified-only writer,
    recipe fallback, backups/rollback.
  - Claude Code — detection, inventory, compatibility, verified-only writer,
    recipe fallback, backups/rollback.
  - Codex — full detection/inventory; **recipe-only**, no automatic writes.
  - Cursor — full detection/inventory; **recipe-only**, no automatic writes;
    experimental MCP/skill/rule support.
- CLI `plugin-detector` with `inventory`, `recommend`, `explain`,
  `profiles validate`, `registry refresh`, `approve`, `install`, and `benchmark`.
  Read-only commands are asserted not to write; JSON outputs are Zod-validated.
- One-shot, candidate-scoped and plan-hash-scoped approval tokens with a default
  10-minute / maximum 30-minute TTL, non-TTY refusal, single-use consumption, and
  `0600` token files.
- Portable skill (`@plugin-detector/skill`) with SKILL.md, verdict template,
  agent metadata, and a POSIX shim. Manual installation only in 0.1.0.
- Red-team fixtures and tests for typo-squats, prompt injection, malicious
  postinstall hooks, silent drift, stale/archived artifacts, closed licenses,
  and dependency confusion.
- Recommendation benchmark with 30 labeled workflows across six domains,
  precision@5, a frozen popularity-only baseline, a 0.80 mean floor, strict-beat
  semantics, optional-label checks, and `--fail-on-low-value`.
- Release surface: MIT license, README, adapter matrix, security model, profile
  schema, contributing guide, security policy, code of conduct, changelog,
  GitHub release-notes template, and provenance release workflow.
- Release workflow on `v*` tags: clean checkout, Node 22, `npm ci`, typecheck,
  full tests, benchmark gate, build, `npm pack`, npm publish with provenance,
  SHA-256 checksums, and GitHub Release. No publish on pull requests.

### Changed

- The npm CLI package is published unscoped as **`plugin-detector`** so
  `npx plugin-detector` and `npm install -g plugin-detector` work as documented.
  Internal library packages remain under `@plugin-detector/*` and release in
  lockstep.
- Package `files` fields now ship only runtime `dist/src` (plus profiles,
  registry data, and skill assets). Compiled tests and `tsbuildinfo` are no longer
  packed.

### Registry snapshot

- The bundled snapshot is a **seed/placeholder**:
  `schemaVersion: 1`, `generatedAt: 2026-11-08T00:00:00.000Z`, zero candidates.
  `recommend` therefore returns `no-good-candidates` until a live refresh is
  reviewed and committed.
- `npm run registry:refresh` refreshes `packages/registry/data/registry-snapshot.json`
  from live public sources and writes a local, uncommitted `registry-manifest.json`
  for review.

### Unresolved v1.0 gates

These are release blockers for a stable `1.0`, not for `0.1.0`:

- [ ] **Reviewed registry snapshot.** Run `npm run registry:refresh` against live
  public sources, review the generated snapshot (timestamps, pinned refs, trust,
  provenance, rejected intake), explicitly approve the diff, and commit/pin it
  with its `generatedAt`. The current committed file is the seed/placeholder. The
  release workflow rejects `v1.*` tags when the snapshot is empty, still has the
  seed timestamp, or has incomplete provenance.
- [ ] **Live source health and breadth.** A live refresh from this commit
  returned partial results: `skills.sh/api/skills` and the awesome-list URL
  both returned HTTP 404, the MCP registry returned zero servers, and only the
  GitHub search source produced candidates. Re-verify/replace the failing
  endpoints and add the spec's npm/PyPI metadata and harness-native marketplace
  sources. A snapshot with unexplained source failures must not be approved.
- [ ] **Curated auto-install policy.** The design describes automatic install for
  "verified/curated" sources; the v0.1 writers accept only `verified` and emit a
  recipe for `curated`. Align the written policy and the implementation before
  v1.0 rather than leaving the documentation ahead of the code.
- [ ] **Live fallback.** The design calls for a live lookup only when the
  snapshot/cache misses; v0.1 reads only the bundled snapshot or local cache.
  Add the lower-confidence live fallback, or amend the design before v1.0.
- [ ] **Profile-configurable scoring weights.** The formula is implemented and
  documented, but weights are constants, not configurable per profile as the
  design requires.
- [ ] **Candidate checksum/attestation evidence.** Trust classification accepts a
  caller-provided checksum signal; v0.1 does not fetch or verify candidate
  checksums/attestations where a source offers them.
- [ ] **Live adapter verification.** Codex and Cursor remain recipe-only until
  live verification plus review flips `installVerified`. OpenCode and Claude Code
  writers are fixture/mutation tested; a live smoke test in a disposable home
  before v1.0 is still expected.
- [ ] **Compatibility wired into scoring.** Adapter compatibility is displayed and
  hard-gated only at zero; it is not yet multiplied into the recommendation score
  in `recommend`.
- [ ] **Interactive CLI default.** The spec describes an interactive CLI mode by
  default; 0.1.0 requires flags and delegates conversation to the harness skill.
- [ ] **Separate `discoverConfig` adapter method.** Config discovery currently
  happens inside `detect`/`inventory`; the spec's adapter contract lists
  `discoverConfig` explicitly.
- [ ] **Coverage gates.** The spec's minimum 85% line coverage on core and 100% on
  rollback/write paths is not yet measured/enforced in CI.
- [ ] **Local observability.** No persistent local log/retention implementation
  yet; the no-telemetry promise holds, but the target
  `~/.plugin-detector/logs` with documented retention is pending.
- [ ] **Recommendation contract completeness.** `fit`, `credibility`,
  `compatibility`, and `estimated_context_cost` are exposed through
  score/explain components rather than all being first-class fields in the
  recommendation schema.
- [ ] **Independent benchmark label review.** The 30 fixtures and owner-review
  protocol exist; an additional reviewer's sign-off is still pending.
- [ ] **Release operations.** Signed `v1.0.0` tag, configured `NPM_TOKEN`/OIDC
  trusted publishing, and a real npm/GitHub release are operational steps that
  cannot be completed by CI configuration alone.

### Known limitations

- `recommend` requires `--use-case`; it does not yet run an interactive wizard.
- Registry refresh uses public sources but their APIs/shapes can change; failures
  are isolated per source and never silently re-stamped as fresh.
- Cursor's MCP/skill/rule support is experimental.
- The Codex TOML reader intentionally supports a subset of TOML and reports the
  file as partial rather than guessing when it sees unsupported syntax.
- Scores are editorial estimates, not calibrated probabilities.
- Passing the benchmark proves only this project's recommendation gate, not the
  safety of any candidate.

## [0.0.0] - 2026-11-08

Internal scaffold only. Superseded by 0.1.0; no public artifacts.

# plugin-detector — Production-grade v1 design

Date: 2026-11-08  
Status: proposed, awaiting human-partner approval  
License: MIT  
Primary target: OpenCode, Claude Code, Codex, and Cursor

## Intent and why

The open-source ecosystem now produces far more skills, plugins, MCP servers, hooks, commands, and agent tools than any person can manually evaluate. Users want the best useful additions for their harness without repeatedly searching GitHub topics, trending pages, awesome lists, registries, and documentation.

`plugin-detector` exists to answer one question well:

> Given the use case a user declares and the harness they actually have installed, which currently available tools/plugins/skills are genuinely valuable, credible, compatible, and not already covered—and why?

The product is not a generic catalog. It is a **local-first discovery and decision engine for a harness**. It must surface high-value candidates that a diligent manual search would find and otherwise takes too much effort to keep checking. Recommending a low-value repo that the user could have found manually is a product failure.

## Execution model: deterministic CLI, agentic harness

The CLI never calls an LLM. It performs detection, normalization, registry lookup, deterministic scoring, overlap detection, compatibility checks, install planning, and file operations. The invoking agent—the harness where the user triggered the skill—owns natural-language understanding, clarifying questions, trade-off explanation, and the user conversation. This keeps prompts and user data out of the CLI, makes scores reproducible and testable, preserves usefulness when offline, and avoids a hidden model-dependency in the release artifact. The CLI may emit structured facts and templated reasoning; the agent turns them into the short reasoned recommendation the user approves.

## Decisions locked with the project owner

- The bundled v1 snapshot is generated from the source harvest, normalized deterministically, then manually reviewed and pinned into releases. It is not a hand-curated list of a few hundred repos.
- Codex and Cursor ship with full research/inventory adapters in v1. Their mutation paths become automatic only after live verification against current Codex/Cursor documentation and releases; until then their installer output is a recipe. OpenCode and Claude Code may support documented native auto-install paths.
- The recommendation benchmark has ~30 labeled workflows spanning the research areas (software development, video/media, research/writing, data, infra, design, and harness management). The project owner reviews expected recommendations; an additional reviewer should sanity-check labels when available. CI measures precision@5 against a fixed popular-repo baseline; low-value recommendations count as failures, and v1.0 does not ship without clearing this gate.
- “Verified/curated” for v1 requires an official/standards-backed source or verified publisher, an active maintainer/release history, an open license, checksum/provenance where the install source supports it, and no known critical audit finding at the pinned version. Unverified candidates remain visible in research but install as manual recipes, never silently.
- Delivery is staged (`0.1 alpha` → `0.5 beta` → `1.0`): core/schema first, adapter inventory second, profiles and research third, installs last, benchmark gate before v1.0. It is still one v1.0 product release; adapters become “verified” only after fixtures and mutation tests pass.

## Goals

- Make one command / harness skill trigger answer “what should I install for this workflow?”
- Broadly fetch candidates across skills, MCP servers, tools, plugins, hooks, commands, and related harness artifacts.
- Read the user’s installed harness inventory locally and compare candidates against it.
- Explain every verdict with evidence: source, popularity, maintenance, risk, provenance, compatibility, overlap, and fit to the use case.
- Ask clarifying questions like superpowers: draw out the user’s workflow and constraints before recommending.
- Rank above manual GitHub/awesome-list discovery through a credible, explainable quality bar.
- Install nothing before explicit user approval.
- Install only what is approved, preferring trusted/curated paths and generating a manual recipe otherwise.
- Work across four first-class v1 adapters: OpenCode, Claude Code, Codex, Cursor.
- Ship as production-grade open source: typed core, tests, CI/CD, reproducible releases, docs, and security policy.

## Non-goals for v1

- No hosted service, account system, team sync, telemetry backend, or central “marketplace” replacement.
- No scheduled runs, background watching, or autonomous installs.
- No automatic removal/disabling of installed tools unless the user separately asks in a future audit flow.
- No guarantee that every internet candidate is safe; the tool reduces risk and makes it transparent, it does not certify arbitrary software.
- No attempt to support every harness equally. v1 ships four serious adapters; later adapters plug into the same interface.
- No generic “browse everything” UI. The interface is a short, reasoned verdict set.

## Anti-goals

- Not another noisy catalog or leaderboard.
- Not a star-count dump.
- Not an auto-installer that optimizes for install volume.
- Not a telemetry product.
- Not a central trust authority.
- Not a replacement for package managers, harness plugin systems, or security review.

## Constraints and decisions

### Local-first

All inventory, project signals, use-case details, prior verdicts, and installation plans remain on the user’s machine. Network access happens only to query public discovery sources or restore a local cache. No telemetry is enabled by default; none should be required for core function.

### TypeScript/Node monorepo

The implementation uses TypeScript with ESM on Node.js >= 22. A monorepo keeps the core deterministic and reusable while adapter packages package harness-specific behavior independently.

Recommended top-level layout:

```text
packages/
  core/          # data model, normalization, scoring, verdicts, plans
  cli/           # plugin-detector binary and interactive wizard
  registry/      # local cache builder, source adapters, snapshot generation
  profiles/      # versioned use-case packs
  adapters/
    opencode/
    claude-code/
    codex/
    cursor/
  skill/         # portable SKILL.md + assets
fixtures/        # labeled harnesses, candidate corpora, red-team fixtures
docs/
```

### MIT license

Maximize adoption and interoperability. Contributing docs must clearly state contribution and security expectations.

### On-demand only

The harness skill invokes the CLI only when the user asks for recommendations, setup help, or workflow optimization. No cron, daemon, hook on every message, or continuous internet polling.

### Fetch broad, install conservatively

Discovery is intentionally broad. Installation is intentionally narrow and trust-aware.

For v1:

- Verified/curated source + compatible install path: after approval, install automatically.
- Unverified/obscure candidate: show it, explain risk and evidence, but emit a manual recipe instead of executing the install.
- Harness-native plugin with arbitrary code: same rule; automation only through documented harness-native paths with rollback or explicit manual recipe.

## Approaches considered

### TypeScript/Node monorepo — chosen

Pros: native fit with npm, skills, MCP, and JS-based harness plugins; easy global/`npx` distribution; strong typing for adapters; CI/provenance straightforward; shared core testable independently.  
Cons: users need Node >= 22; config parsing must be robust across harnesses.

### Python CLI via pipx — rejected

Pros: excellent scraping/data ecosystem.  
Cons: poorer fit for npm/MCP/plugin distribution, more cross-language friction, less consistent install experience.

### Single prototype script — rejected

Pros: fastest.  
Cons: not production-grade, adapters tightly coupled, release/testing discipline weak, impossible to maintain as harness formats evolve.

## v1 product behavior

### Primary invocation

Inside an agent harness, the user invokes the plugin-detector skill, for example:

```text
/plugin-detector for video editing
```

or asks naturally:

```text
What tools should I install for my video editing workflow?
```

The skill runs the CLI and presents:

1. detected harness and profile
2. any clarifying questions
3. a short candidate set, not a dump
4. evidence and reasoning per candidate
5. required / useful-optional / redundant / risky / no-good-candidates verdict
6. an install plan only for approved candidates

### CLI shape

```bash
plugin-detector recommend [--use-case VIDEO_EDITING] [--path .] [--harness auto]
plugin-detector explain <candidate-id>
plugin-detector install <candidate-id> --harness <name> --yes   # only after explicit approval
plugin-detector inventory [--json]
plugin-detector registry refresh
plugin-detector profiles validate <file>
```

Interactive mode is the default. Non-interactive flags exist for scripting, but never bypass the approval gate in agent-driven flows.

### Recommendation contract

Every recommendation must carry:

`candidate`, `artifact_type`, `sources`, `use_case_domains`, `fit`, `credibility`, `maintenance`, `provenance`, `risk`, `compatibility`, `overlap`, `verdict`, `confidence`, `install_mode`, `evidence_pointers`, `reasoning`, `estimated_context_cost`, and `last_verified`.

A candidate cannot be required unless it clears:

- relevance to the declared use case and project/harness signals
- minimum credibility/maintenance floor (configurable, visible, not hidden)
- compatibility with the detected harness
- acceptable risk tier or explicit high-trust verification
- non-trivial marginal value over installed capabilities

Star count or install count is a quality floor/tiebreaker, not the ranking function. Rank by use-case fit and marginal value after credibility gates. Low-value popular packages must still be rejected when they duplicate installed capabilities.

### Verdicts

- **Required**: materially improves the declared workflow and is not already present.
- **Useful-optional**: good addition, but appropriate only for active sub-workflows; may be installed for a period, not necessarily permanently.
- **Redundant**: adequate capability already installed or available; recommend keeping existing or replacing only with explicit approval.
- **Risky**: real fit, but provenance/permissions/maintenance/drift concerns block automatic adoption.
- **No-good-candidates**: explicitly report that no recommendation is better than manual noise.

## Verified/curated policy

A candidate is `verified` only when all applicable checks pass:

1. official marketplace, standards-backed registry, verified publisher, or maintainer identity checked against the source repository;
2. recent commits/releases or proven stewardship for the pinned artifact;
3. license is present and compatible with redistribution by the harness ecosystem;
4. immutable reference: tagged release, package version, commit digest, or marketplace artifact ID;
5. checksum/attestation/provenance when the ecosystem provides it;
6. no known critical audit finding for the pinned artifact/version; if an audit is stale or unknown, confidence drops but does not alone certify the artifact.

Curated recommendations additionally require explicit in-repo review evidence. Anything less than verified can still be shown as a candidate, with a manual recipe and an unverified label. No candidate is allowed to bypass this policy through popularity alone.

### Installation safety

Before any write, show:

- source and canonical URL
- artifact type and destination
- exact commands/config changes
- files that will change
- required permissions/env vars by name only
- expected side effects
- rollback plan
- why the candidate is verified or not

Then require explicit approval. Implementation must:

- read current config before writing
- write atomically where possible
- snapshot/back up existing files before mutation
- parse and validate post-write results
- never write secrets; secrets flow only through existing environment variables
- restore on validation failure
- prefer harness-native installers or documented declarative config paths
- provide manual recipe when automatic install is not safe or supported

## Discovery architecture

### Two-speed harvest

1. **Bundled snapshot**: generated by the release pipeline from public sources, normalized deterministically, manually reviewed, and pinned into each release; always available and useful offline. No release may handwave this file as “best efforts.”
2. **On-demand refresh/local cache**: reads public APIs/pages when the user allows network; caches normalized candidates locally with source timestamps and review status.
3. **Live fallback**: only when snapshot/cache misses; always marked lower-confidence.

Sources:

- skills.sh and vendor skill repositories
- official MCP registry and MCP server directories
- npm and PyPI metadata
- GitHub repository metadata, releases, activity, and code/manifests
- curated awesome lists and official marketplaces
- harness-native registries/directories for Claude Code, OpenCode, Codex, Cursor

### Artifact probing

Do not trust declared keywords or self-declared tags. Normalize only after checking evidence such as:

- `SKILL.md` with valid frontmatter
- MCP manifests/config schema and source repository
- package manifests and entrypoints
- plugin manifests (`.claude-plugin/plugin.json`, OpenCode plugin package, etc.)
- documented install steps
- release history, activity, license, and maintainer identity where available

### Scoring model

Deterministic, explainable, and printed verbatim:

```text
fit = relevance × (0.55 + 0.25 × value + 0.2 × immediacy) × compatibility × overlap
score = 100 × (fit − setup cost − risk)
```

Add a declared-use-case term to relevance and first-class overlap against installed capability records. All weights are documented, configurable per profile, and marked as editorial estimates until calibration data exists.

### Shared capability taxonomy

V1 defines one shared capability vocabulary used by profiles, installed-inventory normalizers, candidate probes, and the overlap detector. Initial domains cover testing, code-review, planning/orchestration, debugging, VCS, CI/release, containers/infrastructure, docs, design/frontend, data/analysis, media/transcoding, speech/captions, publishing, security/dependency scanning, and agent-harness management. Adapters may emit local names, but all comparisons and overlap detection run on canonical IDs. The taxonomy is versioned with the schema and extended through ADR-style profile changes, never by ad-hoc string matching.

Hard gates override score: incompatible harness, unknown/malicious provenance, archival/abandonment above threshold, unverifiable install source, or explicit local risk policy.

## Use-case profiles

v1 ships at least:

- software-development
- video-editing
- research-writing
- data-analysis
- devops-infrastructure
- design-frontend

Profiles map declared use cases to domains, signal queries, and expected capability classes. Example: video-editing maps to media transcoding, speech-to-text/captions, thumbnails, effects, and publishing—not arbitrary GitHub video projects.

Project/harness signals corroborate or challenge the declared use case. On contradiction, the agent asks which is correct; it never silently chooses.

## Consent gate enforcement

The CLI cannot judge natural language, so “explicit approval” is enforced by separation of capability:

- profile/research/inventory/explain/list commands never mutate files;
- `install --yes` refuses unless the invoking process presents an approval token generated by the skill for that candidate ID or the user confirms at a TTY prompt;
- the skill creates that approval token only after the user explicitly approves the exact plan in the conversation;
- non-interactive invocations without `--yes` and without TTY refuse to write;
- `--yes` documents exactly what the agent must do before calling it; it is not a blanket permission flag;
- rollback always remains available for plans that mutate managed files.

This cannot cryptographically prove the user meant the approval—it enforces the tool’s no-write-without-explicit-consent path and makes accidental or ambient mutation impossible.

## Harness adapters

### OpenCode

- detect `opencode.json(c)`, `.opencode/`, project/global skills/plugins/MCP config
- inventory installed npm plugins, local plugins, skills, MCP servers
- install verified skills via `npx skills add` where appropriate
- update config atomically; never reload running sessions silently

### Claude Code

- detect Claude Code installation, `~/.claude.json`, `.claude/`, marketplaces, plugins, enabled status, MCP config
- query official/community/topic marketplace metadata
- use harness-native flows when verified; otherwise output manual recipe
- inventory hooks/commands/skills/MCP separately because their cost classes differ

### Codex

- detect Codex config roots and plugin/skill/MCP configuration
- normalize capabilities into the shared model
- provide full detection/inventory/research support
- mutation path is recipe-only until Codex’s current plugin/MCP documentation and releases are live-verified; only then add a harness-native verified installer

### Cursor

- detect Cursor MCP/config and skills/plugin-related configuration as supported by current Cursor documentation
- provide full detection/inventory/research support
- use documented config writers only after live verification; until then emit a recipe and mark Cursor installation experimental
- never claim equal stability with OpenCode or Claude Code before live verification

Each adapter must provide: `detect`, `inventory`, `discoverConfig`, `compatibility`, `installPlan`, `applyPlan`, `rollback`, and `fixtures`.

## Packaging and distribution

- Publish `plugin-detector` to npm with provenance/attestation.
- Use signed tags and GitHub Releases for every semver release.
- Include checksums and provenance metadata.
- Document installation for each harness and manual fallback install.
- Provide `npx plugin-detector` and global install paths.
- Keep Python/native installers out of v1.
- Docs: quick start, security model, adapter matrix, profile schema, contribution guide, code of conduct, security policy, changelog.

## Quality and release gates

- TypeScript strict mode; no unchecked JSON/config reads.
- Unit tests for scoring, normalization, verdicts, profile matching, and rollback logic.
- Golden fixtures for inventory/parsers across all four harnesses.
- Integration tests in temporary `$HOME` trees with representative configs.
- Red-team fixtures: typo-squats, prompt-injected candidate descriptions, malicious postinstall hooks, silent repo renames, stale/archived servers, dependency confusion.
- Recommendation benchmark: ~30 labeled workflows across the research domains; project owner approves expected recommendations, with an additional reviewer when available. CI reports precision@5 against a fixed popular-repo baseline; low-value recommendations count as failures; v1.0 does not ship before this gate passes.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm audit --omit=dev`, adapter fixture checks, and release dry-run must pass in CI.
- Release stages: `0.1` schema/core/fixtures, `0.5` adapters + profiles + benchmark tooling, `1.0` installs + provenance + benchmark gate. A package is never labeled v1 while any verified-install claim remains unverified.
- Coverage threshold: at least 85% line coverage on core; 100% on rollback/write paths.

## Observability

Local-only logs by default under `~/.plugin-detector/logs` with documented retention. No content of prompts, project files, keys, or installed configs is transmitted. Crash reports are opt-in only and scrub paths/secrets.

## Risks and mitigations

- **False confidence in scoring**: print components and mark estimates; require human approval.
- **Supply-chain compromise**: artifact probing, provenance, version pinning, trusted-path installs, rollback, red-team tests.
- **Schema drift across harnesses**: adapter fixtures pinned to documented versions; compatibility warnings and recipe-only fallback.
- **Popularity gaming**: credibility floor plus relevance ranking; never rank by stars alone.
- **Prompt injection in candidate text**: candidate copy treated as untrusted data; no installation action derived from it without approval.
- **Over-broad network refresh**: refresh is user-invoked, cached, and source-attributed.

## What is left to the builder

Builders own exact file parser implementations, HTTP/API client versions, CI runner images, fixture generation mechanics, and adapter edge-case handling, but may not weaken the approval gate, local-first promise, security model, MIT/provenance release flow, or the recommendation-quality benchmark.

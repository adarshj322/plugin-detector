# plugin-detector

**Find the few tools genuinely worth installing for your workflow — on your machine, with the evidence, and never without your approval.**

`plugin-detector` is a local-first discovery and decision engine for agent-harness
plugins, skills, MCP servers, hooks, and commands. It inventories what you already
have in OpenCode, Claude Code, Codex, and Cursor, compares candidates against your
declared use case, and returns a short, explained recommendation set instead of a
star-count dump.

> **Status: 0.1.0 alpha.** The CLI, adapters, consent gate, and recommendation
> benchmark are implemented and tested. The bundled registry snapshot is still a
> **seed/placeholder**; v1.0 cannot ship until a live refresh is reviewed and
> committed. See [Registry snapshot status](#registry-snapshot-status) and
> [CHANGELOG.md](CHANGELOG.md#unresolved-v10-gates).

- Node.js **>= 22**
- License: **MIT**
- No hosted service, account, telemetry backend, or LLM call in the CLI.

## Quick start

```bash
# What is installed on this machine?
npx plugin-detector inventory

# What should I add for a workflow?
npx plugin-detector recommend --use-case software-development --signal tsconfig

# Why did a candidate receive that verdict?
npx plugin-detector explain CANDIDATE_ID

# Produce an install plan for a candidate you accepted (no writes)
npx plugin-detector plan --candidate CANDIDATE_ID --harness opencode --out plan.json

# Approve that exact plan (prints a single-use token once), then install it
npx plugin-detector approve --candidate CANDIDATE_ID --plan-file plan.json
npx plugin-detector install --plan-file plan.json --candidate CANDIDATE_ID --harness opencode

# Optional: install the CLI globally
npm install --global plugin-detector
```

`recommend` emits at most five non-risky candidates and a set-level verdict:
`required`, `useful-optional`, `redundant`, or `no-good-candidates`. `risky`
is a per-candidate verdict; risky candidates are shown as such by `explain` and
are excluded from the returned top set. Every recommendation carries its
evidence pointers, confidence, score, overlap, compatibility, pinned ref,
license, and reasoning. Risk, audit status, and maintenance are candidate
fields (shown by `explain`), not top-level recommendation fields. A
`no-good-candidates` answer is a valid, expected result.

The bundled snapshot is still a seed/placeholder, so a fresh install can
legitimately return `no-good-candidates` until a reviewed refresh is committed
(see [Registry snapshot status](#registry-snapshot-status)).

### Four-harness support

| Harness | Detection & inventory | Automatic install (v0.1) | Notes |
| --- | --- | --- | --- |
| **OpenCode** | Yes | Verified candidates only; tested writer | Skills via the documented skills CLI; plugins/MCP through config merge. Recipe fallback otherwise. |
| **Claude Code** | Yes | Verified candidates only; tested writer | Skills, plugins (`enabledPlugins`), and project MCP servers. Recipe fallback otherwise. |
| **Codex** | Yes | **Recipe-only** — no automatic writes | Full research/inventory; `applyPlan` refuses until live verification flips `installVerified`. |
| **Cursor** | Yes | **Recipe-only** — no automatic writes | Full research/inventory; MCP is the documented path, while skills/rules/commands are experimental; `applyPlan` refuses. |

"Tested writer" means the mutation path is covered by fixture and rollback tests,
not that every upstream harness release is permanently verified. Upstream formats
drift; see [docs/adapters.md](docs/adapters.md) for the exact artifact support,
config paths, and verification status.

The same quick start works for each harness because detection is automatic. You
can pin it explicitly:

```bash
npx plugin-detector recommend --use-case research-writing --harness claude-code
npx plugin-detector recommend --use-case devops-infrastructure --harness codex
npx plugin-detector recommend --use-case design-frontend --harness cursor
```

## Safety model: read first, install only on explicit consent

- `inventory`, `recommend`, `explain`, `plan`, and `profiles validate` are
  **read-only** by default. They never write harness config or install anything.
  `plan --out <file>` writes only the plan file you explicitly request.
- The commands that write are `registry refresh` (cache/snapshot update),
  `approve` (the one-shot token store), and a consented `install`. `install`
  refuses unless the plan re-derives exactly from the registry snapshot and a
  valid one-shot token or interactive TTY confirmation is present.
- `approve` prints the token **once** so it can be handed to `install`. The token
  is candidate-scoped and bound to the `sha256` of the **complete** plan
  (candidate, harness, operations, backup refs, and rollback operations),
  single-use, and short-lived (default 10 minutes, maximum 30).
- **Unverified candidates never auto-install.** `plan` prints a manual recipe
  with the exact commands, files, permissions, side effects, and rollback steps
  instead of a write plan.
- Secrets are represented by environment-variable **name only**. Values are never
  read, written, or logged.
- Every managed write backs up the preimage, validates after writing, and restores
  on failure. Rollback instructions ship with the plan.
- The CLI never executes candidate code, never calls an LLM, and sends no
  telemetry. Discovery network access happens only on explicit `registry refresh`;
  an approved install may invoke the harness's own installer, which can fetch the
  artifact from its source.

Read the full [security model](docs/security-model.md) and the
[disclosure policy](SECURITY.md).

## What a recommendation looks like

The CLI separates deterministic `facts`, editorial `estimates`, and untrusted
candidate copy. This is an illustrative shape, not captured output from a real
snapshot:

```text
facts:
  use-case: video-editing (profile-status: match)
  verdict: required
  demo-candidate [required] score=78.4 overlap=1 confidence=high license=MIT pinned=v1.2.3 evidence=https://example.com/source-with-a-pinned-version
estimates:
  demo-candidate: relevance 0.9 · value 0.8 · immediacy 1 · compatibility 1 · overlap 1 · setupCost 0.2 · risk 0.05 → score 78.4; verdict required: fills a profile-domain gap with acceptable risk
```

Scores are **editorial estimates**, not calibrated probabilities. The component
breakdown is printed verbatim so you can disagree with it. Candidate descriptions
are treated as untrusted data and are hidden behind `explain --show-untrusted`.
Compatibility is displayed and hard-gated only at zero in 0.1.0; it is not yet
multiplied into the recommendation score (a tracked v1.0 gate).

`recommend --json`, `explain --json`, `plan --json`, `inventory --json`,
`approve --json`, and `install --json` emit Zod-validated structures for the
invoking agent. The JSON shape is not yet versioned, so treat it as an unstable
0.x contract.

## Manual install recipes

When automatic install is not safe or not supported, `plan` prints a recipe
instead of a write plan. These are illustrative shapes, not a substitute for
the plan's exact output:

```bash
# Codex (recipe-only in v0.1): a skill copied into the user skill root
cp -r SKILL_DIR ~/.agents/skills/CANDIDATE_ID
# rollback
rm -rf ~/.agents/skills/CANDIDATE_ID
```

```jsonc
// Cursor (recipe-only in v0.1): add one server to .cursor/mcp.json
{
  "mcpServers": {
    "CANDIDATE_ID": { "command": "SERVER_COMMAND", "env": { "TOKEN_ENV_NAME": "${TOKEN_ENV_NAME}" } }
  }
}
// rollback: remove the "CANDIDATE_ID" entry
```

Recipes name required environment variables but never embed their values. Check
the plan's `backupRefs` and `rollbackOperations` before applying anything manually.

## Install the harness skill

The deterministic CLI is deliberately small. The companion skill owns the
conversation: restating the use case, asking one clarifying question at a time,
presenting the short verdict set, and obtaining explicit approval before install.

The skill ships as `@plugin-detector/skill`. In 0.1.0 it is installed
manually (there is no self-installer):

```bash
git clone https://github.com/adarshj322/plugin-detector.git
# OpenCode
cp -r plugin-detector/packages/skill ~/.config/opencode/skills/plugin-detector
# Claude Code
cp -r plugin-detector/packages/skill ~/.claude/skills/plugin-detector
# Codex
cp -r plugin-detector/packages/skill ~/.agents/skills/plugin-detector
# Cursor (experimental)
cp -r plugin-detector/packages/skill .cursor/skills/plugin-detector
```

The skill requires the `plugin-detector` binary on `PATH` (or resolves it through
`npx`).

## Registry snapshot status

The repository currently ships a **seed snapshot** at
`packages/registry/data/registry-snapshot.json`: `schemaVersion: 1`,
`generatedAt: 2026-11-08T00:00:00.000Z`, zero candidates. It exists so the loader,
schema, and offline behavior are exercised; it is not a recommendation corpus.

With the seed snapshot, `recommend` honestly returns `no-good-candidates` rather
than inventing output. To build a real snapshot:

```bash
npm run registry:refresh   # live public sources; writes the snapshot + local manifest
git diff -- packages/registry/data/registry-snapshot.json
# Review provenance, trust flags, rejected intake entries, and the generatedAt pin.
git add packages/registry/data/registry-snapshot.json
git commit -m "data: pin reviewed registry snapshot"
```

**v1.0 gate:** no v1.0 artifact may ship until the refreshed snapshot has been
reviewed, explicitly approved, and committed with its `generatedAt` timestamp.
The release workflow fails `v1.*` tags when the snapshot is empty, still carries
the seed timestamp, or has provenance that does not cover every candidate.

A refresh isolates per-source failures and exits 0 when at least one source
succeeds. The local `registry-manifest.json` records which sources failed and
which candidates were rejected at intake. Review that manifest; do not approve a
snapshot with unexplained source failures.

## Recommendation benchmark

The release-blocking benchmark covers **30 labeled workflows** across six domains
(software development, video/media, research/writing, data, infrastructure, and
design/frontend). CI scores every candidate through the production scorer and
compares precision@5 against a frozen popularity-only baseline:

- mean precision@5 floor: **0.80**
- every workflow must **strictly beat** the baseline (a tie is not a beat)
- any `required` candidate in `unacceptableIds` or without a relevant capability
  fails the gate
- unknown workflow ids are never treated as a pass

```bash
npm run benchmark           # same gate as CI
npx plugin-detector benchmark --fixtures fixtures/benchmark --fail-on-low-value
```

Passing the gate proves only this project's narrow recommendation gate. It does
**not** prove safety, calibration, or that a candidate is trustworthy. See
[docs/benchmark.md](docs/benchmark.md).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
npx plugin-detector inventory --json
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the adapter-change rules, snapshot
review protocol, and release checklist.

## Documentation

- [Adapter matrix and verification status](docs/adapters.md)
- [Security model](docs/security-model.md)
- [Profile schema](docs/profile-schema.md)
- [Benchmark and owner-review protocol](docs/benchmark.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy and disclosure](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).

# Contributing to plugin-detector

Thanks for helping improve a local-first, deterministic tool. Contributions are
accepted under the [MIT license](LICENSE); there is no CLA.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report
security issues privately via [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements: Node.js **>= 22** and npm (the repo pins a lockfile).

```bash
git clone https://github.com/adarshj322/plugin-detector.git
cd plugin-detector
npm ci
npm run typecheck
npm test
npm run build
npm run benchmark          # release-blocking recommendation gate
npm audit --omit=dev
```

The test suite uses Node's built-in runner after a TypeScript build. There is no
watcher or daemon. Tests must not require network access; use fixtures and
temporary `$HOME`/cache directories.

## What to change where

```text
packages/core/          schemas, taxonomy, scoring, verdicts, install primitives
packages/cli/           binary, commands, JSON contracts
packages/registry/      source fetchers, normalization, trust, snapshot/cache
packages/profiles/      use-case profiles and resolver
packages/adapters/*/    OpenCode, Claude Code, Codex, Cursor adapters
packages/skill/         portable SKILL.md, agents, assets, shim
fixtures/               harness, benchmark, and red-team fixtures
docs/                   security model, adapter matrix, profile schema, benchmark
```

Keep the CLI deterministic and local-first:

- no LLM call in the CLI;
- no telemetry or hosted dependency;
- no background/scheduled work;
- no new runtime dependency without a clear reason (Zod is the approved schema
  dependency; Node built-ins are preferred);
- read-only commands must stay read-only;
- do not weaken the approval gate or trust policy to make a test pass.

## Test expectations

Every behavior change ships with tests. The project expects:

- **TDD** for non-trivial logic: a failing test first, then the smallest fix.
- Golden fixtures for parser/inventory changes across all four harnesses.
- Red-team cases for name gates, drift, prompt injection, malicious hooks, and
  install refusals.
- Rollback/write-path tests for any adapter mutation change; restore-on-failure
  must be proven, not asserted.
- A benchmark update when scoring, profiles, or candidate labeling changes.
- No test may depend on the developer's real `$HOME`, registry cache, network, or
  credentials.

Run at least:

```bash
npm run typecheck
npm test
npm run benchmark
```

## Adapter changes

OpenCode and Claude Code have tested writers. Codex and Cursor are intentionally
recipe-only in v0.1. Do **not** flip `installVerified` without:

1. live verification against current upstream documentation/releases;
2. fixtures covering the exact config format and failure modes;
3. mutation and rollback tests;
4. review evidence in a dedicated pull request;
5. an update to `docs/adapters.md` and the README matrix.

A new artifact type must map to a canonical capability ID; adapters may keep local
names, but comparisons and overlap detection run on canonical IDs.

## Registry snapshot changes

The committed `packages/registry/data/registry-snapshot.json` is currently a
**seed/placeholder** with zero candidates. Normal development must not fabricate
snapshot data.

Before a release that claims a real registry:

```bash
npm run registry:refresh    # live public sources; writes snapshot + manifest
git diff -- packages/registry/data/registry-snapshot.json
```

Review:

- `generatedAt` and every `retrievedAt` timestamp;
- every candidate's `pinnedRef`, license, provenance, maintenance, and trust;
- the local `registry-manifest.json` rejected-intake list (not committed);
- that provenance covers every candidate id.

Commit only the reviewed snapshot. The release workflow rejects `v1.*` tags when
the snapshot is empty, still carries the seed timestamp, or has incomplete
provenance. No v1.0 artifact ships without a reviewed snapshot.

## Benchmark labels

Labels are data with consequences. A label/baseline change requires:

1. a written rationale in the fixture/PR;
2. a second reviewer when available;
3. re-running `npm run benchmark`;
4. never lowering the gate to hide a regression.

See [docs/benchmark.md](docs/benchmark.md).

## Release checklist

1. Confirm the intended version in the root and every workspace `package.json`.
   All publishable packages release in lockstep (v0.1.0, v0.5.0, v1.0.0).
2. For `v1.*`: refresh, review, and commit the registry snapshot (above).
3. Run the full acceptance battery:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run build
   npm audit --omit=dev
   npm pack --dry-run
   npx plugin-detector inventory --json
   npm run benchmark
   ```

4. Inspect the packed file lists: no `node_modules`, tests, caches, `.env`,
   fixtures, coverage, or personal paths.
5. Create a **signed** tag: `git tag -s vX.Y.Z -m "plugin-detector vX.Y.Z"`,
   then push it. Tags are `v0.1.*` alpha, `v0.5.*` beta, `v1.*` stable.
6. The tag triggers `.github/workflows/release.yml`: clean checkout, Node 22,
   `npm ci`, typecheck, full tests, benchmark, build, pack, npm publish with
   provenance, SHA-256 checksums, and a GitHub Release.
7. Never publish from a dirty worktree or a pull request. Never reuse a version.
8. For `v0.x`, npm dist-tag `next`; `v1.*` publishes to `latest`.

The workflow uses npm trusted publishing/OIDC (`id-token: write`) and requires
the `NPM_TOKEN` repository secret. A missing secret fails the job; it does not
silently skip publishing.

## Commit and review style

- Keep commits focused; include tests and docs with the behavior change.
- Do not commit generated `dist/`, tarballs, caches, or `registry-manifest.json`.
- Do not edit the design/spec documents to match an implementation shortcut.
  Record the gap in the changelog or an issue instead.
- Reviewers should treat "this improves the score" as insufficient; require
  evidence, edge-case tests, and no weakened safety gate.

## Questions

Open a discussion or issue at
<https://github.com/adarshj322/plugin-detector/issues>. For security reports use
the private advisory flow in [SECURITY.md](SECURITY.md).

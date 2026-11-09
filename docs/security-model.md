# Security model

plugin-detector reduces the risk of finding and installing harness additions. It
does **not** certify that any third-party candidate is safe. This document states
what the tool does, what it deliberately does not do, and where the remaining
risk sits.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Malicious or misleading candidate metadata | Candidate copy is untrusted data; scores read normalized evidence fields; descriptions are withheld unless explicitly requested. |
| Typo-squat / dependency confusion | Name and source gates, artifact probing, pinned immutable refs, and red-team fixtures. |
| Prompt injection in a candidate description/README | No install action or scoring decision is derived from free text; the skill never executes candidate content. |
| Compromised upstream artifact | Trust classification, provenance/checksum where available, pinned version, manual recipe for unverified candidates, rollback. |
| Stale or silently renamed repository | Per-refresh drift detection; drifted candidates are re-flagged; stale entries keep their original verification age. |
| Secret leakage through inventory | Config values are never recorded or emitted; only names, paths, and flags are recorded; inventory output redacts secret-shaped values. |
| Ambient or accidental mutation | Read-only defaults, plan re-derivation before install, one-shot consent tokens, TTY confirmation, non-TTY refusal, backups, rollback. |
| Supply-chain compromise of this project | npm provenance for published packages, SHA-256 release checksums, release-tag policy, CI gates. |

## Local-first and telemetry

- **Local-first.** Inventory, project signals, use-case declarations, snapshots,
  plans, approval tokens, and install state stay on the user's machine.
- **No telemetry by default.** There is no telemetry endpoint, analytics SDK,
  crash reporter, account, or hosted dependency. The CLI does not require an
  account and has no "phone home" behavior.
- Network access happens only on explicit `registry refresh` (or when the user
  installs a candidate that fetches from its own source). Read-only commands and
  `plan` use the local bundled snapshot or local cache.
- Logging is local-only. v0.1 does not create a persistent log file; the spec's
  target is `~/.plugin-detector/logs` with documented retention (a v1.0 gate).
  Never enable a log that records prompts, project file contents, keys, or config
  values.

## No LLM in the CLI

The CLI is deterministic. It performs detection, normalization, registry lookup,
scoring, overlap detection, compatibility checks, install planning, and file
operations. It never calls a model and never sends a prompt or project data to
one. Natural-language understanding, clarifying questions, and trade-off
explanations belong to the invoking harness agent, which reads the CLI's
structured facts.

This keeps scores reproducible and testable, keeps user data out of third-party
model APIs, and lets the tool work offline.

## Read-only defaults

`inventory`, `recommend`, `explain`, `plan`, `profiles validate`, and `benchmark`
are read-only. They do not create, modify, or delete harness configuration.
`plan` writes a file only when the user passes `--out <file>`. The only commands
that write are:

- `registry refresh` — an explicit, user-invoked local cache/snapshot update
- `plan --out <file>` — writes the plan file the user explicitly requested
- `approve` — writes a one-shot approval token under the state directory
- `install` — applies an approved plan, with backup and rollback

There is no daemon, cron job, hook on every message, background watcher, or
scheduled polling in v1. The skill runs only when the user asks.

## One-shot consent tokens

The CLI cannot judge natural language, so "explicit approval" is enforced by
separation of capability:

1. The skill runs `plugin-detector plan --candidate <id> --harness <name>` and
   shows the exact plan: source, canonical URL, artifact type, destination,
   commands/config changes, files that will change, required permissions and
   environment-variable **names**, side effects, rollback, and why the candidate
   is (or is not) verified.
2. Only after the user approves that exact plan does the skill call
   `plugin-detector approve --candidate <id> --plan <sha256>` (or
   `--plan-file plan.json`). The hash covers the **complete** plan: candidate,
   harness, operations, backup refs, and rollback operations.
3. `install` re-derives the expected plan from the registry snapshot and the
   adapter, requires `--candidate` and `--harness`, and rejects an unverified
   candidate or a hash mismatch **before** consuming the token. It then requires
   the matching token (`--approval-token` or
   `PLUGIN_DETECTOR_APPROVAL_TOKEN`) or an interactive TTY confirmation. A
   non-TTY process without a token refuses and writes nothing.
4. The token is scoped to one candidate **and** the complete-plan hash, is
   consumed single-use, and expires (default 10 minutes, maximum 30).
5. `approve` prints the token once so it can be handed to `install`; treat it as
   a short-lived secret, do not commit it, and do not paste it into logs. Token
   files are created with `0600` permissions in the state directory
   (`~/.plugin-detector/approvals` by default, overridable with
   `PLUGIN_DETECTOR_STATE_DIR`).

This cannot cryptographically prove that the human meant the approval. It does
make ambient, accidental, or unapproved mutation impossible through the CLI.

## Unverified candidates become manual recipes

A candidate that does not clear the verified policy is still visible, but:

- it is labeled `unverified`;
- it receives a manual recipe, never an automatic write;
- the recipe names the files, commands, environment-variable names, and rollback
  steps;
- no candidate code is executed to "try it out".

Popularity alone can never promote a candidate to verified or trigger a write.
Codex and Cursor are entirely recipe-only in v0.1 regardless of trust.

## Secrets are environment names only

- The CLI never asks for, reads, stores, logs, or writes secret values.
- Inventory records environment-variable names and config paths, not values.
- Install plans may state that an environment variable is required, but the
  value must already exist in the user's environment or harness secret store.
- Redaction is defense in depth, not a license to pass secrets through output.
  If you believe a secret was exposed, follow [SECURITY.md](../SECURITY.md).

## Backups, validation, and rollback

Every managed write must:

1. read the current config before writing;
2. back up the preimage (or record the exact preimage);
3. write atomically where the platform allows;
4. parse and validate the post-write result;
5. restore the backup if validation fails;
6. ship rollback operations with the plan.

Rollback remains available after a successful install. Writes performed by
external commands (for example a skill installer) are not deleted blindly by a
generic rollback; the plan gives the exact removal recipe instead.

## Supply-chain limits — this is not a certification

plugin-detector is a risk-reduction tool, not a security audit, malware scanner,
or trust authority. Specifically:

- A `verified` label means the project's documented checks passed for a pinned
  artifact at a point in time. It is **not** a guarantee of safety, correctness,
  or future integrity.
- `npm audit` in CI reports known advisories for this project's dependency tree only.
  It cannot detect unknown vulnerabilities or malicious packages.
- npm provenance proves which repository/workflow built a package; it does not
  prove the source is benign.
- Release tags are expected to be signed by a maintainer, but CI verifies only
  that the tag exists, not its signature. Verify locally with
  `git tag -v <tag>` before trusting a release.
- Release checksums protect the integrity of the files this project publishes;
  they do not protect upstream candidate artifacts.
- Trust and risk metadata can be incomplete, stale, or wrong. Snapshot age and
  provenance are displayed so users can judge.
- The recommendation benchmark is a quality gate for this project's fixtures. It
  is not a safety proof.
- No automated system can decide whether a third-party plugin is appropriate for
  your environment. Human approval and review remain required.

## Disclosure

Report vulnerabilities privately through GitHub Security Advisories:
<https://github.com/adarshj322/plugin-detector/security/advisories/new>. Do not
open a public issue for an unfixed vulnerability. See [SECURITY.md](../SECURITY.md)
for scope, response targets, and safe-harbor terms.

## Known v0.1 limits

These are tracked as v1.0 gates in the changelog:

- no persistent local log/retention implementation yet;
- adapter compatibility is displayed and hard-gated only at zero, not multiplied
  into the score in `recommend`;
- Codex and Cursor mutation is recipe-only;
- the bundled registry snapshot is a seed/placeholder until a reviewed live
  refresh is committed;
- coverage thresholds (85% core / 100% rollback/write paths) are not yet enforced
  by a coverage tool in CI.

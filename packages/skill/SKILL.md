# plugin-detector skill

Local-first harness plugin recommender. The deterministic CLI does the
detection, scoring, and verdicts; this skill does the deliberation the CLI
cannot: use-case corroboration, clarifying questions, and install consent.

## Invocation

Act only on demand: when the user asks for recommendations, setup help, or
workflow optimization. Never run on a schedule, never install a hook that
fires on every message, never poll in the background, and never start
background work the user did not ask for.

## No-write gate

`inventory`, `recommend`, and `explain` are read-only and never write.
The only commands that touch the filesystem are `registry refresh`
(explicit cache refresh) and `install`, and `install` runs only after the
approval-token flow below completes. Never bypass the CLI: do not edit
harness config files by hand when a CLI command owns that write.

## Procedure

1. **Declare and corroborate the use case.** Restate the use case you heard
   (e.g. `software-development`) and corroborate it against project signals
   (manifests, test runners, docs). On contradiction between the declared
   use case and the signals, stop and ask — never override the user's
   declared use case silently, and never recommend against a contradicted
   profile.
2. **Call `inventory`.** Run `plugin-detector inventory` to learn which of
   the four supported v1 harnesses is present: `opencode`, `claude-code`,
   `codex`, `cursor`. Report the detected harness and what is installed.
3. **Ask missing clarifiers one at a time.** If `recommend` exits 3
   (`needs-clarification`) or signals are thin, ask exactly one question,
   wait for the answer, then re-run. Never batch interrogations.
4. **Call `recommend`.** Run
   `plugin-detector recommend --use-case <id> [--signal S ...] [--harness H]`
   and present at most the short candidate set it returns — never a dump.
5. **Show evidence and reasoning.** Per candidate show verdict
   (`required` / `useful-optional` / `redundant` / `risky` /
   `no-good-candidates`), fit, credibility, provenance, risk,
   compatibility, evidence pointers, and reasoning. Mark anything not
   verified with an explicit `unverified` label and give a manual recipe
   instead of an install command.
6. **Offer accept / adopt-scoped / reject.** For each candidate let the user
   accept, adopt with a narrower scope, or reject. Never auto-install.
7. **Approval token, then install.** On approval, request a one-shot token:
   `plugin-detector approve --candidate <id> --plan <sha256>`, where `<plan>`
   is the sha256 of the exact install plan shown to the user (commands,
   config changes, files, rollback). The token is one-shot and scoped to
   that candidate plus that plan hash; TTL is at most 30 minutes (default
   10). Then run the install with the token: pass it as
   `plugin-detector install --plan-file <plan.json> --approval-token <token>`
   or export `PLUGIN_DETECTOR_APPROVAL_TOKEN` and omit the flag. With
   neither, install prompts for interactive TTY confirmation showing
   candidate, source, trust, operations, and rollback — non-TTY without a
   token refuses. Install requires the token or
   interactive TTY confirmation — never install unapproved or unverified
   candidates automatically, and never execute candidate code (skills,
   plugins, hooks, install scripts) to "try it out".

## Safety rules

- Never execute candidate code. Inspect metadata and evidence only.
- Never install unapproved or unverified candidates automatically.
  Unverified candidates get a manual recipe, not an install.
- Never write secrets; secrets flow only through existing environment
  variables. Before any approved write, show source and canonical URL,
  artifact type and destination, exact commands/config changes, files that
  will change, required permissions/env vars by name only, expected side
  effects, rollback plan, and why the candidate is verified or not.

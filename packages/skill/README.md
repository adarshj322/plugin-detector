# @plugin-detector/skill

Agent skill for [plugin-detector](https://github.com/adarshj322/plugin-detector):
on-demand recommendation, installed-lifecycle review, and the consent workflow.

## What it does

The skill drives the deterministic CLI: declare/corroborate a use case, inventory
every artifact kind a harness can use (skills, plugins, MCP servers, hooks,
commands, agents, and the curated host-wide external CLIs), then present the
short candidate set and the installed lifecycle.

`recommend` reports installed artifacts separately from new candidates:

- `keep` — no better candidate, unknown/current version, no added capability, or
  a candidate that would drop a capability.
- `upgrade` — same tool identity with a newer comparable version.
- `replace` — same kind, capability superset, threshold met, and proven
  outdatedness.
- `review` — locally modified; manual review before any change.

`upgrade`/`replace` rows carry **print-only recipes** ending with the approval
note. Never execute them, never edit harness config by hand, and never treat a
recipe as consent. The existing `plan` → `approve` → `install` flow remains the
only write path (and Codex/Cursor remain recipe-only).

Version checks are opt-in: `recommend --check-updates` / `inventory
--check-updates` are the only network paths. Without the flag, versions stay
`unknown`. PATH-sourced CLIs stay unknown even with the flag.

Known limits: no automatic remove/upgrade; path-installed skills and globally
declared plugins often have no installed version; version/source fields are
best-effort and Codex/Cursor inventories may be partial; the external CLI list is
fixed (`git`, `gh`, `docker`, `kubectl`, `rg`, `jq`, `playwright`, `ffmpeg`,
`node`, `npm`, `python3`, `uv`); and `recommend` has no `--skip-external` in
v0.1.

## Install

The skill is installed manually in v0.1; there is no self-installer. Copy
`SKILL.md`, `agents`, `assets`, and `scripts` into your harness skill directory,
and keep the `plugin-detector` binary on `PATH` (or reachable through `npx`).
See the install instructions at
<https://github.com/adarshj322/plugin-detector#install-the-harness-skill>.

License: MIT. See [LICENSE](LICENSE).

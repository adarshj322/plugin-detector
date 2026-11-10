# Registry review — 2026-11-10

## Scope

Live evidence refresh focused on software-development discovery, plus the
generic sources.

- Command: `registry refresh --limit 120 --cache-dir packages/registry/data`
- Source cap: 30 candidates per source, ordered by installs/stars
- Expanded queries: software-development keywords and GitHub developer topics
- Snapshot generatedAt: refreshed 2026-11-10
- Review artifact: `packages/registry/data/registry-review.json`

## Source health

| Source | Status | Count |
|---|---|---|
| skills.sh | ok | 4 |
| MCP registry | ok | 0 |
| GitHub | ok | 0 |
| awesome-lists | failed | 404 for the configured raw URL |

GitHub and MCP returned no capability-classified records in this run. Their
source health is visible in the review artifact; no evidence was fabricated.

## Outcome

- Accepted in the snapshot: **6**
- Preserved from the previous reviewed seed: **2**
- Probed but unclassified (empty capability evidence): **36**
- Rejected at intake/probe/normalize: **38**

Accepted records:

| Candidate | Type | License | Capabilities |
|---|---|---|---|
| heygen-com/hyperframes | plugin | Apache-2.0 | speech.captions |
| mattpocock/skills/code-review | skill | unknown | code-review.quality |
| ruvnet/ruflo | skill | MIT | planning.orchestration |
| supabase/agent-skills/supabase-postgres-best-practices | skill | MIT | data.database |
| vercel-labs/agent-browser/agent-browser | skill | unknown | browser.automation |
| vercel-labs/agent-skills/vercel-react-best-practices | skill | MIT | design.frontend |

## Recommendation smoke test

After profile-threshold calibration:

- `software-development` → **required** (agent-browser, vercel-react-best-practices)
- `video-editing` → **required** (hyperframes)
- `data-analysis` → **required** (ruflo)
- `design-frontend` → **required** (vercel-react-best-practices)
- `research-writing` → `no-good-candidates`

The snapshot is still small, but it now produces justified recommendations for
the primary use cases instead of a blanket `no-good-candidates`.

## Decision

This is the first reviewed, evidence-probed software-development-focused seed.
It is intentionally thin. Keep as v1.0 evidence seed and continue to final
quality and live-harness verification; do not call it production-ready until
the corpus is broader and installation is tested on each harness.

No installation is enabled from unprobed records. The release remains
`0.1.0-alpha`.

# Registry review — 2026-11-10

## Scope

First live evidence refresh after v1.0 probing integration.

- Command: `registry refresh --limit 120 --cache-dir packages/registry/data`
- Source cap: 30 candidates per source, ordered by installs/stars
- Snapshot generatedAt: `2026-11-10T10:54:18.106Z`
- Review artifact: `packages/registry/data/registry-review.json`

## Source health

| Source | Status | Count |
|---|---|---|
| skills.sh | ok | 4 |
| MCP registry | ok | 3 |
| GitHub | ok | 14 |
| awesome-lists | failed | 404 for the configured raw URL |

## Outcome

- Candidates probed: **21**
- Kept after review: **4**
- Excluded for empty capabilities: **17**
- Rejected at intake/probe/normalize: **57**

The current review artifact reports 4 probed + 57 rejected = 61 rows because
the 17 probed-but-unclassified candidates are not yet retained in the manifest.
That visibility gap is a follow-up for the review report.

Accepted records:

| Candidate | Type | License | Capabilities |
|---|---|---|---|
| heygen-com/hyperframes | plugin | Apache-2.0 | speech.captions |
| ruvnet/ruflo | skill | MIT | planning.orchestration |
| vercel-labs/agent-browser/agent-browser | skill | unknown | browser.automation |
| vercel-labs/agent-skills/vercel-react-best-practices | skill | MIT | design.frontend |

## Recommendation smoke test

After profile-threshold calibration:

- `software-development` → **required** (agent-browser, vercel-react-best-practices)
- `video-editing` → **required** (hyperframes)
- `data-analysis` → **required** (ruflo)
- `design-frontend` → **required** (vercel-react-best-practices)
- `research-writing` → `no-good-candidates` (no matching evidence-backed candidate yet)

The snapshot is deliberately small, but it now produces justified recommendations
for the main use cases instead of a blanket `no-good-candidates`.

## Decision

The snapshot is committed as the **first evidence-probed v1.0 review seed**. It is
still thin, but it meets the minimum recommendation gate for software, video,
data, and design. Continue to Task 12 and the final quality gate; keep research
writing and broader MCP/plugin coverage as follow-ups.

No installation is enabled from unprobed records. The release remains
`0.1.0-alpha`.

No installation is enabled from unprobed records. The release remains
`0.1.0-alpha`.

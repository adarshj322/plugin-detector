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

`recommend` returns `no-good-candidates` for software-development and
data-analysis. `video-editing` scores hyperframes at 11.2 but still returns
`no-good-candidates`; `design-frontend` scores the Vercel skill at 5.5.

The scoring threshold and profile capability mappings are too strict for
community-probed tools: a legitimate MIT/Apache, active, evidence-backed
candidate cannot reach the `required` threshold unless it is official or
publisher-verified. This is the next v1.0 quality gate, not a reason to relabel
the snapshot.

## Decision

The snapshot is committed as an **evidence-probed review seed**, not a v1.0
recommendation corpus. v1.0 remains blocked until:

1. review reports retain probed-but-excluded candidates;
2. capability inference covers more MCP/plugin descriptions without false
   positives;
3. the profile mappings and/or required threshold make genuinely high-value
   community tools recommendable;
4. at least one justified `required` recommendation appears for a dev and a
   non-dev use case.

No installation is enabled from unprobed records. The release remains
`0.1.0-alpha`.

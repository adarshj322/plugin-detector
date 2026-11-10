# Registry review — 2026-11-10

## Scope

First live evidence refresh after v1.0 probing integration.

- Command: `registry refresh --limit 120 --cache-dir packages/registry/data`
- Source cap: 30 candidates per source (120 total budget)
- Snapshot generatedAt: `2026-11-10T10:35:19.149Z`
- Review artifact: `packages/registry/data/registry-review.json`

## Source health

| Source | Status | Count |
|---|---|---|
| skills.sh | ok | 29 |
| MCP registry | ok | 3 |
| GitHub | ok | 10 |
| awesome-lists | failed | 404 for the configured raw URL |

The awesome-list endpoint remains broken and is tracked as a source-health issue, not hidden.

## Outcome

- Probed candidates written to the snapshot: **42**
- Rejected at intake/probe/normalize: **36**
- Kept after review: **11**
- Excluded from the reviewed snapshot for empty capabilities or misclassified inference: **31**

The 11 accepted records are the capability-classified, evidence-backed candidates. They are all `skill` artifacts. No MCP or plugin candidates survived the capability threshold yet, so the snapshot is **thin** and not yet a v1.0 recommendation corpus.

Accepted records:

| Candidate | Type | License | Capabilities |
|---|---|---|---|
| 101-skills/superpowers/agent-browser | skill | unknown | browser.automation |
| 101-skills/superpowers/agent-tools | skill | unknown | media.image, search.web |
| 101-skills/superpowers/infsh-cli | skill | unknown | media.image, search.web |
| Astro-Han/karpathy-llm-wiki | skill | MIT | code-review.quality |
| addyosmani/agent-skills/browser-testing-with-devtools | skill | unknown | browser.automation |
| addyosmani/agent-skills/code-review-and-quality | skill | unknown | code-review.quality |
| affaan-m/ecc/browser-qa | skill | unknown | browser.automation |
| affaan-m/ecc/django-tdd | skill | unknown | testing.runner |
| affaan-m/ecc/dmux-workflows | skill | unknown | planning.orchestration |
| affaan-m/ecc/docker-patterns | skill | unknown | containers.orchestration |
| affaan-m/ecc/e2e-testing | skill | unknown | browser.automation, testing.e2e |

## Recommendation smoke test

`recommend --use-case software-development --cache-dir packages/registry/data` returns
`no-good-candidates`; the top five are `useful-optional` with scores from 0 to 4.4.
`video-editing` and `data-analysis` also return `no-good-candidates`.

This is a quality failure for the product promise, not a reason to relabel the snapshot.
The main causes are:

- The current capability table does not classify most MCP/plugin records (they have empty
  capabilities and are excluded).
- Most accepted skill records have unknown licenses and unknown maintenance, so their
  credibility score is low.
- The snapshot has no high-value non-skill candidates yet.

## Decision

The snapshot is committed as an **evidence-probed review seed**, not as a v1.0
recommendation corpus. v1.0 is blocked until:

1. capability inference covers MCP/plugin manifests without false positives;
2. licenses and maintenance evidence are populated where the source provides them;
3. a reviewed snapshot produces at least one justified `required` recommendation for
   software-development and one non-development use case.

No installation is enabled from unprobed records. The release remains `0.1.0-alpha`.

# Registry review — 2026-11-22

Reviewed snapshot: `packages/registry/data/registry-snapshot.json`
Generated: `2026-11-22T06:10:26.929Z`
Candidates: **166** (all with probed artifact evidence)
Review command: `plugin-detector registry review --cache-dir packages/registry/data`

This replaces the 2026-11-10 thin seed (6 candidates). It is a refreshed
**seed**, not a v1.0 close: trust, license, and maintenance coverage remain
partial, and installs from community sources stay recipe-only.

## Source health

| Source | Status | Probed |
| --- | --- | --- |
| `skills.sh/api/search` | OK | 133 |
| `api.github.com/search/repositories` | OK | 22 |
| `quemsah/awesome-claude-plugins` (raw README) | OK | 14 |
| `registry.modelcontextprotocol.io/v0/servers` | OK (empty) | 0 |

The dead `anthropics/awesome-claude-plugins` URL was replaced with
`quemsah/awesome-claude-plugins` before this refresh. No source failed.

## Intake

- Listings considered: 1009
- Probed and accepted: 166
- Unprobed: 398
- Rejected: 445

Top rejection reasons are explained, not hidden: no supported artifact
manifest (234), package name not matching the listing repo (52), package
manifest without a version (29), install hooks that execute publisher code at
install time (44 combined), reserved package prefixes (14), and non-GitHub
repository hosts (14). Listing-only records never enter the snapshot.

## Candidate profile

| Dimension | Value |
| --- | --- |
| Types | 139 skill, 18 plugin, 7 tool, 2 mcp-server |
| Capability classified | 166 / 166 |
| License known | 61 / 166 |
| Maintenance known | 22 / 166 (`active`; 144 `unknown`) |
| Trust | 166 `unverified` (community sources) |
| Mutable pins | none |

Top capabilities: `code-review.quality` (37), `browser.automation` (30),
`media.image` (22), `search.web` (22), `data.database` (19),
`testing.runner` (14), `design.frontend` (11), `planning.orchestration` (8).

## Duplicate mirrors

Eight artifact names appear from multiple source listings (45 records total),
for example `agent-browser` from 10 mirrors, `code-review` from 10 publishers,
and `agent-tools`/`infsh-cli` from 8–9 mirrors. The snapshot keeps each
source's evidence record; `recommend` now collapses the top-5 and lifecycle
candidate set to one record per artifact name and kind, keeping the
best-scored representative. Lifecycle rows can therefore never propose the
same artifact twice through different mirrors.

## Profile results with this snapshot

| Profile | Verdict | Top candidates |
| --- | --- | --- |
| software-development | `required` | `anthropics/claude-code/frontend-design`, `anthropics/skills/web-artifacts-builder`, `vercel-labs/agent-skills/vercel-react-best-practices`, `usestrix/strix/application-security-testing`, `wshobson/agents/github-actions-templates` |
| design-frontend | `required` | same frontend trio plus `youtube-thumbnail-design`, `video-shotcraft` |
| video-editing | `required` | `heygen-com/hyperframes`, `op7418/guizang-social-card-skill`, `renezander030/capcut-cli`, `sergebulaev/instagram-skills`, `youtube-thumbnail-design` |
| data-analysis | `no-good-candidates` | `ruvnet/ruflo` is `planning.orchestration`, which no longer clears the data threshold |
| research-writing | `no-good-candidates` | no evidence-backed candidate clears the threshold |
| devops-infrastructure | `no-good-candidates` | only `useful-optional` candidates |

The benchmark still passes on its frozen fixtures: mean precision@5 `0.920`,
0 offenders. The snapshot change does not move the benchmark baseline.

## Decision

**Accept as the refreshed seed.** Every accepted candidate has probed artifact
evidence, a license field, an immutable pin, and at least one canonical
capability. Every source is healthy. Rejections and unprobed listings remain
in the manifest for audit.

Remaining v1.0 gaps, deliberately not waived:

- all 166 candidates are `unverified`, so install plans are recipes only;
- license coverage is 61/166 and maintenance evidence is 22/166;
- data-analysis, research-writing, and devops-infrastructure still return
  `no-good-candidates`;
- 398 listings were not probed and 445 were rejected; the reasons are recorded
  in `registry-review.json` and the manifest.

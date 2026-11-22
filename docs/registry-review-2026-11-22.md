# Registry review — 2026-11-22

Reviewed snapshot: `packages/registry/data/registry-snapshot.json`
Generated: `2026-11-22T10:50:45.869Z`
Candidates: **35** (all with probed artifact evidence)
Review command: `plugin-detector registry review --cache-dir packages/registry/data`

This replaces the 2026-11-10 thin seed (6 candidates). It is a refreshed
**seed**, not a v1.0 close: coverage is bounded and most candidates remain
unverified, but four official publisher skills are now verified and installable
through the consent path.

## Refresh scope

The unbounded refresh probes roughly 1,000 listings and exceeded a 45-minute
run on this host. This snapshot was refreshed with `--limit 400` (100 listings
per source) so the release operation stays bounded. That cap is the main reason
the corpus is 35 rather than the 166-candidate unbounded result. The cap keeps
the highest-popularity listings where a source supplies popularity, and the
source's own ordering otherwise.

## Source health

| Source | Status | Probed |
| --- | --- | --- |
| `skills.sh/api/search` | OK | 21 |
| `api.github.com/search/repositories` | OK | 3 |
| `quemsah/awesome-claude-plugins` (raw README) | OK | 11 |
| `registry.modelcontextprotocol.io/v0/servers` | OK (empty) | 0 |

The dead `anthropics/awesome-claude-plugins` URL was replaced with
`quemsah/awesome-claude-plugins`. No source failed.

## Intake

- Listings considered: 229
- Probed and accepted: 35
- Preserved from the prior snapshot: 11
- Unprobed: 99
- Rejected: 95

Rejections remain in the manifest with their reasons (missing supported
artifact, package/repository mismatch, install hooks that execute publisher
code, reserved prefixes, non-GitHub hosts). Listing-only records never enter
the snapshot.

## Candidate profile

| Dimension | Value |
| --- | --- |
| Types | 24 skill, 11 plugin |
| Capability classified | 35 / 35 |
| License known | 21 / 35 |
| Maintenance known | 8 / 35 (`active`; 27 `unknown`) |
| Trust | **4 verified**, 31 unverified |
| Mutable pins | none |

Verified candidates:

- `supabase/agent-skills/supabase`
- `supabase/agent-skills/supabase-postgres-best-practices`
- `vercel-labs/agent-browser/agent-browser`
- `vercel-labs/agent-skills/vercel-react-best-practices`

Publisher enrichment filled missing license and activity from the public GitHub
repository endpoint for allowlisted orgs. `anthropics` candidates remain
unverified because their artifact license is a custom license
(`Complete terms in LICENSE.txt`), not an open SPDX license.

Top capabilities: `browser.automation` (8), `data.database` (7),
`design.frontend` (6), `planning.orchestration` (4),
`code-review.quality` (4), `media.video` (3).

## Duplicate mirrors

`agent-browser` appears from five source listings. The snapshot keeps each
source's evidence record; `recommend` collapses top-5 and lifecycle candidates
to one record per artifact name and kind, keeping the best-scored
representative. No duplicate consumed multiple recommendation slots.

## Profile results with this snapshot

| Profile | Verdict | Top candidates |
| --- | --- | --- |
| software-development | `required` | `vercel-labs/agent-skills/vercel-react-best-practices` (verified), then optional design/video tools |
| design-frontend | `required` | `vercel-react-best-practices` (verified), `frontend-slides`, `impeccable`, `daisyui` |
| video-editing | `required` | `heygen-com/hyperframes`, `runcomfy` video skills |
| data-analysis | `no-good-candidates` | no candidate clears the data threshold |
| research-writing | `no-good-candidates` | no candidate clears the threshold |
| devops-infrastructure | `no-good-candidates` | no candidate clears the threshold |

The benchmark still passes on its frozen fixtures: mean precision@5 `0.920`,
0 offenders.

## Decision

**Accept as the refreshed seed.** Every accepted candidate has probed artifact
evidence, a license field, an immutable pin, and at least one canonical
capability. Every source is healthy. Four official publisher skills are
verified; the rest are recipe-only.

Remaining v1.0 gaps, deliberately not waived:

- only 4/35 candidates are verified; 31 remain community/unverified;
- license coverage is 21/35 and maintenance evidence is 8/35;
- the bounded refresh drops lower-popularity listings that an unbounded run
  would include;
- data-analysis, research-writing, and devops-infrastructure still return
  `no-good-candidates`;
- 99 listings were unprobed and 95 rejected; the reasons are recorded in
  `registry-review.json` and the manifest.

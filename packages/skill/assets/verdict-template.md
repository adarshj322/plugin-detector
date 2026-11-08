# Verdict template

Copy one block per candidate. Keep every field; mark unknowns explicitly.

## <candidate name> (`<candidate id>`)

- **Verdict:** required | useful-optional | redundant | risky
- **Verification:** verified | unverified
- **Fit:** <why this matches the declared use case>
- **Credibility:** <source standing, maintenance, audit status>
- **Provenance:** <official marketplace / verified publisher / community>
- **Risk:** <permissions, drift, maintenance concerns>
- **Compatibility:** <harness: opencode | claude-code | codex | cursor>
- **Evidence pointers:**
  - source: <canonical URL>
  - registry: <snapshot entry + timestamp>
  - verification: <last_verified, pinned ref, checksum/attestation>
  - reasoning: <score breakdown, overlap with installed capabilities>
- **Install plan:** <exact commands/config changes, files that will change,
  required permissions/env vars by name only, side effects, rollback plan>

> UNVERIFIED — manual recipe only, no automatic install:
> <step-by-step manual recipe, or "none — rejected as too risky">

## No-good-candidates

When no candidate clears the bar, say so explicitly:
"No good candidates found." Give the closest misses and what would change
the answer — never pad the list with noise.

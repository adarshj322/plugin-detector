# Reviewing a registry snapshot

`registry review` is the human-review step between a live refresh and a
committed snapshot. It reads the local registry snapshot and refresh manifest
and produces one report: what was accepted with artifact evidence, what was
listed but never probed, and what was rejected at intake.

**The report is not a certification.** It does not audit code, sandbox an
artifact, or guarantee safety. It is a local evidence sheet that makes a
snapshot review possible and repeatable. Trust classes are policy labels
(`verified`, `curated`, `unverified`); a `verified` label still reflects only
the checks described here. Read the evidence yourself before accepting a
candidate.

## Command

```bash
# Read the local cache and print the review report (no writes)
plugin-detector registry review --cache-dir ~/.cache/plugin-detector

# Machine-readable report
plugin-detector registry review --cache-dir ~/.cache/plugin-detector --json

# Save the same report as JSON (writes only this file)
plugin-detector registry review --cache-dir ~/.cache/plugin-detector \
  --json --out registry-review.json
```

Inputs:

- `registry-snapshot.json` in `--cache-dir`. If that file does not exist, the
  bundled `packages/registry/data/registry-snapshot.json` is reviewed instead.
  A cache snapshot that exists but is invalid fails the review; it is never
  silently replaced by the bundled file.
- `registry-manifest.json` in the same directory, when present. A manifest
  that exists but is invalid also fails the review, because dropping it would
  hide rejected and unprobed records.

The command writes nothing by default. `--out <file>` writes only the JSON
report; it never modifies the snapshot, the manifest, or a candidate.

Exit codes: `0` report produced, `1` missing/invalid input or unwritable
`--out`, `2` usage error.

## Report fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Report schema version (`1`). |
| `generatedAt` | Time the report was produced. |
| `snapshotGeneratedAt` | Time the reviewed snapshot was produced. |
| `counts` | `total`, `probed`, `unprobed`, `rejected`. `total` is the sum. |
| `sources` | Per source URL: `probed`, `unprobed`, `rejected` counts. |
| `candidates` | Accepted (probed) candidates and their evidence. |
| `unprobed` | Listing-only records from the manifest, with reasons. |
| `rejected` | Intake refusals from the manifest, with reasons. |
| `rejectedGroups` | Rejections grouped by `(reason, sourceUrl)`, with count and IDs. |

Each accepted candidate carries:

- `id`, `name`, `artifactType`
- `sourceUrl` — the listing source the record was retrieved from
- `provenance` — `official`, `publisher`, `community`, or `unknown`
- `trust` — the snapshot trust class
- `license` — the license observed in the probed artifact (not a listing claim)
- `pinnedRef` — the immutable ref stored on the candidate
- `evidenceSource`, `evidenceRef`, `contentHash`, `evidenceSnippets` — the
  probed artifact URL, resolved ref, content hash, and short evidence excerpts
- `capabilities` — normalized capability IDs

## Workflow

1. Refresh the cache with `registry refresh` (optionally `--use-case <id>`).
2. Run `registry review --json --out registry-review.json`.
3. For every accepted candidate, verify the evidence below.
4. For every rejected or unprobed record, confirm the reason is expected. A
   hard rejection should not reappear in the snapshot; a transient source
   failure may have preserved a prior record, which still needs review.
5. Accept or reject each candidate in the snapshot, then commit the reviewed
   snapshot together with this report and its `generatedAt`.
6. Never commit a snapshot with unexplained source failures or records you did
   not inspect. The review report is not proof that this happened.

## Accept criteria

A candidate is acceptable for the curated snapshot when all of these hold:

- The artifact itself was fetched; `artifactEvidence` is present and the
  evidence source is a canonical, expected location for that artifact type.
- The publisher claim binds to the evidence: the source URL owner/repository or
  package scope matches the claimed publisher. A listing name alone is not
  identity.
- `pinnedRef` is immutable (tag, version, or digest), not `main`, `latest`,
  `HEAD`, or a `0.0.0` placeholder.
- The probed license is present and compatible with how the artifact will be
  used; an unknown or absent license needs an explicit human decision.
- `contentHash` is present, so the reviewed bytes can be recognized later.
- Evidence snippets support the candidate's name, artifact type, and
  capabilities; capabilities are not inferred from marketing copy.
- Provenance and trust match the evidence: `official`/`publisher` requires the
  binding above, otherwise the record is `community` or `unverified`.
- Maintenance and risk fields are consistent with the repository state
  (archived or stale projects need an explicit reason to stay).

Anything that fails a hard gate above is rejected; anything you cannot verify
is left out rather than accepted on trust.

## Reject criteria

Reject or exclude a record when any of these hold:

- It is listing-only: no `artifactEvidence`, or the probe was never performed.
- The artifact is missing, invalid, oversized, or does not match the listing's
  identity (repository/package mismatch).
- The pin is mutable, absent, or a `0.0.0` placeholder.
- The artifact declares install hooks or executes code during installation in
  a way the review cannot justify.
- Prompt-injection or suspicious untrusted copy is present in the artifact.
- The license is missing, incompatible, or contradicts the listing.
- The project is archived, deprecated, or the maintainer identity cannot be
  established.
- The rejection reason is not understood. An unexplained rejection is a
  blocker for accepting that ID, not a reason to ignore it.

Repeated refusals are grouped by `(reason, sourceUrl)` so a systematic source
problem (for example, one query always returning a bad artifact shape) is
visible instead of being buried in individual records.

## Limits

- The report reflects the last refresh, not the live internet. A candidate can
  change upstream after it was probed; the content hash records what was
  reviewed, not what ships tomorrow.
- Rejected and unprobed records come from the **current** refresh manifest.
  Earlier runs are replaced when a new manifest is written.
- No network access, no artifact execution, and no LLM call happens during
  review.
- The report is guidance for a human decision. It is not a security audit, not
  a signature, and not a substitute for reading the probed evidence.

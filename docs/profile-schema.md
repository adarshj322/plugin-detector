# Profile schema (v1)

A profile maps one declared use case to capability domains, corroborating project
signals, contradictory signals, and expected value tiers. Profiles are versioned
with the schema and loaded from `packages/profiles/profiles/*.yaml`.

```bash
# Validate one profile without network access or writes
npx plugin-detector profiles validate path/to/profile.yaml
```

## Fields

| Field | Type | Constraints | Meaning |
| --- | --- | --- | --- |
| `id` | string | non-empty | Stable profile id used by `--use-case`. Lowercased for lookup. |
| `version` | integer | > 0 | Profile schema revision, not a package version. |
| `displayName` | string | non-empty | Human label. |
| `description` | string | non-empty | One-sentence scope. |
| `capabilities` | string[] | at least 1, canonical IDs only | Domains this use case needs. Used for fit and overlap. |
| `signalQueries` | string[] | 5–12 items | Positive project signals that corroborate the declaration. |
| `negativeSignals` | string[] | at least 1 item | Signals that contradict the declaration and force a clarifying question. |
| `defaultDomains` | string[] | at least 1 item | Declarative defaults for profile authors; **not consumed by `recommend` in v0.1**. |
| `expectedValueTiers` | string[] | at least 1 item | Declarative value statement; **not consumed by scoring in v0.1**. |

Capability IDs must be exact values from the shared taxonomy. The complete v1
set is:

```text
testing.runner            testing.e2e              code-review.quality
code-review.security      planning.orchestration   planning.brainstorm
debugging.systematic      vcs.workflow              ci.release
containers.orchestration  docs.writing              design.frontend
design.thumbnail          data.analysis             media.transcode
speech.captions           publishing.delivery       security.dependencies
harness.management
```

Aliases are accepted only for the explicit table in
`packages/core/src/taxonomy.ts` (for example `e2e`, `transcoding`, `cicd`).
Ambiguous shorthands resolve to `null`; add taxonomy entries through an
ADR-style change, never by ad-hoc string matching in an adapter.

## YAML subset

Profiles use a deliberately small YAML subset so the loader needs no YAML
dependency:

- top-level `key: scalar` pairs;
- top-level `key:` followed by `- item` list entries;
- `#` comments and blank lines;
- quoted or unquoted scalars; integer scalars become numbers.

Not supported (the file is rejected, never guessed): nested maps, inline
collections (`[]`, `{}`), tabs, block scalars, anchors, aliases, multiline
strings, and duplicate keys. Keep profiles flat.

## Example

```yaml
# v1 use-case profile: video editing and publishing.
id: video-editing
version: 1
displayName: Video Editing
description: Editing video, captioning audio, and publishing with thumbnails.
capabilities:
  - media.transcode
  - speech.captions
  - design.thumbnail
signalQueries:
  - premiere-project
  - final-cut-library
  - davinci-project
  - ffmpeg-preset
  - caption-track
  - thumbnail-brief
negativeSignals:
  - python-manifest
  - pytest
  - package-manifest
defaultDomains:
  - publishing
  - cleanup
expectedValueTiers:
  - time-saved
  - quality-uplift
```

## Resolution semantics

`resolveProfile({ declaration, projectSignals })` returns one of:

| Status | Meaning | CLI behavior |
| --- | --- | --- |
| `match` | Declaration is known and evidence corroborates it. | Recommendation proceeds. |
| `partial` | Declaration is known; signals are thin or mixed. | Recommendation proceeds with lower signal fit; the skill may ask one clarifier. |
| `contradiction` | Negative signals are present, or another profile's positive signals win while the declaration has none. | `recommend` exits `3` (`needs-clarification`) and searches/returns nothing. Never silently overrides the user. |
| `unknown` | The declaration is not a known profile id. | `recommend` exits `2` and lists valid ids. |

Project signals never replace the declared use case. On contradiction the skill
must ask which workflow is correct, then re-run with the resolved declaration.

## Adding a profile

1. Add `packages/profiles/profiles/<id>.yaml` with at least five positive
   signals and at least one negative signal.
2. Use only canonical capability IDs.
3. Add or update benchmark workflows under `fixtures/benchmark/workflows/` so the
   new profile is exercised by the release-blocking gate.
4. Run `npm test` and `npm run benchmark`.
5. Update this document if a field constraint changes.

Profiles are versioned data, not executable code. Do not add a field that hides a
scoring weight or trust threshold from the user.

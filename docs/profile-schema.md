# Profile schema (v1)

A profile maps one declared use case to capability domains, corroborating project
signals, contradictory signals, and expected value tiers. Profiles are versioned
with the schema and loaded from `packages/profiles/profiles/*.yaml` as built-ins;
a custom profile can be loaded from any path with `--profile <file>`.

```bash
# List built-in ids and display names
npx plugin-detector profiles list

# Scaffold a custom profile, then edit and validate it
npx plugin-detector profiles init path/to/profile.yaml
npx plugin-detector profiles validate path/to/profile.yaml

# Recommend or boost discovery with a custom profile
npx plugin-detector recommend --profile path/to/profile.yaml --signal project-readme
npx plugin-detector registry refresh --profile path/to/profile.yaml
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
| `requiredThreshold` | number | 0–100, optional | Score a candidate must reach for a `required` verdict. Defaults to `55`. Applies only to recommendations, never trust or install policy. |

Capability IDs must be exact values from the shared taxonomy. The complete v1
set is:

```text
testing.runner            testing.e2e              code-review.quality
code-review.security      planning.orchestration   planning.brainstorm
debugging.systematic      vcs.workflow             ci.release
containers.orchestration  cloud.infra              docs.writing
design.frontend           design.thumbnail         data.analysis
data.database             browser.automation       search.web
media.transcode           media.video              media.image
speech.captions           collaboration.chat       publishing.delivery
security.dependencies     harness.management       memory.context
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
- **full-line** `#` comments and blank lines (an inline `# ...` is scalar text,
  not a comment);
- quoted or unquoted scalars; integer scalars become numbers.

The loader does not interpret YAML beyond that subset:

- anchors (`&name`), aliases (`*name`), and block scalar indicators (`|`, `>`)
  are kept as literal scalar text; there is no anchor/alias resolution and no
  multiline string support. A block scalar body is indented, so it is rejected
  as a nested map rather than guessed.
- nested maps, inline collections (`[]`, `{}` at the start of a value), tabs,
  and duplicate keys are rejected with the file and line number.

Keep profiles flat.

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

## Custom profiles

`loadProfileFile(file)` in `@plugin-detector/profiles` reads, parses, and
validates one profile file. It is uncached, so editing a file and re-running
picks up the change. A missing file or schema violation throws one error that
names the file and the failing fields. Unknown fields are rejected, so a typo
such as `requiredThreshhold` fails validation instead of silently using the
default threshold.

Create a starter with `profiles init <file>`. It writes a valid profile with
`requiredThreshold: 10` and refuses to overwrite an existing file. Edit it,
then run `profiles validate <file>`.

`recommend --profile <file>`:

- uses the custom profile's `id` as the declaration, so `--use-case` may be
  omitted;
- resolves corroboration against the built-ins plus the custom profile, with
  the custom profile winning on the same id;
- applies the custom profile's `requiredThreshold` (unless `--threshold N`
  overrides it for that run);
- exits `1` with the parse/validation error when the profile file is missing or
  invalid;
- exits `2` when `--use-case` and `--profile` are both supplied with different
  ids.

`registry refresh --profile <file>` adds the custom profile's `signalQueries`
to discovery queries only, never to evidence. Missing or invalid files exit `1`
with the same error. `--use-case` remains supported for built-ins.

Custom profiles never change trust, consent, or install behavior. They are
local recommendation input.

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

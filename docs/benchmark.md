# Recommendation benchmark and precision@5 gate

The benchmark is a **release-blocking recommendation-quality gate**, not a
correctness or security proof. It answers one narrow question: on a set of
labeled workflows, does the fit-based recommendation engine keep low-value,
popular-but-irrelevant candidates out of the `required` top-5, and does it beat
a popularity-only ranking on the same fixtures?

> **Passing CI does not prove safety.** It does not certify that any candidate is
> safe, that scores are calibrated, or that installs are trustworthy. It proves
> only that the recommendation gate *defined by this project* (fixtures, labels,
> baseline, and `--fail-on-low-value`) passes. Per the spec, v1.0 does not ship
> until this gate passes; that is a release requirement, not a safety guarantee.

## Running it

```bash
npm run build
npm run benchmark -w plugin-detector
# equivalent, from the repo root:
npx plugin-detector benchmark --fixtures fixtures/benchmark --fail-on-low-value
# or directly, with no bin linking:
node packages/cli/dist/src/index.js benchmark --fixtures fixtures/benchmark --fail-on-low-value
```

CI runs the same gate as the `benchmark` job in `.github/workflows/ci.yml`. The
command is fully offline: it reads only `fixtures/benchmark/` (workflows +
`baselines/popular-repo.json`) and the bundled profiles. It never touches the
registry cache and never opens a network connection.

`--fail-on-low-value` turns the report into a gate. Without it, the command
prints the report and exits 0; with it, any offender or any workflow that fails
to beat the baseline makes the command exit 1, which fails CI.

## What is measured

- Each workflow declares a use case (`declaration`), project `signals`, an
  optional installed-harness `inventory`, a candidate corpus, capability labels
  (`requiredCapabilities`, `optionalCapabilities`), expected verdict IDs
  (`expectedRequiredIds`, `expectedRedundantIds`, `expectedOptionalIds`),
  `unacceptableIds`, and a written `rationale`. The runner reports expected
  `useful-optional` candidates that do not receive that verdict as
  `missingOptional` misses; the gate fails on any miss.
- The runner resolves the profile and scores **every** candidate through the
  production `scoreCandidate` — the same function `recommend` uses. Scoring uses
  capabilities, installed inventory, and signal match; it never reads the label
  IDs. The `id-shuffle`/non-leak test anonymizes every candidate id and asserts
  precision and scores are unchanged, proving the engine cannot pass by
  memorizing fixture ids.
- **precision@5** = (top-5 non-risky candidates whose verdict is `required`
  *and* whose capabilities overlap the workflow's `requiredCapabilities`) / 5.
  `truePositive` is capability-overlap based, never id equality. A workflow
  that cannot fill five non-risky candidates (or a baseline pool with fewer than
  five) is rejected as a corpus error instead of silently changing the
  denominator.
- **Offenders** are `required` recommendations that are either in
  `unacceptableIds` (popular-but-irrelevant) or have no relevant capability
  (low-value). Every offender is printed in the workflow line and as a `fail:`
  line; the gate fails on any of them.
- **Baseline**: `baselines/popular-repo.json` is a hand-frozen pool of twelve
  real, genuinely popular repositories (for example Linux, React, VS Code,
  Kubernetes, Playwright), with **no fit filtering**. IDs and names are the real
  repositories; star counts were recorded 2026-11-09; capability labels are
  owner-reviewed editorial labels for what each project offers, not fit labels.
  The benchmark ranks the pool by raw stars, takes the top 5, and scores those on
  identical fixtures. A workflow
  "beats" the baseline only when the engine's precision@5 is strictly `>` the
  baseline's (a tie is not a beat — the gate recomputes this rather than trusting
  a precomputed flag). The gate also fails when mean precision@5 drops below
  `0.8` (enforced inside `gateBenchmark`/the CLI, not only in a unit assertion).
  The baseline is deliberately a star-count dump: it represents the failure
  mode the product must avoid (see the spec: "Not a star-count dump", "Rank by
  use-case fit and marginal value, never by stars alone").

## What "low-value" means

A low-value recommendation is one that adds no non-trivial marginal value for
the declared workflow — a popular repo the user could have found manually, a
candidate whose capabilities do not fit the use case, or one that merely
duplicates an already-installed capability. Concretely, in this gate:

- a `required` candidate listed in `unacceptableIds` (a popular-but-irrelevant
  repo with high stars but wrong capabilities), or
- a `required` candidate with no capability in the workflow's required or
  optional capability set, or
- a candidate that should be `redundant` (duplicates installed inventory) but
  is surfaced as `required`. The corpus deliberately includes such a case:
  `sw-redundant-git` has a high-popularity candidate (`sw-git-pop-helper`) that
  shares a domain capability but duplicates the installed `vcs.workflow`
  equivalent, so correct overlap scoring makes it `redundant`. A committed test
  removes the installed equivalent to simulate an overlap regression and proves
  the candidate then becomes `required`, is flagged as an offender, and fails
  the gate — so the offender gate is exercised by a realistic regression, not
  only by label tampering.

`requiredCapabilities` / `optionalCapabilities` / `unacceptableIds` are
capability-based labels. IDs appear only for reporting (`expectedRequiredIds`,
`expectedRedundantIds`, `expectedOptionalIds`, `unacceptableIds`) and for owner
review; they are never an input to scoring.

## Label review process

1. **Fixtures are the labels.** Each of the 30 workflows (five per domain:
   software-development, video-editing, research-writing, data-analysis,
   devops-infrastructure, design-frontend) lives in
   `fixtures/benchmark/workflows/*.yaml`. Every fixture carries a `rationale`
   explaining why its labels are what they are; research notes inform expected
   candidates but no label is copied into runtime scoring code.
2. **Project owner reviews** the expected `required` / `optional` /
   `redundant` / `unacceptable` labels against the declared workflow before a
   fixture is accepted. An additional reviewer sanity-checks labels when one is
   available.
3. **Changing a label** requires editing the fixture YAML, writing the reason
   into its `rationale`, and committing the change with a message that states
   what changed and why (e.g. `test(benchmark): reclassify X as unacceptable
   for Y — rationale`). Re-run `npm run benchmark -w plugin-detector` in
   the same commit; a label change that lowers precision or introduces an
   offender must be justified, not silenced by weakening the gate.
4. **Changing the baseline** follows the same rule: `popular-repo.json` is
   frozen. Any regeneration or edit needs a `note` update, a rationale in the
   commit, and owner review. It must remain a pure popularity ranking of real
   repositories with no fit filtering, or the comparison becomes meaningless.
   Star counts are a frozen snapshot, not a live metric; refresh them only with
   a new `frozenAt` and a review note.

## Interpreting the report

Each workflow line shows `precision@5`, `baseline`, `beat`/`FAIL`, and any
`offenders=...`. A final summary line gives workflow count, mean precision@5,
mean baseline, and total offenders. A `FAIL` or any `offenders=` value means the
engine surfaced a low-value candidate or did not strictly beat popularity-only
ranking; CI with `--fail-on-low-value` exits 1. The gate itself enforces: zero
offenders, no missing expected `required` / `redundant` / `useful-optional`
labels, every workflow strictly beating the baseline, and mean precision@5
>= 0.8. `packages/cli/test/benchmark.test.ts` asserts the same bars on the
shipped corpus, `packages/cli/test/entry.test.ts` guards CLI auto-run through
the bin symlink, and `packages/cli/test/workspace-lock.test.ts` guards the
workspace/lockfile drift that would otherwise break `npm ci` in every CI job.

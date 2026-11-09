# plugin-detector

Local-first CLI that inventories harness plugins, recommends candidates, and
installs only with explicit consent.

```bash
npx plugin-detector inventory
npx plugin-detector recommend --use-case software-development --signal tsconfig
npx plugin-detector plan --candidate CANDIDATE_ID --harness opencode --out plan.json
npx plugin-detector approve --candidate CANDIDATE_ID --plan-file plan.json
# approve prints a single-use token once; pass that token to install
npx plugin-detector install --plan-file plan.json --candidate CANDIDATE_ID \
  --harness opencode --approval-token TOKEN_FROM_APPROVE
npx plugin-detector rollback --plan-file plan.json
```

The packaged CLI is deterministic, sends no telemetry, and never installs an
unverified candidate. Read the full documentation at
<https://github.com/adarshj322/plugin-detector#readme>, including the
[security model](https://github.com/adarshj322/plugin-detector/blob/main/docs/security-model.md).

License: MIT. See [LICENSE](LICENSE).

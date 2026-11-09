# plugin-detector

Local-first CLI that inventories harness plugins, recommends candidates, and
installs only with explicit consent.

```bash
npx plugin-detector inventory
npx plugin-detector recommend --use-case software-development --signal tsconfig
npx plugin-detector plan --candidate <id> --harness opencode --out plan.json
npx plugin-detector approve --candidate <id> --plan-file plan.json
npx plugin-detector install --plan-file plan.json --candidate <id> --harness opencode
```

The packaged CLI is deterministic, sends no telemetry, and never installs an
unverified candidate. Read the full documentation at
<https://github.com/adarshj322/plugin-detector#readme>, including the
[security model](https://github.com/adarshj322/plugin-detector/blob/main/docs/security-model.md).

License: MIT. See [LICENSE](LICENSE).

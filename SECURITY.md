# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (alpha) | Security fixes best effort |
| < 0.1 | Not supported |

plugin-detector is pre-1.0. Do not rely on it as a security boundary or as a
certification of third-party software. See the [security model](docs/security-model.md).

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub Security Advisories:

<https://github.com/adarshj322/plugin-detector/security/advisories/new>

Do not open a public issue, discussion, or pull request for an unfixed
vulnerability, and do not include secrets or personal data in a report.

Include, when possible:

- affected version/commit and command or adapter;
- a minimal reproduction (fixture, config shape, plan, or input);
- impact: what can be read, written, executed, or bypassed;
- whether the issue requires a malicious candidate, a malicious local config,
  or only default behavior;
- any suggested fix or regression test.

## Scope

In scope:

- consent-gate bypasses (install without a valid token/TTY confirmation);
- read-only commands that write, or writes that escape the intended destination;
- secret values read, logged, written, or included in inventory/plan output;
- path traversal, symlink escapes, or rollback failures in managed writes;
- registry normalization, trust, drift, or snapshot-integrity bypasses;
- prompt-injection content that becomes an install action or score input;
- release workflow/provenance/checksum integrity issues.

Out of scope:

- the safety or behavior of third-party candidates (report those upstream);
- vulnerabilities in third-party dependencies that are already public and have no
  project-specific exploit path (report upstream, but tell us if it affects us);
- social engineering that requires a user to ignore the displayed plan and
  manually run arbitrary commands;
- findings that require an already-compromised local machine or root access;
- denial of service through intentionally huge local config files without a
  plausible product impact.

## Response targets

These are best-effort targets for a volunteer project, not a contractual SLA:

- acknowledgement within 3 business days;
- initial triage/severity within 7 business days;
- a fix or mitigation plan for valid high-severity reports as soon as practical;
- coordinated disclosure after a fix ships, typically within 90 days.

We will credit reporters who want credit. We will not require silence beyond the
coordinated-disclosure window.

## Safe harbor

We will not pursue legal action for good-faith security research that:

- stays within your own accounts, machines, and test fixtures;
- avoids privacy violations, data destruction, and service disruption;
- reports the issue privately and gives us reasonable time to fix it;
- does not exploit the issue beyond the minimum needed to demonstrate it.

## Supply-chain notes

- Published npm packages use npm provenance and `publishConfig.provenance`.
- GitHub Releases include SHA-256 checksums of the packed tarballs.
- Release tags must be signed by a maintainer.
- The bundled registry snapshot is reviewed before a v1.0 release; until then it
  is a clearly labeled seed/placeholder.
- `npm audit --omit=dev` runs in CI, but it only reports known advisories. It is
  not a malware scanner and is not a guarantee.

If you believe a release artifact, checksum, provenance attestation, or snapshot
was tampered with, treat it as a vulnerability and use the private advisory flow.

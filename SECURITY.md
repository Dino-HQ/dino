# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Email **security@usedino.dev** with:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Your contact information

We will acknowledge your report within 48 hours and provide a timeline for resolution within 5 business days.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | No       |

We only patch the latest release. Update to the latest version to receive security fixes.

---

## Security Model

### No Secret Storage

Dino does not persist customer code or secrets. Credentials are loaded at run start, used to obtain short-lived tokens, and discarded on completion. Nothing is written to disk beyond local scan artifacts (`.dino/` directory).

### Immutable Runs

Tenant configuration is frozen at run start. The snapshot cannot be modified during execution — not by tools, not by agents, not by the reasoning layer. This guarantees reproducibility and auditability.

### Read-Only Reasoning

The AI reasoning layer never executes tests, never calls APIs, and never mutates state. It reads deterministic output and produces structured analysis. All LLM responses are schema-validated before entering the report.

### Budget Enforcement

Per-run cost caps prevent runaway AI spending. If the budget is exceeded, reasoning degrades gracefully — the deterministic report always ships.

### Input Sanitization

All external inputs (API responses, schema descriptions, error messages) are sanitized before rendering. HTML entities are escaped. LLM inputs are stripped of potential injection patterns.

### CI Security

- SAST and SCA scanning on every pull request
- Secret detection via Gitleaks and TruffleHog
- Dependency auditing via npm audit and Aikido
- PRs blocked at High severity or above
- All GitHub Actions pinned to commit SHA

### Supply Chain

- npm packages published with Sigstore provenance
- SBOM (Software Bill of Materials) attached to every release
- `npm ci --ignore-scripts` used in CI builds

---

## Disclosure Policy

We follow coordinated disclosure. After a fix is released, we will:

1. Credit the reporter (unless they prefer anonymity)
2. Publish a security advisory on GitHub
3. Include the fix in the next release with a changelog entry

We do not offer a bug bounty program at this time.

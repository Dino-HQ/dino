# @dino-hq/cli

**An autonomous QA engineer for your APIs — in your terminal and CI.**

Point Dino at an API and it does what a QA engineer does: tests every operation for security, correctness, and breaking changes, checks that the docs match reality, and remembers your API between runs to catch drift before it ships. Autonomously, deterministically, in seconds — no test scripts to write or maintain.

```bash
npm install -g @dino-hq/cli
```

## Put your QA engineer to work in 20 seconds

No test scripts, no account, no setup. Point it at an endpoint:

```bash
# tell Dino which API to test
printf 'endpoint: https://your-api.com/graphql\nprotocol: graphql\n' > .dino.yml

# put it to work
dino scan
```

Dino introspects the schema, discovers every operation, and runs its full test suite — fuzzing, schema validation, error-contract, and rate-limit checks — then scores the health of each endpoint. Add `--fail-on-high` and it gates your CI (exits 1 on HIGH/CRITICAL).

> Ad-hoc mode supports GraphQL and REST (`--protocol rest --spec-url <url>`) plus authenticated scans (`--header` / `--token`). OAuth2 client_credentials is supported via `dino init` (env-var client id/secret). Run `dino init` for interactive setup (see [Full setup](#full-setup)). For RBAC role matrices and tenant YAML, see the [docs](https://docs.usedino.dev/).

## What your QA engineer checks

| | What Dino tests, every run |
|---|---|
| **Security** | Auth-bypass detection, RBAC matrix (every operation × every role), header injection, CORS probing, JWT none-algorithm, IP spoofing, injection payloads |
| **Correctness** | Live responses validated against the schema, type checking, required-field enforcement, error-code consistency, rate-limit detection |
| **Documentation** | Discovers the real API from introspection or OpenAPI, builds an operation catalog, flags undocumented endpoints |
| **Lifecycle** | Remembers your schema between runs — catches breaking changes, drift, and deprecations, and tracks health over time |

## Why a QA engineer, not a scanner

**It verifies, deterministically.** As AI writes more of your code, *generating* changes gets cheap — *proving* they're safe is the scarce part. Dino's verdict is deterministic machinery: same input, same finding, every run. No flaky scripts.

**It has memory.** Most tools run a scan and forget. Dino snapshots your schema and remembers it, so each run knows what changed — that's how it catches a breaking change or silent drift *before* you ship.

**It covers the whole job.** Other tools do one slice — Schemathesis fuzzes, Checkly monitors, Pact checks contracts, StackHawk runs OWASP checks. Dino does security, correctness, documentation, and lifecycle from one place, across GraphQL and REST.

## Working with your QA engineer

| Command | What it does |
|---------|--------------|
| `dino scan` | Runs the full test suite — fuzzing, validation, RBAC, rate limits, error codes, deprecation |
| `dino diff` | Compares your API to the last known-good and flags breaking changes (`--fail-on-breaking` gates CI) |
| `dino watch` | Keeps testing continuously in Shadow Mode |
| `dino docs` | Generates documentation from how the API actually behaves |
| `dino lint` | Flags undocumented operations |
| `dino changelog` | Writes a changelog from schema diffs |
| `dino init` | Interactive setup: writes a flat `.dino.yml` (endpoint, protocol, optional auth) |

## Catch breaking changes before they ship

```bash
dino diff --fail-on-breaking
```

Dino remembers your schema, compares the next run against it, and exits 1 when an operation is removed or changed — so a breaking change fails the build before it reaches your users.

## In your CI

```yaml
# with .dino.yml (endpoint + protocol) committed
- name: API QA Gate
  run: npx @dino-hq/cli scan --fail-on-high
```

Exits 1 on HIGH or CRITICAL findings. Zero findings = green build.

## Full setup

For REST/OpenAPI targets, authenticated header scans, and interactive onboarding:

```bash
dino init    # writes .dino.yml (endpoint, protocol, optional header / OAuth2 auth)
dino scan    # uses the flat config (no --tenant required)
```

For RBAC role matrices and multi-tenant YAML, see the [docs](https://docs.usedino.dev/).

Requires Node.js 22+.

[Website](https://usedino.dev) | [Docs](https://docs.usedino.dev/) | [Changelog](https://usedino.dev/changelog) | [GitHub](https://github.com/Dino-HQ/dino)

MIT License

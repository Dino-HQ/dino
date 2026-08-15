# @dino-hq/cli

**Dino is the deterministic verification layer for APIs.**

An AI agent, CI system, or developer changes an API; Dino tests the running API, evaluates the evidence, and returns a deterministic verdict on whether the change is correct, secure, and safe to ship. The same observed evidence under the same policy produces the same verdict, every run, so it is trustworthy enough to gate a deploy on.

> Agents build the software. Dino proves it works.

```bash
npm install -g @dino-hq/cli
```

## Get a verdict in 20 seconds

No test scripts, no account, no setup. Point Dino at a running endpoint:

```bash
# tell Dino which API to verify
printf 'endpoint: https://your-api.com/graphql\nprotocol: graphql\n' > .dino.yml

# run a deterministic test-and-verify pass
dino scan
```

Dino discovers every operation, tests the live API for security, correctness, contract, and documentation issues, and returns a health score per operation and one verdict for the API. Add `--fail-on-high` to gate CI: it exits `3` on any HIGH or CRITICAL finding (a reduced-coverage run exits `6` unless you pass `--accept-partial`).

> Ad-hoc mode supports GraphQL and REST (`--protocol rest --spec-url <url>`) and authenticated scans (`--header` / `--token`). OAuth2 client_credentials is supported via `dino init` (env-var client id/secret). Run `dino init` for interactive setup (see [Full setup](#full-setup)). Full docs: [usedino.dev/docs](https://usedino.dev/docs).

## Built for AI agents

A coding agent should not be the only thing deciding its own change is safe. Dino runs outside the generation loop, so the verdict is independent of whichever agent wrote the change. For an agent, Dino is a machine contract:

- **Structured JSON** on stdout (`--format json`) — the `ScanResultV1` contract, parseable with `jq`
- **Honest exit codes** for branching — `0` clean, `3` policy gate failed, `6` partial coverage, `2` usage, `4` transient, `5` config, `70` crash
- **Stable error envelopes** on stderr for recovery
- **Findings and evidence** for inspecting exactly what failed

The loop: `agent changes the API → dino scan → read verdict + exit code → agent fixes → dino scan again`

```bash
dino scan --format json --quiet --fail-on-high
```

## What Dino verifies, every run

| | |
|---|---|
| **Security** | Auth-bypass detection, RBAC matrix (every operation × every role), header injection, CORS probing, JWT none-algorithm, IP spoofing, injection payloads |
| **Correctness** | Live responses validated against the schema, type checking, required-field enforcement, error-code consistency, rate-limit detection |
| **Contracts & docs** | Discovers the real API from introspection or OpenAPI, builds an operation catalog, flags undocumented operations |
| **Lifecycle** | Remembers the API between runs to catch breaking changes, drift, and deprecations, and tracks health over time |

## Why deterministic verification, not another testing agent

**It is independent.** An agent cannot verify its own work by grading itself. Dino evaluates the running API from outside the generation loop, so the verdict does not depend on whatever produced the change.

**It is deterministic.** The same observed evidence under the same verification policy produces the same finding and verdict, every run. A result does not change because a model felt differently on another run. That reproducibility is the trust boundary.

**It verifies behaviour across the whole API.** Not a fuzzer, not a schema-diff tool, not a single-slice scanner. Dino verifies security, correctness, contracts, and documentation together, across GraphQL and REST, on every change.

## Commands

| Command | What it does |
|---------|--------------|
| `dino scan` | Runs a deterministic test-and-verify pass: security, correctness, contracts, docs |
| `dino diff` | Compares the API to the last known-good and flags breaking changes (`--fail-on-breaking` exits 3) |
| `dino watch` | Verifies continuously in Shadow Mode |
| `dino docs` | Generates documentation from how the API actually behaves |
| `dino lint` | Flags undocumented operations |
| `dino changelog` | Writes a changelog from schema diffs |
| `dino init` | Interactive setup: writes a flat `.dino.yml` (endpoint, protocol, optional auth) |

## Catch breaking changes before they ship

```bash
dino diff --fail-on-breaking
```

Dino remembers the API, compares the next run against it, and exits `3` (with `--fail-on-breaking`) when an operation is removed or changed, so a breaking change fails the build before it reaches consumers.

## In your CI

```yaml
# with .dino.yml (endpoint + protocol) committed
- name: Verify API
  run: npx @dino-hq/cli scan --fail-on-high
```

Exits `3` on HIGH or CRITICAL findings. A clean verdict is a green build.

## Full setup

For REST/OpenAPI targets, authenticated scans, and interactive onboarding:

```bash
dino init    # writes .dino.yml (endpoint, protocol, optional header / OAuth2 auth)
dino scan    # uses the flat config (no --tenant required)
```

Full documentation: [usedino.dev/docs](https://usedino.dev/docs).

Requires Node.js 22+.

[Website](https://usedino.dev) | [Docs](https://usedino.dev/docs) | [What's New](https://usedino.dev/whats-new) | [GitHub](https://github.com/Dino-HQ/dino)

MIT License

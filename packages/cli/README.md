# @dino-hq/cli

**The quality layer for APIs.**

API quality intelligence for every deploy. Security, correctness, documentation, and lifecycle — one command, both protocols.

```bash
npm install -g @dino-hq/cli
```

## One command. Complete API intelligence.

```bash
dino scan --tenant my-api --fail-on-high
```

Dino discovers your API, tests every operation across 19 attack strategies, validates responses against your schema, maps auth boundaries, and produces a health score per endpoint. GraphQL and REST. Same pipeline, same report, same CI gate.

## Four pillars, one platform

| | What Dino does |
|---|---|
| **Security** | Auth bypass detection, RBAC matrix (every operation x every role), header injection, CORS probing, JWT none-algorithm, IP spoofing, injection payloads |
| **Correctness** | Response validation against schema, type checking, required field enforcement, error consistency, rate limit detection |
| **Documentation** | API discovery from introspection or OpenAPI spec, operation catalog, undocumented endpoint detection |
| **Lifecycle** | Schema drift detection, breaking change alerts, deprecation tracking, health scores, continuous monitoring via Shadow Mode |

## Why Dino

**Unified.** Other solutions do one slice — Schemathesis fuzzes, Checkly monitors, Pact checks contracts, StackHawk runs OWASP-style checks. Dino covers security, correctness, documentation, and lifecycle from one CLI. No stitching four workflows together.

**Schema-aware.** 19 fuzz strategies across 6 attack surfaces (body, path, query, method, content-type, headers) — each driven by your API schema, not random inputs. Findings are labeled, traceable, and actionable.

**Both protocols.** GraphQL introspection and OpenAPI 3.0/3.1. Same validators, same reporting, one CI gate for mixed API surfaces.

**Zero config to start.** `dino init` generates your config. `dino scan` runs everything. `--fail-on-high` gates your CI. No test scripts to write.

## Commands

| Command | Description |
|---------|-------------|
| `dino scan` | Full quality pipeline — fuzzing, validation, RBAC, rate limits, error codes, deprecation |
| `dino watch` | Continuous monitoring with Shadow Mode |
| `dino docs` | Generate API documentation |
| `dino diff` | Detect breaking schema changes |
| `dino lint` | Find undocumented operations |
| `dino changelog` | Generate changelog from schema diffs |
| `dino validate` | Validate config |
| `dino init` | Interactive setup |

## CI gate

```yaml
- name: API Quality Gate
  run: npx @dino-hq/cli scan --tenant my-api --fail-on-high
```

Exits 1 on HIGH or CRITICAL findings. Zero findings = green build.

## Get started

```bash
npm install -g @dino-hq/cli
dino init
dino scan --tenant my-api
```

Requires Node.js 22+.

[Website](https://usedino.dev) | [Docs](https://docs.usedino.dev/) | [Changelog](https://usedino.dev/changelog) | [GitHub](https://github.com/Dino-HQ/project-dino)

MIT License

# Dino

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Dino-HQ/dino/badge)](https://scorecard.dev/viewer/?uri=github.com/Dino-HQ/dino)

**An autonomous QA engineer for your APIs in your terminal and CI.**

Point Dino at an API and it does what a QA engineer does: tests every operation for security, correctness, and breaking changes, checks that the docs match reality, and remembers your API between runs to catch drift before it ships. Autonomously, deterministically, in seconds — no test scripts to write or maintain.

```bash
npm install -g @dino-hq/cli

# tell Dino which API to test
printf 'endpoint: https://your-api.com/graphql\nprotocol: graphql\n' > .dino.yml

# put it to work
dino scan
```

That's the whole quickstart — no account, no setup. Dino introspects the schema, discovers every operation, runs its full test suite, and scores the health of each endpoint. Add `--fail-on-high`, and it gates CI (exits 1 on HIGH/CRITICAL).

> Ad-hoc mode is GraphQL, unauthenticated. For REST/OpenAPI, authenticated scans, RBAC role matrices, and per-operation coverage, run `dino init` to fully onboard your API.

---

## What your QA engineer checks

| | Every run |
|---|---|
| **Security** | Auth-bypass detection, RBAC matrix (every operation × every role), header injection, CORS probing, JWT non-algorithm, IP spoofing, injection payloads |
| **Correctness** | Live responses validated against the schema, type checking, required-field enforcement, error-code consistency, rate-limit detection |
| **Documentation** | Discovers the real API from introspection or OpenAPI, builds an operation catalogue, flags undocumented endpoints |
| **Lifecycle** | Remembers your schema between runs — catches breaking changes, drift, and deprecations, and tracks health over time |

One scan covers what would take a team weeks to test manually.

---

##  QA engineer

**It verifies, deterministically.** As AI writes more of your code, *generating* changes gets cheap — *proving* they're safe is the scarce part. Dino's verdict is deterministic machinery: same input, same finding, every run. No flaky scripts.

**It has memory.** Most tools run a scan and forget. Dino snapshots your schema and remembers it, so each run knows what changed — that's how it catches a breaking change or silent drift *before* you ship.

**It covers the whole job.** Other tools do one slice — Schemathesis fuzzes, Checkly monitors, Pact checks contracts, StackHawk runs OWASP checks. Dino handles security, correctness, documentation, and lifecycle from a single place across GraphQL and REST.

---

## Commands

| Command | What it does |
| --- | --- |
| `dino scan` | Full health scan — fuzzing, RBAC, rate limits, error codes, deprecation tracking |
| `dino diff` | Compares your API to the last known-good and flags breaking changes (`--fail-on-breaking` gates CI) |
| `dino docs` | Generates documentation from how the API actually behaves |
| `dino changelog` | Auto-generated API changelog from schema diffs |
| `dino lint` | Schema description audit and SDL lint enforcement |
| `dino watch` | Continuous monitoring in Shadow Mode (observe → enforce) |
| `dino init` | Onboards a new API (full tenant config) |

---

## Shadow Mode

Every other API quality tool starts at maximum noise. Dino does the opposite.

| Level | Name | What Happens |
| --- | --- | --- |
| 1 | **Observe** | Watches silently, builds baseline |
| 2 | **Suggest** | Shows ranked findings with confidence scores |
| 3 | **Write** | Creates PRs with human approval |
| 4 | **Enforce** | Blocks CI on violations |

Dino doesn't demand your trust. It earns it.

---

## CI Integration

Add Dino to your GitHub Actions workflow:

```yaml
- uses: Dino-HQ/dino/.github/actions/scan@main
  with:
    api-url: ${{ secrets.API_URL }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    fail-on-breaking: true
```

### Action Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-url` | Yes | — | Target API endpoint |
| `anthropic-api-key` | Yes | — | Anthropic API key for AI descriptions |
| `api-token` | No | — | Auth token for the target API |
| `fail-on-breaking` | No | `false` | Fail CI on breaking schema changes |
| `format` | No | `markdown` | Output format (`markdown` or `json`) |
| `cli-version` | No | `latest` | Version of `@dino-hq/cli` to install |

The scan report is uploaded as a GitHub Actions artifact (`dino-scan-report`). See [dino-scan.yml](./examples/dino-scan.yml) for a complete workflow you can copy into your repo.

---

## Architecture

Five layers. Each depends only on the layer below it.

```
AI Reasoning              Optional analysis and strategies
Aggregation               Orchestration, reporting, scoring
Agent Tools               Deterministic QA engine
Intelligence Layer        Schema snapshots, catalog, docs, diffs
Platform Core             Config, discovery, multi-protocol routing
```

The bottom four layers have zero AI dependencies. If AI is disabled or unavailable, the full deterministic report still ships.


---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for our security policy and vulnerability disclosure process.

## License

[Proprietary](LICENSE) — see LICENSE file for details.

---

**Website:** [usedino.dev](https://usedino.dev) · **GitHub:** [github.com/Dino-HQ](https://github.com/Dino-HQ)

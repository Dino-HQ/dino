# Dino

**The autonomous quality layer for APIs.**

Dino scans your API, builds a health report, auto-documents undocumented operations, detects security vulnerabilities, tracks schema changes, and generates a Developer Portal — all from one command.

```bash
npm install -g @dino-hq/cli
dino init
dino scan
```

---

## What Dino Does

| Command | What It Does |
|---------|-------------|
| `dino scan` | Full health scan — fuzzing, RBAC, rate limits, error codes, deprecation tracking |
| `dino docs` | AI-powered documentation for undocumented operations |
| `dino diff` | Schema change detection with breaking change alerts |
| `dino changelog` | Auto-generated API changelog from schema diffs |
| `dino lint` | Schema description audit and SDL lint enforcement |
| `dino watch` | Continuous monitoring with Shadow Mode (observe/enforce) |

One scan covers what would take a team weeks to test manually.

---

## Quick Start

### 1. Install

```bash
npm install -g @dino-hq/cli
```

### 2. Configure

```bash
dino init
```

Creates a `.dino.yml` in your project:

```yaml
tenant: my-api
defaultEnvironment: production
environments:
  production:
    endpoints:
      graphql-api: https://api.example.com/graphql
    timeout: 30000
apis:
  - name: graphql-api
    type: graphql
    source: introspection
```

### 3. Scan

```bash
dino scan
```

Dino introspects your API, runs 6 agent tools across every operation, and produces a structured health report with severity classifications.

### 4. Watch

```bash
dino watch --autonomy observe
```

Shadow Mode watches your API continuously. Builds a baseline silently, then alerts on regressions.

---

## Shadow Mode

Every other API quality tool starts at maximum noise. Dino does the opposite.

| Level | Name | What Happens |
|-------|------|-------------|
| 1 | **Observe** | Watches silently, builds baseline |
| 2 | **Suggest** | Shows ranked findings with confidence scores |
| 3 | **Write** | Creates PRs with human approval |
| 4 | **Enforce** | Blocks CI on violations |

Dino doesn't demand your trust. It earns it.

---

## CI Integration

Add Dino to your GitHub Actions workflow:

```yaml
- uses: Dino-HQ/dino/.github/actions/scan@v1
  with:
    api-url: ${{ secrets.API_URL }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    fail-on-breaking: true
```

---

## What Dino Tests

**Contract Intelligence** — Schema validation, permission boundaries, input fuzzing, response verification, test scaffolding.

**Security & Risk** — Rate limit detection, error information leakage, RBAC matrix validation, deprecation lifecycle tracking.

**Schema Intelligence** — Snapshot diffing, breaking change detection, changelog generation, documentation coverage audit.

**AI Analysis** — Cross-domain correlation, prioritized findings, migration hints. Optional — the deterministic report always ships.

---

## Architecture

Five layers. Each depends only on the layer below it.

```
AI Reasoning              Optional analysis and strategies
Aggregation               Orchestration, reporting, scoring
Agent Tools               Deterministic QA engine (6 tools)
Intelligence Layer        Schema snapshots, catalog, docs, diffs
Platform Core             Config, discovery, multi-protocol routing
```

The bottom four layers have zero AI dependencies. If AI is disabled or unavailable, the full deterministic report still ships.

---

## Packages

| Package | Description |
|---------|-------------|
| `@dino-hq/cli` | Command-line interface |
| `@dino-hq/core` | Types, config, severity model, tenant isolation |
| `@dino-hq/agents` | Agent tools — fuzzer, RBAC, rate limits, error codes, deprecation, response validation |
| `@dino-hq/plugins` | Protocol plugins — GraphQL discovery (REST coming soon) |
| `@dino-hq/analytics` | Event tracking adapter |
| `@dino-hq/reasoning` | AI reasoning layer (optional) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for our security policy and vulnerability disclosure process.

## License

[MIT](LICENSE)

---

**Website:** [usedino.dev](https://usedino.dev) · **GitHub:** [github.com/Dino-HQ](https://github.com/Dino-HQ)

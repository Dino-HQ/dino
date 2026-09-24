# Dino

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Dino-HQ/dino/badge)](https://scorecard.dev/viewer/?uri=github.com/Dino-HQ/dino)

**Dino is the deterministic verification layer for APIs.**

An AI agent, CI system, or developer changes an API; Dino tests the running API, evaluates the evidence, and returns a deterministic verdict on whether the change is correct, secure, and safe to ship. The same observed evidence under the same policy produces the same verdict, every run, so it is trustworthy enough to gate a deploy on.

> Agents build the software. Dino proves it works.

```bash
curl -fsSL https://usedino.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # if it fell back to npm, run the export line it printed instead

# tell Dino which API to verify
printf 'endpoint: https://your-api.com/graphql\nprotocol: graphql\n' > .dino.yml

# run a deterministic test-and-verify pass
dino scan
```

That's the whole quickstart: no test scripts, no account, no setup. On macOS and most Linux there's no Node.js either: the installer puts the standalone `dino` binary on your machine (where no binary fits, for example Alpine, which uses musl, it falls back to npm, which needs Node.js 22+). On Windows, where the installer can't run yet, use `npm install -g @dino-hq/cli` (Node.js 22+) or download `dino-windows-x64.exe` from the [latest release](https://github.com/Dino-HQ/dino/releases/latest). All options: [usedino.dev/docs/install](https://usedino.dev/docs/install).

Dino discovers every operation, tests the live API for security, correctness, contract, and documentation issues, and returns a health score per operation and one verdict for the API. Add `--fail-on-high` to gate CI: it exits `3` on any HIGH or CRITICAL finding (a reduced-coverage run exits `6` unless you pass `--accept-partial`).

> Ad-hoc mode supports GraphQL and REST (`--protocol rest --spec-url <url>`) and authenticated scans (`--header` / `--token`). Run `dino init` for interactive setup, including OAuth2 client_credentials. Full docs: [usedino.dev/docs](https://usedino.dev/docs).

---

## Built for AI agents

A coding agent should not be the only thing deciding its own change is safe. Dino runs outside the generation loop, so the verdict is independent of whichever agent wrote the change. For an agent, Dino is a machine contract:

- **Structured JSON** on stdout (`--format json`): a `DinoResult` document, parseable with `jq`
- **Honest exit codes** for branching: `0` clean, `3` policy gate failed, `6` partial coverage, `2` usage, `4` transient, `5` config, `70` crash
- **Stable error envelopes** on stderr for recovery
- **Findings and evidence** for inspecting exactly what failed

The loop: `agent changes the API → dino scan → read verdict + exit code → agent fixes → dino scan again`

```bash
dino scan --format json --quiet --fail-on-high
```

`dino skill --install` writes the Dino agent skill to `.claude/skills/dino/SKILL.md`. The full contract: [usedino.dev/docs/contracts](https://usedino.dev/docs/contracts).

---

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

---

## Commands

| Command | What it does |
| --- | --- |
| `dino scan` | Runs a deterministic test-and-verify pass: security, correctness, contracts, docs |
| `dino diff` | Compares the API to the last known-good and flags breaking changes (`--fail-on-breaking` exits 3) |
| `dino watch` | Verifies on a schedule in Shadow Mode: observe, or enforce |
| `dino docs` | Generates documentation from how the API actually behaves |
| `dino lint` | Flags undocumented operations |
| `dino changelog` | Writes a changelog from schema diffs |
| `dino init` | Interactive setup: writes a flat `.dino.yml` (endpoint, protocol, optional auth) |

`dino --help` lists every command; `dino schema` prints them all, with every flag and exit code, as machine-readable JSON.

## In your CI

```yaml
# with .dino.yml (endpoint + protocol) committed
- name: Verify API
  run: npx @dino-hq/cli scan --fail-on-high
```

Exits `3` on HIGH or CRITICAL findings. A clean verdict is a green build. See [usedino.dev/docs/install](https://usedino.dev/docs/install) for pinned installs in CI.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for our security policy and vulnerability disclosure process.

## License

[Proprietary](LICENSE) — see LICENSE file for details.

---

**Website:** [usedino.dev](https://usedino.dev) · **Docs:** [usedino.dev/docs](https://usedino.dev/docs) · **GitHub:** [github.com/Dino-HQ](https://github.com/Dino-HQ)

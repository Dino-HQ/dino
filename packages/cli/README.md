# @dino-hq/cli

**Dino is the deterministic verification layer for APIs.**

An AI agent, CI system, or developer changes an API; Dino tests the running API, evaluates the evidence, and returns a deterministic verdict on whether the change is correct, secure, and safe to ship. The same observed evidence under the same policy produces the same verdict, every run, so it is trustworthy enough to gate a deploy on.

> Agents build the software. Dino proves it works.

- **No test scripts.** Dino discovers every operation from the live API or its OpenAPI spec and plans the tests itself.
- **Deterministic.** No sampling, no model in the verdict. A result you see in CI is a result you can reproduce locally.
- **Honest.** What Dino could not test is reported as not tested, never as passed. Exit codes separate your API's findings from your configuration mistakes and from Dino's own bugs.
- **Agent-ready.** `--format json` returns a `DinoResult` on stdout; `dino schema` describes every command, flag and exit code; `dino skill` teaches a coding agent the loop.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [What a scan checks](#what-a-scan-checks)
- [Configuration](#configuration)
- [Commands](#commands)
- [Exit codes](#exit-codes)
- [For coding agents](#for-coding-agents)
- [In CI](#in-ci)
- [Verify a download](#verify-a-download)
- [Telemetry](#telemetry)
- [Requirements](#requirements)
- [Links](#links)

## Install

```bash
curl -fsSL https://usedino.dev/install.sh | sh      # standalone binary, macOS and Linux, no Node.js
brew install dino-hq/tap/dino                        # Homebrew, macOS and Linux
npm install -g @dino-hq/cli                          # Windows, or anywhere with Node.js 22+
```

The installer puts `dino` in `~/.local/bin` (or npm's global folder, if it falls back to npm) and, if that folder isn't on your `PATH` yet, prints the `export PATH=…` line to run.

Run it once without installing:

```bash
npx -y @dino-hq/cli scan --endpoint https://your-api.com/graphql
```

Every [release](https://github.com/Dino-HQ/dino/releases/latest) also ships standalone binaries: `dino-darwin-arm64`, `dino-darwin-x64`, `dino-linux-x64`, `dino-linux-x64-baseline` (CPUs without AVX2), `dino-linux-arm64` and `dino-windows-x64.exe`, with `SHA256SUMS` and a Sigstore bundle per file. Pinned versions and more: [usedino.dev/docs/install](https://usedino.dev/docs/install).

## Quick start

No account and no setup. Point Dino at a running endpoint:

```bash
dino scan --endpoint https://your-api.com/graphql
```

A REST API needs its OpenAPI document too:

```bash
dino scan --endpoint https://your-api.com --protocol rest --spec-url https://your-api.com/openapi.json
```

If the API needs a token, pass it without writing it to disk:

```bash
dino scan --endpoint https://your-api.com/graphql --token "$MY_API_TOKEN"
dino scan --endpoint https://your-api.com/graphql --header "X-API-Key: $MY_API_KEY"
```

Save the target so later runs are just `dino scan`:

```bash
dino init
```

Dino returns a health score for each operation and one verdict for the API, in Markdown for people or JSON for machines (`--format json`).

## What a scan checks

`dino scan` runs the full pipeline against the live API:

| Check | What it looks for |
| --- | --- |
| Input fuzzing | Malformed and boundary inputs that crash the API, leak internals, or are wrongly accepted |
| Response validation | Responses that don't match the schema or spec the API publishes |
| RBAC matrix | Roles that can reach operations they shouldn't (needs roles configured) |
| Rate limits | Whether a rate limit actually holds under a burst (`--burst`, default 61) |
| Error codes | Error responses that use the wrong status or code for the failure |
| Deprecation | Deprecated operations and fields the API still exposes |

Limit a run with `--tools` or `--modules` (comma-separated). A request that Dino could not send correctly, for example one missing a required input it can't supply, is reported as not tested instead of becoming a finding against your API.

Dino refuses loopback and private-network targets unless you pass `--allow-private-target`, and never scans link-local or cloud metadata addresses.

## Configuration

`dino init` writes a flat `.dino.yml` in the current directory. Every field is optional; flags override it.

```yaml
# yaml-language-server: $schema=https://usedino.dev/schema.json
endpoint: https://your-api.com/graphql
protocol: graphql
auth:
  type: header
  header: Authorization
  scheme: Bearer
  valueEnv: MY_API_TOKEN
```

Secrets are never written to the file. The `header` and `oauth2` auth types name an environment variable, and Dino reads its value at run time:

```yaml
auth:
  type: oauth2
  tokenEndpoint: https://auth.your-api.com/oauth/token
  clientIdEnv: DINO_OAUTH_CLIENT_ID
  clientSecretEnv: DINO_OAUTH_CLIENT_SECRET
  scope: read:api
```

For agents and CI, `dino init` runs without prompts:

```bash
dino init --yes --endpoint https://your-api.com/graphql --protocol graphql \
  --auth header --auth-header Authorization --auth-scheme Bearer --auth-value-env MY_API_TOKEN
```

Check a config before you rely on it with `dino validate`. Full reference: [usedino.dev/docs/configuration](https://usedino.dev/docs/configuration).

## Commands

| Command | What it does |
| --- | --- |
| `dino scan` | Run the full test pipeline and return a verdict |
| `dino diff` | Compare the current schema against a saved snapshot; `--fail-on-breaking` gates on breaking changes |
| `dino changelog` | Generate a changelog from schema snapshot diffs |
| `dino lint` | Check schema descriptions; `--fail-on-undocumented` gates on new undocumented operations |
| `dino docs` | Generate API documentation from the live API |
| `dino watch` | Scan on a schedule (`--interval`, default 300 seconds) in Shadow Mode: `--autonomy observe` or `enforce` |
| `dino init` | Create `.dino.yml`, interactively or headlessly |
| `dino validate` | Validate `.dino.yml` with actionable messages |
| `dino schema` | Print a [clispec](https://clispec.dev) v0.3 description of every command, flag and exit code |
| `dino skill` | Print the Dino agent skill, or `--install` it to `.claude/skills/dino/SKILL.md` |
| `dino login` / `logout` / `whoami` | Sign in to Dino Cloud from the browser, sign out, show the active tenant |
| `dino runner` | Register this machine as a Dino Cloud runner and poll for scan jobs |
| `dino verify` | Verify a cloud scan result against its Sigstore attestation |
| `dino telemetry` | `status`, `enable` or `disable` anonymous usage telemetry |

Options most commands accept:

| Option | Meaning |
| --- | --- |
| `--endpoint <url>` | Ad-hoc target, no `.dino.yml` needed |
| `--protocol graphql\|rest` | Target protocol (default `graphql`) |
| `--spec-url <url\|path>` | OpenAPI document, required for REST |
| `--token <token>` / `--header "<Name: value>"` | Auth for the target API; `--header` repeats |
| `--format markdown\|json\|sarif` | Output format: Markdown by default, `json` for machines, `sarif` (scan only) for GitHub code scanning |
| `--quiet` / `--verbose` / `--debug` | Less output, applied defaults and diagnostics, full stack traces |
| `--no-color` | No color (the `NO_COLOR` environment variable works too) |

Run `dino <command> --help` for every flag of one command, or `dino schema` for all of them as JSON.

## Exit codes

Every outcome has its own code, so a script or agent can tell your API's problems from its own mistakes.

| Code | Meaning |
| --- | --- |
| `0` | Success: no policy gate failed, and any findings are below the threshold |
| `2` | Usage: invalid invocation, a missing required flag, or a rejected flag value |
| `3` | Policy gate triggered: `--fail-on-high`, `--fail-on-breaking` or `--fail-on-undocumented`, or `dino verify` could not prove the result |
| `4` | Transient: the target was unreachable or an upstream failure can be retried |
| `5` | Config: configuration, credentials or entitlement need attention |
| `6` | Partial: reduced coverage or an incomplete result; `--accept-partial` makes it exit 0 |
| `70` | Crash: an unexpected failure inside Dino. Please [report it](https://github.com/Dino-HQ/dino/issues) |

With `--format json`, the result document is the only thing on stdout; errors go to stderr as a JSON envelope with the same message a person would see.

## For coding agents

```bash
dino skill --install                                         # teach your agent the loop
dino scan --endpoint https://your-api.com/graphql --format json > result.json
echo $?                                                      # branch on the exit code
```

The loop is direct: change the API, run `dino scan`, read the verdict, fix, and scan again. The JSON output is a `DinoResult`: per-operation outcomes and evidence, what was not tested and why, and the API verdict. When a headless run is missing information, Dino returns a structured `ask_user` action that says what is needed and how to resume, and never asks for a secret value.

`dino schema` gives an agent the whole command surface offline, so it doesn't have to scrape help text. More: [usedino.dev/docs/for-agents](https://usedino.dev/docs/for-agents).

## In CI

Fail the build on HIGH or CRITICAL findings:

```bash
dino scan --fail-on-high            # exit 3 on any HIGH or CRITICAL finding
dino diff --fail-on-breaking        # exit 3 on a breaking schema change
```

A reduced-coverage run exits `6` unless you pass `--accept-partial`. Run `dino diff` before `dino scan`: `diff` compares against the snapshot the previous scan saved in `.dino/snapshots`, so keep that directory between runs.

With GitHub Actions, use the scan action and pin the CLI version:

```yaml
- uses: Dino-HQ/dino/.github/actions/scan@v1
  with:
    api-url: ${{ secrets.API_URL }}
    cli-version: 1.2.1
    fail-on-high: true
```

The action also takes `protocol`, `spec-url`, `api-token`, `accept-partial`, `fail-on-breaking` and `format`, and outputs `report-path` and `exit-code`. For a hardened workflow, pin the action to a full commit SHA instead of `@v1`. More: [usedino.dev/docs/ci](https://usedino.dev/docs/ci).

### GitHub code scanning

`dino scan --format sarif` writes SARIF 2.1.0, so findings show up as alerts in the repository's Security tab:

```yaml
permissions:
  contents: read
  security-events: write # upload SARIF, read the previous analysis
  actions: read          # read the previous run's state artifact (needed on private repositories)
concurrency:
  group: dino-sarif-${{ github.ref }} # one Dino SARIF writer per ref, in every workflow
  cancel-in-progress: false
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - id: dino
    run: |
      code=0
      npx -y @dino-hq/cli scan --spec-url openapi.yaml --endpoint "$API_URL" --format sarif --sarif-state dino.sarif.state.json > dino.sarif.tmp || code=$?
      if [ -s dino.sarif.tmp ]; then mv dino.sarif.tmp dino.sarif; fi
      exit "$code"
    env:
      API_URL: ${{ secrets.API_URL }}
      GITHUB_TOKEN: ${{ github.token }}
  - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
    if: always() && hashFiles('dino.sarif') != ''
    with:
      name: dino-sarif-state-${{ steps.dino.outputs.sarif-run-token }}
      path: dino.sarif.state.json
  - uses: github/codeql-action/upload-sarif@1c5b675653bb5c22dbe9b12b556ec555138e09fd # v4.38.1
    if: always() && hashFiles('dino.sarif') != ''
    with:
      sarif_file: dino.sarif
```

- GitHub closes every alert missing from an upload, so Dino never leaves out an alert it did not re-test. In GitHub Actions each upload is reconciled with the previous Dino analysis for the same ref and scope: a partial run uploads what it verified and carries forward every alert on an operation it did not test, and an alert closes only when Dino re-tested its exact operation with the same test plan.
- The state the next run needs is written to `--sarif-state` and kept as the artifact above. Keep artifact retention longer than the gap between scans: if the state is gone, Dino writes no SARIF (existing alerts stay open) until a complete run with `--sarif-rebaseline` starts over.
- Dino writes no SARIF, and keeps the scan's exit code, when it cannot tell which alerts an upload would close: GitHub could not be read, the state is missing, or another Dino upload landed during the scan. A run that reached nothing (unreachable target, every tool failed, nothing in scope) never writes SARIF.
- Outside GitHub Actions, `--format sarif` writes SARIF only for a complete run.
- Every alert points at a file git tracks: the local OpenAPI spec or SDL, else the `.dino.yml`, else the workflow file. A generated or untracked file does not count. With none of these, `--format sarif` exits `2` before sending any request.
- A scan narrowed with `--tools` or `--modules` uploads under its own category, so it never closes alerts from a full scan.
- Only security findings (access control, data leaks, CORS, missing rate limits and similar) are filed as security alerts; contract and deprecation findings are quality alerts.
- The scan's exit code is the same as with `--format json`. A result too large for GitHub (over 25,000 results or 10 MB compressed) exits `2` instead of being cut short.

## Verify a download

Check a binary against the release's `SHA256SUMS`:

```bash
grep ' dino-linux-x64$' SHA256SUMS | sha256sum -c -     # macOS: shasum -a 256 -c -
```

Each binary also has a keyless Sigstore bundle, `<file>.sigstore.json`, proving it was built by Dino's release pipeline. Every release's notes include the exact `cosign verify-blob` command and signing identity for that release. The npm package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which `npm audit signatures` checks.

## Telemetry

The CLI sends anonymous usage telemetry under a random install ID: the command, the CLI version, the values of `--format`, `--quiet`, `--verbose`, `--dry-run` and `--limit` (no other flag is sent), how long it took, the exit code, and on a failure the error class and a sanitized message. It also sends the OS, CPU architecture and count, Node.js version, and whether it runs in CI and which one. No API keys, endpoints or scan results are ever sent.

```bash
dino telemetry status
dino telemetry disable              # or set DINO_TELEMETRY_DISABLED=1, or DO_NOT_TRACK=1
DINO_TELEMETRY_DEBUG=1 dino scan …  # print what would be sent, without sending it
```

Details: [usedino.dev/telemetry](https://usedino.dev/telemetry).

## Requirements

- The standalone binaries and Homebrew need nothing else.
- The npm package needs Node.js 22 or later. It is one self-contained bundle with no runtime dependencies.
- macOS, Linux (x64, arm64) and Windows (x64).

## Links

[Website](https://usedino.dev) | [Docs](https://usedino.dev/docs) | [What's New](https://usedino.dev/whats-new) | [GitHub](https://github.com/Dino-HQ/dino) | [Security policy](https://github.com/Dino-HQ/dino/blob/main/SECURITY.md)

MIT License

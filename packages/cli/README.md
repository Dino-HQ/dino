# @dino-hq/cli

**Dino is the deterministic verification layer for APIs.**

An AI agent, CI system, or developer changes an API; Dino tests the running API, evaluates the evidence, and returns a deterministic verdict on whether the change is correct, secure, and safe to ship. The same observed evidence under the same policy produces the same verdict, every run, so it is trustworthy enough to gate a deploy on.

> Agents build the software. Dino proves it works.

## Install

```bash
curl -fsSL https://usedino.dev/install.sh | sh      # standalone binary, macOS and Linux, no Node.js
npm install -g @dino-hq/cli                          # Windows, or anywhere with Node.js 22+
```

The installer puts `dino` in `~/.local/bin` (or npm's global folder, if it falls back to npm) and, if that folder isn't on your `PATH` yet, prints the `export PATH=…` line to run. Homebrew, pinned versions and verified downloads: [usedino.dev/docs/install](https://usedino.dev/docs/install).

## Verify an API

No test scripts, no account, no setup. Point Dino at a running endpoint:

```bash
dino scan --endpoint https://your-api.com/graphql
```

Dino discovers every operation, tests the live API for security, correctness, contract, and documentation issues, and returns a health score per operation and one verdict for the API. GraphQL and REST (`--protocol rest --spec-url <url>`). Run `dino init` to save the target in `.dino.yml`.

## Next

- **Coding agents:** `dino skill --install` gives your agent the loop, and `dino scan --format json` returns a `DinoResult` on stdout with honest exit codes to branch on. See [usedino.dev/docs/for-agents](https://usedino.dev/docs/for-agents).
- **CI:** `--fail-on-high` exits `3` on any HIGH or CRITICAL finding; a reduced-coverage run exits `6` unless you pass `--accept-partial`. See [usedino.dev/docs/ci](https://usedino.dev/docs/ci).
- **Everything else:** [usedino.dev/docs](https://usedino.dev/docs): exit codes, the `DinoResult` contract, configuration and every command.

[Website](https://usedino.dev) | [Docs](https://usedino.dev/docs) | [What's New](https://usedino.dev/whats-new) | [GitHub](https://github.com/Dino-HQ/dino)

MIT License

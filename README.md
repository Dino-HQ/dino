# Dino

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Dino-HQ/dino/badge)](https://scorecard.dev/viewer/?uri=github.com/Dino-HQ/dino)

**Dino is the deterministic verification layer for APIs.**

An AI agent, CI system, or developer changes an API; Dino tests the running API, evaluates the evidence, and returns a deterministic verdict on whether the change is correct, secure, and safe to ship. The same observed evidence under the same policy produces the same verdict, every run, so it is trustworthy enough to gate a deploy on.

> Agents build the software. Dino proves it works.

## Install

```bash
curl -fsSL https://usedino.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # if it fell back to npm, run the export line it printed instead
```

macOS and Linux get the standalone `dino` binary, with no Node.js needed. Homebrew, npm, Windows, pinned versions and verified downloads: [usedino.dev/docs/install](https://usedino.dev/docs/install).

## Verify an API

```bash
dino scan --endpoint https://your-api.com/graphql
```

Dino discovers every operation, tests the live API for security, correctness, contract, and documentation issues, and returns a health score per operation and one verdict for the API. GraphQL and REST (`--protocol rest --spec-url <url>`). Run `dino init` to save the target in `.dino.yml`.

## Next

- **Coding agents:** [usedino.dev/docs/for-agents](https://usedino.dev/docs/for-agents). `dino skill --install` gives your agent the loop, and `--format json` returns a `DinoResult` it can branch on.
- **CI:** [usedino.dev/docs/ci](https://usedino.dev/docs/ci). `--fail-on-high` exits `3` on any HIGH or CRITICAL finding. With GitHub Actions, use the action's `v1` tag and pin the CLI to a version:

  ```yaml
  - uses: Dino-HQ/dino/.github/actions/scan@v1
    with:
      api-url: ${{ secrets.API_URL }}
      cli-version: 1.1.5
      fail-on-high: true
  ```

  `v1` moves only for backward-compatible changes to the action; a breaking input change starts `v2`. For a hardened workflow, pin the action to a full commit SHA instead of `@v1`.

- **Everything else:** [usedino.dev/docs](https://usedino.dev/docs): exit codes, the `DinoResult` contract, configuration and every command.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for our security policy and vulnerability disclosure process.

## License

The CLI ([`packages/cli`](./packages/cli), published as `@dino-hq/cli`) is [MIT](./packages/cli/LICENSE). Everything else in this repository is [source-available](LICENSE): read, run, and verify it freely; commercial use requires a Dino subscription.

---

**Website:** [usedino.dev](https://usedino.dev) · **Docs:** [usedino.dev/docs](https://usedino.dev/docs) · **GitHub:** [github.com/Dino-HQ](https://github.com/Dino-HQ)

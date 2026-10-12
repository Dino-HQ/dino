# Contributing to Dino

Thank you for your interest in contributing to Dino. This guide covers everything you need to get started.

---

## About this repository

This repository is a read-only source mirror of the Dino CLI, published at each release so you can read and audit the code. It does not build on its own: the CLI depends on internal packages that are not published here.

- **Use the CLI:** `npm install -g @dino-hq/cli` (Node.js 22+). See the [install guide](https://usedino.dev/docs/install).
- **Report a bug or request a feature:** open a [GitHub issue](https://github.com/Dino-HQ/dino/issues).
- **Propose a change:** pull requests are welcome as proposals. A maintainer reviews them and ports accepted changes to the main repository; they land here with the next release.

---

## Project Structure

```
packages/
  cli/       Command-line interface (@dino-hq/cli)
  core/      Types, config, severity model
  plugins/   Protocol discovery plugins
```

---

## Making Changes

### Branch naming

```
feat/<scope>/description
fix/<scope>/description
```

Scopes match package names: `cli`, `core`, `agents`, `plugins`, `shared`.

### Commit messages

We use conventional commits:

```
feat(cli): add changelog command
fix(agents): correct RBAC classification for admin roles
test(shared): add regression test for snapshot validation
```

Types: `feat`, `fix`, `test`, `docs`, `chore`, `refactor`.

### Pull requests

1. Fork the repo and create your branch from `main`
2. Include tests for new behavior
3. Open a PR with a clear description of the problem and the change

---

## Testing Guidelines

Every PR should include appropriate tests:

- **Unit tests** (`*.test.ts`) — test individual functions
- **Integration tests** — test cross-module behavior
- **Failure-mode tests** (`*.failure-mode.test.ts`) — test error handling paths
- **Regression tests** (`*.regression.test.ts`) — for bug fixes, include a test that fails without the fix

---

## Code Style

- TypeScript strict mode
- No `any` types in new code
- No `dangerouslySetInnerHTML`
- No hardcoded credentials or API keys

---

## Reporting Issues

- Use [GitHub Issues](https://github.com/Dino-HQ/dino/issues) for bug reports and feature requests
- Include reproduction steps for bugs
- Check existing issues before opening a new one

---

## Code of Conduct

Be respectful. Be constructive. We're building something together.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

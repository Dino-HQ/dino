# Contributing to Dino

Thank you for your interest in contributing to Dino. This guide covers everything you need to get started.

---

## Development Setup

### Prerequisites

- Node.js 20+
- npm 10+

### Install

```bash
git clone https://github.com/Dino-HQ/dino.git
cd dino
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

---

## Project Structure

```
packages/
  cli/          Command-line interface (@dino-hq/cli)
  core/         Types, config, severity model (@dino-hq/core)
  agents/       Agent tools — fuzzer, RBAC, etc. (@dino-hq/agents)
  plugins/      Protocol discovery plugins (@dino-hq/plugins)
  analytics/    Event tracking adapter (@dino-hq/analytics)
  reasoning/    AI reasoning layer (@dino-hq/reasoning)
```

Package dependency chain: `cli → agents → plugins → core`. Each package has its own `package.json`, `tsconfig.json`, and test suite.

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
2. Write tests for new functionality
3. Ensure `npm test` passes
4. Ensure `npm run lint` passes
5. Open a PR with a clear description

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
- Prettier for formatting
- ESLint for linting
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

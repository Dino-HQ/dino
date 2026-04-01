# @dino-hq/cli

AI-powered API quality scanner. Test, document, and diff your GraphQL APIs from the command line.

## Install

```bash
npm install -g @dino-hq/cli
```

## Quick Start

```bash
# Scan your API for issues
dino scan --tenant my-tenant

# Generate API documentation
dino docs --tenant my-tenant --output api-docs.md

# Detect breaking changes
dino diff --tenant my-tenant --fail-on-breaking
```

## Commands

| Command | Description |
|---------|-------------|
| `dino scan` | Run the full test pipeline — fuzzing, validation, RBAC, rate limits, error codes, deprecation |
| `dino docs` | Generate API documentation from live introspection |
| `dino diff` | Compare current schema against a saved snapshot, detect breaking changes |

## Key Flags

| Flag | Commands | Description |
|------|----------|-------------|
| `--tenant <id>` | all | Tenant configuration to use (required) |
| `--env <name>` | all | Target environment (default: tenant's default) |
| `--format <type>` | all | Output format: `markdown` or `json` |
| `--quiet` | all | Suppress non-essential output |
| `--tools <list>` | scan | Comma-separated tools to run |
| `--reasoning` | scan | Enable AI reasoning (requires `DINO_AI_KEY`) |
| `--output <path>` | docs | Write output to file instead of stdout |
| `--fail-on-breaking` | diff | Exit with code 1 if breaking changes found |

## Configuration

Create a `.dino.yml` in your project root:

```yaml
tenant: my-tenant
environment: production
format: markdown
snapshotDir: .dino/snapshots
```

## Tiers

- **Free**: Local scans + local file export
- **Pro**: AI reasoning, hosted portal, watch mode (`DINO_AI_KEY` required)

## License

MIT

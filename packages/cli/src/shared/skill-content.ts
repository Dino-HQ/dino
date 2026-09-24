/**
 * #168 - Dino CLI Agent Skill markdown (version-locked in the CLI bundle).
 * cli_version is DERIVED from CLI_VERSION (never hand-maintained) so an installed
 * SKILL.md records which CLI produced it and can be detected as stale after an upgrade.
 * Hyphens only - no em-dash (command-help-copy source scan covers this file).
 */

import { CLI_VERSION } from '../version';

export const DINO_CLI_AGENT_SKILL: string = `---
name: Dino CLI Agent Skill
description: How an AI coding agent drives Dino (this project's deterministic verification layer for APIs) from the command line - the init, scan, read, fix, reverify loop and how to read Dino's results honestly. Use when asked to test, verify, or check this project's API.
metadata:
  cli_version: ${CLI_VERSION}
---

# Dino CLI Agent Skill

Dino is this project's deterministic verification layer for APIs: the same evidence through the same policy yields the same verdict. You (the agent) drive the \`dino\` CLI. A human supplies values you do not have (URLs, secrets) when Dino asks.

The \`dino\` CLI describes itself as you go. Every command returns a structured result, and on failure a JSON envelope on stderr that tells you what to do next (\`nextAction\`, \`suggestion\`). Read that envelope - it is always current and specific to this run. This skill gives you what the envelope cannot: the loop to run, and the judgment to read a result honestly.

## The loop

1. Set up: \`dino init\` writes \`.dino.yml\` (once per project).
2. Verify: \`dino scan --format json\` runs the checks and returns findings plus a verdict.
3. Read: the exit code is your pass / not-pass signal; the JSON carries the detail and the next step.
4. Fix: change the API or its config to address the findings.
5. Reverify: run \`dino scan\` again. Repeat until it passes at your gate.

## Setup (dino init)

    dino init --endpoint <API_URL> --protocol <graphql|rest> --auth <none|header|oauth2>

- \`--protocol rest\` also needs \`--spec-url <openapi-url-or-path>\`.
- \`--auth header\` also needs \`--auth-header <HeaderName>\` and \`--auth-value-env <ENV_VAR_NAME>\`.
- \`--auth oauth2\` also needs \`--oauth2-token-endpoint\`, \`--oauth2-client-id-env\`, \`--oauth2-client-secret-env\`.

Secret rule: you pass the NAME of an environment variable, never the secret value. Ask the human to set that env var themselves. Never put a token, password, or client secret into a command, a file, or your own message.

If \`dino init\` (or \`dino scan\` with no resolvable endpoint) is missing a value it exits non-zero and prints a JSON envelope whose \`nextAction\` is \`{ "type": "ask_user", "inputs": [...], "resume": { "type": "run_command", "bin": "dino", "args": [...] } }\`. Each input has \`field\`, \`flag\`, \`envVar\`, \`description\`, \`secret\`, plus \`reason\` (why Dino needs it) and \`example\` (expected format; for \`secret: true\`, shape + where to set it - never a credential value). Do exactly what it says: ask the human for each input (for \`secret: true\` inputs, ask them to set the named env var), then re-run \`resume.bin\` with \`resume.args\`, appending each collected input by its \`flag\`. Do not guess values.

## Reading a result honestly

Read the envelope, not the prose: the exit code tells you pass vs not-pass, and the JSON (\`nextAction\` / \`suggestion\`) tells you what to do next, always current for this run. As a map, the exit codes are:

- 0: clean, or findings below threshold (pass)
- 2: usage error (fix the flags; read the envelope suggestion / nextAction)
- 3: policy failure (findings exceeded the gate)
- 4: transient error (retry later)
- 5: config error (fix .dino.yml)
- 6: partial (some checks did not complete; NOT a full pass)
- 70: crash

The rule that matters most: anything that is not a substantiated pass is not a pass. Dino reports UNTESTED, INCOMPLETE, or partial honestly - never read a missing, degraded, or partial result as if it passed. If Dino could not verify something, treat it as unverified, not clean.

## Notes

- Everything here is local. This skill ships inside the \`dino\` CLI, so it matches the installed version; for per-run specifics, trust the live JSON envelope over any prose.
- CI: see https://usedino.dev/docs/ci (GitHub Action or any CI). Run Dino after the target is deployed, not before.
`;

/**
 * #168 - dino skill: emit or install the Dino CLI Agent Skill.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DINO_CLI_AGENT_SKILL } from '../shared/skill-content';

/** Injected-seam writer: writes the skill under baseDir/.claude/skills/dino/SKILL.md, returns the path. */
export function writeSkillFile(baseDir: string, content: string): string {
  const dir = resolve(baseDir, '.claude', 'skills', 'dino');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed baseDir/.claude/skills/dino/
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed baseDir/.claude/skills/dino/SKILL.md
  writeFileSync(file, content, 'utf-8');
  return file;
}

/**
 * `dino skill` -> stdout; `dino skill --install` -> write file + path to stderr.
 * Returns void: this command can only succeed (a write failure throws and is caught by the
 * command harness, which owns exit codes) — it never invents a status code (SonarQube S3516).
 */
export async function runSkill(flags: Record<string, unknown>): Promise<void> {
  if (flags.install === true) {
    const skillPath = writeSkillFile(process.cwd(), DINO_CLI_AGENT_SKILL);
    console.error(`Wrote ${skillPath}`);
    return;
  }
  process.stdout.write(DINO_CLI_AGENT_SKILL);
}

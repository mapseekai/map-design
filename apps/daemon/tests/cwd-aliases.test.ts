import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { skillCwdAliasSegment, stageActiveSkill } from '../src/cwd-aliases.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('active skill staging', () => {
  it('uses the skill folder name directly for the cwd alias', () => {
    expect(skillCwdAliasSegment('/opt/map-design/skills/map-design')).toBe('map-design');
    expect(skillCwdAliasSegment('map-design')).toBe('map-design');
  });

  it('stages the bundled native-only MapDesign skill into the project cwd', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'map-design-skill-stage-'));
    const projectCwd = path.join(root, 'project');
    await mkdir(projectCwd);
    try {
      const result = await stageActiveSkill(
        projectCwd,
        'map-design',
        path.join(repoRoot, 'skills', 'map-design'),
      );

      expect(result).toEqual({
        staged: true,
        stagedPath: path.join(projectCwd, '.map-design-skills', 'map-design'),
      });
      const skill = await readFile(
        path.join(projectCwd, '.map-design-skills', 'map-design', 'SKILL.md'),
        'utf8',
      );
      expect(skill).toContain('native run-scoped MapDesign tools');
      expect(skill).toContain('`map-design` dynamic-tool namespace');
      expect(skill).toContain('Do not use shell commands, `md tool`, MCP, or direct HTTP requests');
      expect(skill).toContain('`map_apply_transaction`');
      expect(skill).not.toMatch(
        /Call `md tool|Use (?:MCP|direct HTTP)|Daemon:|daemon URL and tool token|MAP_DESIGN_(?:DAEMON_URL|TOOL_TOKEN)/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

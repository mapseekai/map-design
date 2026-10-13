import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { MAP_TOOL_NAMES, MapToolInputSchemas, MapToolNameSchema } from '../../packages/map-design-contracts/src/tools.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fromRoot = (...parts: string[]) => path.join(repoRoot, ...parts);

describe('MapDesign resource boundary', () => {
  it('keeps only the bundled resources required by MapDesign', () => {
    for (const required of [
      'skills/map-design/SKILL.md',
      'design-systems/quiet-atlas/CARTOGRAPHY.md',
      'design-systems/monet/CARTOGRAPHY.md',
      'assets/brand/map-design.svg',
    ]) {
      expect(existsSync(fromRoot(required)), required + ' must remain').toBe(true);
    }

    for (const retired of [
      'charts/map-design',
      'clipper',
      'craft',
      'design-templates',
      'prompt-templates',
      'assets/community-pets',
      'assets/frames',
      'assets/prompt-templates',
      'data',
      'deploy',
      'figma-plugin',
      'nix',
      'story',
      'templates',
    ]) {
      expect(existsSync(fromRoot(retired)), retired + ' must remain absent').toBe(false);
    }
  });

  it('lists the registered native tools in the bundled skill', () => {
    const skill = readFileSync(fromRoot('skills/map-design/SKILL.md'), 'utf8');
    const tools = [...skill.matchAll(/^- `(map_[a-z_]+)`$/gmu)].map((match) => match[1]);
    expect(tools).toEqual(MAP_TOOL_NAMES);
  });

  it('keeps documented tool examples valid against the runtime input contracts', () => {
    const contracts = readFileSync(fromRoot('skills/map-design/references/tool-contracts.md'), 'utf8');
    const documented = new Set<string>();
    for (const section of contracts.split(/^## /mu)) {
      const tool = MapToolNameSchema.safeParse(section.split(/\r?\n/u)[0]?.trim());
      if (!tool.success) continue;
      for (const match of section.matchAll(/```json\s*([\s\S]*?)```/gu)) {
        if (match[1] === undefined) throw new TypeError('Missing tool example');
        const example: unknown = JSON.parse(match[1]);
        const parsed = MapToolInputSchemas[tool.data].safeParse(example);
        expect(parsed.success, `${tool.data} example must match its input contract`).toBe(true);
        documented.add(tool.data);
      }
    }
    expect([...documented].sort()).toEqual([
      'map_apply_transaction', 'map_commit_revision', 'map_inspect',
      'map_render_preview', 'map_search_layers', 'map_validate',
    ]);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fromRoot = (...parts: string[]) => path.join(repoRoot, ...parts);

describe('MapDesign resource boundary', () => {
  it('keeps only the bundled resources required by MapDesign', () => {
    for (const required of [
      'skills/map-design/SKILL.md',
      'design-systems/quiet-atlas/CARTOGRAPHY.md',
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

  it('requires native run-scoped MapDesign tools without CLI or daemon instructions', () => {
    const skill = readFileSync(fromRoot('skills/map-design/SKILL.md'), 'utf8');
    const contracts = readFileSync(fromRoot('skills/map-design/references/tool-contracts.md'), 'utf8');

    expect(skill).toContain('native run-scoped MapDesign tools');
    expect(skill).toContain('`map-design` dynamic-tool namespace');
    for (const tool of [
      'map_get_context',
      'map_inspect',
      'map_search_layers',
      'map_apply_transaction',
      'map_update_semantics',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
      'map_discard_draft',
    ]) expect(skill).toContain(`\`${tool}\``);
    expect(skill).toContain('Do not use shell commands, `md tool`, MCP, or direct HTTP requests');
    expect(skill).not.toMatch(/Call `md tool|daemon URL and tool token|MAP_DESIGN_(?:DAEMON_URL|TOOL_TOKEN)/u);
    expect(skill).toContain('1–100 SDK operations');
    expect(skill).toContain('returned draft revision as `expectedRevision` for the next batch');
    expect(skill).toMatch(/map_search_layers.*limit.*narrow quer/isu);
    expect(skill).toMatch(/map_inspect.*only (?:with )?ids returned.*never guess or brute-force/isu);
    expect(skill).toMatch(/new logical (?:write|batch).*exact current Run.*expected revision.*batch/isu);
    expect(skill).toContain('examples are shapes only');
    expect(skill).toMatch(
      /Use this deterministic edit flow[\s\S]*1\. `map_get_context`[\s\S]*2\. `map_apply_transaction`[\s\S]*3\. `map_validate`[\s\S]*4\. `map_render_preview`[\s\S]*5\. `map_commit_revision`/u,
    );
    expect(`${skill}\n${contracts}`).not.toMatch(
      /dark-theme-001|dark-base-001|semantic-001|preview-001|commit-001|discard-001/u,
    );
    expect(contracts).toMatch(/RUN_ID.*expected revision.*batch/isu);
  });
});

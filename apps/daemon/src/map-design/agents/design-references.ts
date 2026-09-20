import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export const DESIGN_REFERENCES = {
  'map-design': 'skills/map-design/SKILL.md',
  'map-tool-contracts': 'skills/map-design/references/tool-contracts.md',
  'cartography-md': 'skills/cartography-md/SKILL.md',
  'cartography-init': 'skills/cartography-init/SKILL.md',
  'data-profile': 'skills/data-profile/SKILL.md',
  'ui-design': 'DESIGN.md',
} as const;

export async function readDesignReference(projectRoot: string, name: string): Promise<string> {
  if (!Object.hasOwn(DESIGN_REFERENCES, name)) throw new Error('Unknown design reference');
  const root = await realpath(projectRoot);
  const path = await realpath(join(root, DESIGN_REFERENCES[name as keyof typeof DESIGN_REFERENCES]));
  const child = relative(root, path);
  if (child.startsWith('..') || isAbsolute(child) || (await stat(path)).size > 128 * 1024) throw new Error('Design reference unavailable');
  return readFile(path, 'utf8');
}

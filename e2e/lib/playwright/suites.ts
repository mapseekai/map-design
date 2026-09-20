export type UiPlaywrightGroup = {
  files: readonly string[];
  fullyParallel?: boolean;
  grep: string;
  workers?: number;
};

export type UiP0CiMatrixEntry = {
  name: string;
  shard: string;
};

export type VisualCiMatrixEntry = {
  files: string;
  name: string;
};

export const uiP0Groups = {
  'map-design': {
    grep: String.raw`\\[P[02]\\]`,
    fullyParallel: true,
    files: ['ui/map-design-studio.test.ts', 'ui/map-design-home-layout.test.ts'],
  },
} as const satisfies Record<string, UiPlaywrightGroup>;

export type UiP0GroupName = keyof typeof uiP0Groups;

export const uiP0CiMatrix = [
  { name: 'map-design', shard: 'map-design' },
] as const satisfies readonly UiP0CiMatrixEntry[];

export const visualCiMatrix = [
  { name: 'map-design-layout', files: 'ui/map-design-home-layout.test.ts' },
] as const satisfies readonly VisualCiMatrixEntry[];

export function getUiP0Group(name: string): UiPlaywrightGroup | undefined {
  return uiP0Groups[name as UiP0GroupName];
}

export function listUiP0GroupNames(): string[] {
  return Object.keys(uiP0Groups).sort();
}

export function validatePlaywrightSuiteTopology(): string[] {
  const errors: string[] = [];
  for (const entry of uiP0CiMatrix) {
    if (getUiP0Group(entry.shard) == null) {
      errors.push(`UI P0 CI matrix references unknown group ${entry.shard}`);
    }
  }
  for (const entry of visualCiMatrix) {
    if (entry.files.trim().length === 0) {
      errors.push(`Visual CI matrix entry ${entry.name} has no files`);
    }
  }
  return errors;
}

type MapDesignProjectKind = 'map';

export const MAP_DESIGN_SKILL_ID = 'map-design' as const;

export function requiredMapDesignSkillId(projectKind: MapDesignProjectKind | null): typeof MAP_DESIGN_SKILL_ID | null {
  return projectKind === 'map' ? MAP_DESIGN_SKILL_ID : null;
}

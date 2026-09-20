const RESOURCE_SCHEMES = ['map-design-resource', 'pmtiles'] as const;

export type MapDesignResourceScope = 'projects' | 'source-previews';

export interface MapDesignResourceUrlOptions {
  origin?: string;
  scope?: MapDesignResourceScope;
}

export function assertMapDesignResourceUrl(
  value: string,
  projectId: string,
  options: MapDesignResourceUrlOptions = {},
): string {
  if (typeof value !== 'string' || value.length === 0) unsafe();
  const custom = RESOURCE_SCHEMES.find((scheme) => value.startsWith(`${scheme}://`));
  const raw = custom ? value.slice(custom.length + 3) : value;
  const path = raw.startsWith('/')
    ? raw
    : options.origin && raw.startsWith(`${options.origin}/`)
      ? raw.slice(options.origin.length)
      : unsafe();
  if (path.includes('?') || path.includes('#') || path.includes('\\')
    || /%(?:2e|2f|5c)/iu.test(path) || path.split('/').some((part) => part === '.' || part === '..')) unsafe();
  const scope = options.scope ?? 'projects';
  const prefix = `/api/map-design/${scope}/${encodeURIComponent(projectId)}/resources/`;
  if (!path.startsWith(prefix) || path.length <= prefix.length) unsafe();
  return custom ? value : options.origin ? `${options.origin}${path}` : path;
}

export function assertMapDesignStyleResourceUrls(
  style: unknown,
  projectId: string,
  options: MapDesignResourceUrlOptions = {},
): void {
  if (!isRecord(style)) unsafe();
  validateValue(style.glyphs, projectId, options);
  validateSprite(style.sprite, projectId, options);
  if (Array.isArray(style.imports)) {
    for (const item of style.imports) {
      if (isRecord(item)) validateValue(item.url, projectId, options);
    }
  }
  if (!isRecord(style.sources)) return;
  for (const source of Object.values(style.sources)) {
    if (!isRecord(source)) continue;
    validateValue(source.url, projectId, options);
    validateValues(source.tiles, projectId, options);
    validateValue(typeof source.data === 'string' ? source.data : undefined, projectId, options);
    validateValues(source.urls, projectId, options);
  }
}

export function assertMapDesignTransactionResourceUrls(
  transaction: unknown,
  projectId: string,
  options: MapDesignResourceUrlOptions = {},
): void {
  if (!isRecord(transaction) || !Array.isArray(transaction.operations)) return;
  for (const operation of transaction.operations) {
    if (!isRecord(operation)) continue;
    switch (operation.op) {
      case 'addSource':
      case 'replaceSourceDefinition':
        validateSource(operation.source, projectId, options);
        break;
      case 'duplicateSource':
        validateSource(operation.overrides, projectId, options);
        break;
      case 'patchSource':
      case 'deepMergeSourceDefinition':
        validateSource(operation.patch, projectId, options);
        break;
      case 'setGeoJsonData':
        validateValue(typeof operation.data === 'string' ? operation.data : undefined, projectId, options);
        break;
      case 'addGeoJsonLayer':
        validateValue(typeof operation.data === 'string' ? operation.data : undefined, projectId, options);
        validateSource(operation.sourceOptions, projectId, options);
        break;
      case 'setStyleRootProperties':
        validateRootProperties(operation.properties, projectId, options);
        break;
      default:
        break;
    }
  }
}

function validateRootProperties(value: unknown, projectId: string, options: MapDesignResourceUrlOptions): void {
  if (!isRecord(value)) return;
  validateValue(value.glyphs, projectId, options);
  validateSprite(value.sprite, projectId, options);
  if (Array.isArray(value.imports)) {
    for (const item of value.imports) {
      if (isRecord(item)) validateValue(item.url, projectId, options);
    }
  }
}

function validateSource(value: unknown, projectId: string, options: MapDesignResourceUrlOptions): void {
  if (!isRecord(value)) return;
  validateValue(value.url, projectId, options);
  validateValues(value.tiles, projectId, options);
  validateValue(typeof value.data === 'string' ? value.data : undefined, projectId, options);
  validateValues(value.urls, projectId, options);
}

function validateSprite(value: unknown, projectId: string, options: MapDesignResourceUrlOptions): void {
  if (typeof value === 'string') {
    assertMapDesignResourceUrl(value, projectId, options);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const sprite of value) {
    if (isRecord(sprite)) validateValue(sprite.url, projectId, options);
  }
}

function validateValue(value: unknown, projectId: string, options: MapDesignResourceUrlOptions): void {
  if (typeof value === 'string') assertMapDesignResourceUrl(value, projectId, options);
}

function validateValues(value: unknown, projectId: string, options: MapDesignResourceUrlOptions): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string') assertMapDesignResourceUrl(item, projectId, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unsafe(): never {
  throw new TypeError('Unsafe MapDesign Style resource URL: expected the same-project resource gateway.');
}

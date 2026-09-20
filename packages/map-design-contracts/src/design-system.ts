export interface MapDesignRules {
  version: 1;
  requiredSemanticRoles: string[];
  maxLabelLayerCount: number;
  minimumContrastRatio: number;
}

export interface ParsedMapDesignSystemDocument {
  humanGuidance: string;
  rules: MapDesignRules;
}

const RULE_BLOCK = /^```mapdesign-rules[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** Parses the one strict machine-readable rules block in a MAP_DESIGN.md document. */
export function parseMapDesignSystemDocument(content: string): ParsedMapDesignSystemDocument {
  const blocks = [...content.matchAll(RULE_BLOCK)];
  if (blocks.length !== 1) throw new TypeError('expected exactly one mapdesign-rules block');

  return {
    humanGuidance: content.replace(RULE_BLOCK, '').trim(),
    rules: parseRules(blocks[0]![1]!),
  };
}

function parseRules(source: string): MapDesignRules {
  let value: unknown;
  try {
    assertNoDuplicateJsonKeys(source);
    value = JSON.parse(source);
  } catch {
    throw new TypeError('invalid map design rules');
  }
  if (!isPlainObject(value)) throw new TypeError('invalid map design rules');
  const keys = Object.keys(value).sort();
  const expected = ['maxLabelLayerCount', 'minimumContrastRatio', 'requiredSemanticRoles', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new TypeError('invalid map design rules');
  const { version, requiredSemanticRoles, maxLabelLayerCount, minimumContrastRatio } = value;
  if (version !== 1 || !Array.isArray(requiredSemanticRoles)
    || typeof maxLabelLayerCount !== 'number' || !Number.isInteger(maxLabelLayerCount)
    || maxLabelLayerCount < 0 || maxLabelLayerCount > 500
    || typeof minimumContrastRatio !== 'number' || !Number.isFinite(minimumContrastRatio)
    || minimumContrastRatio < 1 || minimumContrastRatio > 21
    || requiredSemanticRoles.length > 128
    || requiredSemanticRoles.some((role) => typeof role !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(role))
    || new Set(requiredSemanticRoles).size !== requiredSemanticRoles.length) {
    throw new TypeError('invalid map design rules');
  }
  return {
    version: 1,
    requiredSemanticRoles: [...requiredSemanticRoles],
    maxLabelLayerCount,
    minimumContrastRatio,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoDuplicateJsonKeys(source: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? '')) index += 1; };
  const string = (): string => {
    const start = index;
    if (source[index] !== '"') throw new SyntaxError();
    index += 1;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '"') { index += 1; return JSON.parse(source.slice(start, index)) as string; }
      index += 1;
    }
    throw new SyntaxError();
  };
  const value = (): void => {
    whitespace();
    if (source[index] === '{') {
      index += 1; whitespace(); const keys = new Set<string>();
      if (source[index] === '}') { index += 1; return; }
      while (true) {
        whitespace(); const key = string(); if (keys.has(key)) throw new SyntaxError(); keys.add(key);
        whitespace(); if (source[index++] !== ':') throw new SyntaxError(); value(); whitespace();
        if (source[index] === '}') { index += 1; return; }
        if (source[index++] !== ',') throw new SyntaxError();
      }
    }
    if (source[index] === '[') {
      index += 1; whitespace(); if (source[index] === ']') { index += 1; return; }
      while (true) { value(); whitespace(); if (source[index] === ']') { index += 1; return; } if (source[index++] !== ',') throw new SyntaxError(); }
    }
    if (source[index] === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(index));
    if (!token) throw new SyntaxError();
    index += token[0].length;
  };
  value(); whitespace(); if (index !== source.length) throw new SyntaxError();
}

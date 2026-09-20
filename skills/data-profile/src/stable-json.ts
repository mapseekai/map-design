type Category = string | number | boolean | null;

const categoryTypeRank: Record<'null' | 'number' | 'string' | 'boolean', number> = {
  null: 0,
  number: 1,
  string: 2,
  boolean: 3,
};

function isCategory(value: unknown): value is Category {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function categoryType(value: Category): keyof typeof categoryTypeRank {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  return 'boolean';
}

function compareCategories(left: Category, right: Category): number {
  const typeDifference = categoryTypeRank[categoryType(left)] - categoryTypeRank[categoryType(right)];
  if (typeDifference !== 0) {
    return typeDifference;
  }

  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function normalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalize(item));

    if (key === 'categories' && normalized.every(isCategory)) {
      return normalized.sort(compareCategories);
    }

    return normalized;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([objectKey, objectValue]) => [objectKey, normalize(objectValue, objectKey)]),
    );
  }

  return value;
}

export function stableJson(value: unknown): string {
  const serialized = JSON.stringify(normalize(value), null, 2);
  if (serialized === undefined) {
    throw new TypeError('stableJson requires a JSON-serializable value');
  }

  return `${serialized}\n`;
}

/** Require a fixture value without hiding missing data behind a type assertion. */
export function required<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error('Expected test fixture value to be defined.');
  }
  return value;
}

import {describe, expect, expectTypeOf, it} from 'vitest';

import {required} from './required.js';

describe('required fixture values', () => {
  it.each([0, false, '', [], {}])('preserves a defined value: %j', (value) => {
    expect(required(value)).toBe(value);
  });

  it.each([undefined, null])('rejects a missing value: %s', (value) => {
    expect(() => required(value)).toThrow('Expected test fixture value to be defined.');
  });

  it('narrows optional values without rejecting false', () => {
    const fixture: {enabled?: boolean} = {enabled: false};
    const value = required(fixture.enabled);
    expectTypeOf(value).toEqualTypeOf<boolean>();
    expect(value).toBe(false);
  });
});

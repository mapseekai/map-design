import { describe, expect, it } from 'vitest';

import { applyColorPickerValue, colorPickerValue, validStyleColor } from '../../../src/map-design/style-edit/color';

describe('style color picker adapter', () => {
  it('accepts only supported CSS hex lengths and expands short picker colors', () => {
    expect(['#abc', '#abcd', '#aabbcc', '#aabbccdd'].every(validStyleColor)).toBe(true);
    expect(['#abcde', '#abcdef0'].some(validStyleColor)).toBe(false);
    expect(colorPickerValue('#1a2f')).toBe('#11aa22');
  });

  it('preserves alpha when the native picker changes the RGB channels', () => {
    expect(applyColorPickerValue('#1a2f', '#336699')).toBe('#336699ff');
    expect(applyColorPickerValue('#11223380', '#abcdef')).toBe('#abcdef80');
    expect(applyColorPickerValue('#112233', '#abcdef')).toBe('#abcdef');
  });
});

const STYLE_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function validStyleColor(value: unknown): value is string {
  return typeof value === 'string' && STYLE_COLOR.test(value);
}

export function colorPickerValue(value: unknown): string {
  if (!validStyleColor(value)) return '#000000';
  const hex = value.slice(1);
  if (hex.length === 3 || hex.length === 4) return `#${[...hex.slice(0, 3)].map((digit) => digit.repeat(2)).join('')}`;
  return `#${hex.slice(0, 6)}`;
}

export function applyColorPickerValue(current: unknown, pickerValue: string): string {
  const color = colorPickerValue(pickerValue);
  if (!validStyleColor(current)) return color;
  const hex = current.slice(1);
  const alpha = hex.length === 4 ? hex[3]!.repeat(2) : hex.length === 8 ? hex.slice(6) : '';
  return `${color}${alpha}`;
}

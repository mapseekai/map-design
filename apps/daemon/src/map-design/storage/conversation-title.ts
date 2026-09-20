export function titleFromFirstMessage(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  const points = Array.from(normalized);
  return points.length <= 48 ? normalized : `${points.slice(0, 48).join('')}…`;
}

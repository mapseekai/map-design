function bubble(label: string, color: string, background: string, font: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.beginPath(); context.moveTo(16, 7); context.lineTo(48, 7);
  context.quadraticCurveTo(57, 7, 57, 16); context.lineTo(57, 39);
  context.quadraticCurveTo(57, 48, 48, 48); context.lineTo(26, 48);
  context.lineTo(11, 58); context.lineTo(11, 45);
  context.quadraticCurveTo(7, 42, 7, 36); context.lineTo(7, 16);
  context.quadraticCurveTo(7, 7, 16, 7); context.closePath();
  context.fillStyle = background; context.fill(); context.strokeStyle = color; context.lineWidth = 3; context.stroke();
  context.fillStyle = color; context.font = `600 24px ${font}`;
  context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(label, 32, 28);
  return canvas;
}

export function commentIconImage(label: string, color: string, background: string, font: string): ImageData | null {
  return bubble(label, color, background, font).getContext('2d')?.getImageData(0, 0, 64, 64) ?? null;
}

export function commentCursor(canvas: HTMLCanvasElement): string {
  const theme = getComputedStyle(canvas);
  const color = theme.getPropertyValue('--primary').trim() || '#a9583e';
  const background = theme.getPropertyValue('--card').trim() || '#faf9f5';
  // Match the toolbar's Lucide MessageSquarePlus geometry; SVG stays sharp at device scale.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${background}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 8v6M9 11h6" fill="none"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 21, crosshair`;
}

/**
 * Normalize a computed CSS color ("rgb(255, 0, 0)", "rgba(0,0,0,0.5)", "#f00", "red" …)
 * to lowercase "#rrggbb". Returns null for "none", "transparent" and fully transparent colors.
 * Paint servers (gradients/patterns, "url(#id)") count as black, like most laser software.
 */
export function cssColorToHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return null;
  if (v.startsWith('url(')) return '#000000';
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    if (alpha <= 0) return null;
    return '#' + [rgb[1], rgb[2], rgb[3]].map((c) => Math.max(0, Math.min(255, Math.round(parseFloat(c)))).toString(16).padStart(2, '0')).join('');
  }
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return '#' + h;
  }
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', lime: '#00ff00', yellow: '#ffff00', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff', gray: '#808080', grey: '#808080', orange: '#ffa500' };
  return named[v] ?? '#000000';
}

/** How an SVG element is painted, which decides the layer mode for its color. */
export function paintOf(style: { stroke: string; fill: string; strokeWidth: string; strokeOpacity: string; fillOpacity: string; opacity: string }): { color: string; mode: 'line' | 'fill' } | null {
  if (parseFloat(style.opacity || '1') <= 0) return null;
  const stroke = parseFloat(style.strokeWidth || '1') > 0 && parseFloat(style.strokeOpacity || '1') > 0 ? cssColorToHex(style.stroke) : null;
  if (stroke) return { color: stroke, mode: 'line' };
  const fill = parseFloat(style.fillOpacity || '1') > 0 ? cssColorToHex(style.fill) : null;
  if (fill) return { color: fill, mode: 'fill' };
  return null;
}

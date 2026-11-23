import { describe, expect, it } from 'vitest';
import { cssColorToHex, paintOf } from '../src/renderer/src/io/svgColor';

const style = (p: Partial<Parameters<typeof paintOf>[0]>) => ({ stroke: 'none', fill: 'rgb(0, 0, 0)', strokeWidth: '1px', strokeOpacity: '1', fillOpacity: '1', opacity: '1', ...p });

describe('SVG colors', () => {
  it('normalizes computed colors to #rrggbb', () => {
    expect(cssColorToHex('rgb(229, 36, 59)')).toBe('#e5243b');
    expect(cssColorToHex('rgba(0, 0, 255, 0.5)')).toBe('#0000ff');
    expect(cssColorToHex('#F00')).toBe('#ff0000');
    expect(cssColorToHex('red')).toBe('#ff0000');
    expect(cssColorToHex('url("#gradient")')).toBe('#000000');
  });

  it('treats none / transparent / alpha 0 as no paint', () => {
    expect(cssColorToHex('none')).toBeNull();
    expect(cssColorToHex('transparent')).toBeNull();
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull();
  });

  it('uses the stroke color for stroked shapes (line) and the fill for fill-only shapes', () => {
    expect(paintOf(style({ stroke: 'rgb(255, 0, 0)', fill: 'rgb(0, 0, 0)' }))).toEqual({ color: '#ff0000', mode: 'line' });
    expect(paintOf(style({}))).toEqual({ color: '#000000', mode: 'fill' });
  });

  it('ignores invisible shapes', () => {
    expect(paintOf(style({ fill: 'none' }))).toBeNull();
    expect(paintOf(style({ opacity: '0' }))).toBeNull();
    expect(paintOf(style({ stroke: 'red', strokeWidth: '0px', fill: 'none' }))).toBeNull();
    expect(paintOf(style({ fillOpacity: '0' }))).toBeNull();
  });
});

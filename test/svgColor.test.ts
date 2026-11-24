import { describe, expect, it } from 'vitest';
import { cssColorToHex, paintsOf } from '../src/renderer/src/io/svgColor';

const style = (p: Partial<Parameters<typeof paintsOf>[0]>) => ({ stroke: 'none', fill: 'rgb(0, 0, 0)', strokeWidth: '1px', strokeOpacity: '1', fillOpacity: '1', opacity: '1', ...p });

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

  it('strokes become lines and fills become fill engraving', () => {
    expect(paintsOf(style({ stroke: 'rgb(255, 0, 0)', fill: 'none' }))).toEqual([{ color: '#ff0000', mode: 'line' }]);
    expect(paintsOf(style({}))).toEqual([{ color: '#000000', mode: 'fill' }]);
  });

  it('a red outline around a blue area gives two operations: cut the outline, engrave the area', () => {
    expect(paintsOf(style({ stroke: 'rgb(255, 0, 0)', fill: 'rgb(0, 0, 255)' }))).toEqual([
      { color: '#ff0000', mode: 'line' },
      { color: '#0000ff', mode: 'fill' },
    ]);
  });

  it('stroke and fill in the same color stay one line operation; <line> has no fill', () => {
    expect(paintsOf(style({ stroke: 'rgb(0, 0, 0)', fill: 'rgb(0, 0, 0)' }))).toEqual([{ color: '#000000', mode: 'line' }]);
    expect(paintsOf(style({ stroke: 'rgb(255, 0, 0)' }), false)).toEqual([{ color: '#ff0000', mode: 'line' }]);
  });

  it('ignores invisible shapes', () => {
    expect(paintsOf(style({ fill: 'none' }))).toEqual([]);
    expect(paintsOf(style({ opacity: '0' }))).toEqual([]);
    expect(paintsOf(style({ stroke: 'red', strokeWidth: '0px', fill: 'none' }))).toEqual([]);
    expect(paintsOf(style({ fillOpacity: '0' }))).toEqual([]);
  });
});

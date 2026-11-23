/** All coordinates are in mm. Y points up (origin at the machine's front-left corner, like GRBL). */
export interface Pt {
  x: number;
  y: number;
}

/** A polyline; it is closed when the last point equals the first. */
export type Polyline = Pt[];

export type LayerMode = 'line' | 'fill' | 'image';
export type DitherMode = 'threshold' | 'floyd' | 'grayscale';

export interface Layer {
  id: string;
  name: string;
  color: string;
  /** line = cut/score along paths; fill = engrave the inside of vectors; image = engrave a picture */
  mode: LayerMode;
  /** Speed (mm/min) */
  speed: number;
  /** Maximum power (% of S max) */
  power: number;
  /** Minimum power for grayscale images (%) */
  minPower: number;
  passes: number;
  /** Scan line interval when engraving (mm) */
  lineInterval: number;
  dither: DitherMode;
  /** Black/white threshold 0..255 for threshold mode */
  threshold: number;
  /** Overscan past each scan line so the speed is steady (mm) */
  overscan: number;
  bidirectional: boolean;
  /** Skip this layer when running/exporting */
  enabled: boolean;
}

export interface Bitmap {
  width: number;
  height: number;
  /** Gray level 0 (black) .. 255 (white); row 0 is the TOP row of the image */
  gray: Uint8Array;
  /** Preview image drawn on the canvas */
  url: string;
}

export interface Copies {
  cols: number;
  rows: number;
  /** Gap between copies (mm) */
  gapX: number;
  gapY: number;
}

/** Parameters of a drawn shape, kept so it stays editable (corner radius, sides). */
export interface ShapeSpec {
  type: 'rect' | 'ellipse' | 'polygon' | 'line';
  /** Rectangle corner radius (mm) */
  radius?: number;
  /** Number of sides of a regular polygon */
  sides?: number;
}

export interface Item {
  id: string;
  name: string;
  kind: 'vector' | 'bitmap';
  shape?: ShapeSpec;
  /** Vector paths in source coordinates (mm), scaled to w×h when placed */
  paths?: Polyline[];
  bitmap?: Bitmap;
  /** Original size at import (mm) — used to compute the scale factor */
  srcW: number;
  srcH: number;
  /** Current bottom-left position and size (mm) */
  x: number;
  y: number;
  w: number;
  h: number;
  layerId: string;
  copies: Copies;
  /** Per-object settings that replace the layer's (used by material-test cells) */
  override?: LayerOverride;
}

export interface LayerOverride {
  speed?: number;
  power?: number;
  passes?: number;
}

export interface MachineProfile {
  /** Machine name, e.g. "Sculpfun S30" — used to filter the material library */
  name: string;
  /** Laser head / module, e.g. "10W diode" */
  laser: string;
  bedW: number;
  bedH: number;
  /** GRBL's $30 value */
  sMax: number;
  baud: number;
  /** Framing speed (mm/min) */
  frameSpeed: number;
  /** Framing power (%) — low so the material is not marked */
  framePower: number;
  /** Travel (G0) speed used for time estimates */
  travelSpeed: number;
}

export type OriginMode = 'absolute' | 'current';
/** The 9 anchor points of the job area, e.g. 'bl' = bottom-left, 'c' = center */
export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

export interface JobOptions {
  originMode: OriginMode;
  anchor: Anchor;
  /** Current work position of the laser head (used when originMode = 'current') */
  currentPos: Pt;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One saved set of cut settings in the material library. */
export interface MaterialPreset {
  id: string;
  machine: string;
  laser: string;
  /** e.g. "Plywood", "Leather", "Acrylic" */
  material: string;
  /** Material thickness (mm) */
  thickness: number;
  /** What the settings are for, e.g. "Cut", "Engrave", "Score" */
  operation: string;
  mode: LayerMode;
  speed: number;
  power: number;
  minPower: number;
  passes: number;
  lineInterval: number;
  dither: DitherMode;
  threshold: number;
  overscan: number;
  bidirectional: boolean;
  notes: string;
}

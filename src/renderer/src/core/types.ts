/** Mọi tọa độ tính bằng mm. Trục Y hướng lên (gốc ở góc trước-trái của máy, giống GRBL). */
export interface Pt {
  x: number;
  y: number;
}

/** Một đường gấp khúc; nếu điểm cuối trùng điểm đầu thì là đường kín. */
export type Polyline = Pt[];

export type LayerMode = 'line' | 'fill' | 'image';
export type DitherMode = 'threshold' | 'floyd' | 'grayscale';

export interface Layer {
  id: string;
  name: string;
  color: string;
  /** line = cắt/vạch theo nét; fill = khắc tô kín vùng vector; image = khắc ảnh */
  mode: LayerMode;
  /** Tốc độ (mm/phút) */
  speed: number;
  /** Công suất tối đa (% của S max) */
  power: number;
  /** Công suất tối thiểu cho ảnh xám (%) */
  minPower: number;
  passes: number;
  /** Khoảng cách dòng quét khi khắc (mm) */
  lineInterval: number;
  dither: DitherMode;
  /** Ngưỡng đen/trắng 0..255 cho chế độ threshold */
  threshold: number;
  /** Đi quá biên mỗi dòng quét để tốc độ ổn định (mm) */
  overscan: number;
  bidirectional: boolean;
  /** Bỏ qua lớp khi xuất */
  enabled: boolean;
}

export interface Bitmap {
  width: number;
  height: number;
  /** Độ xám 0 (đen) .. 255 (trắng), hàng 0 là hàng TRÊN CÙNG của ảnh */
  gray: Uint8Array;
  /** Ảnh xem trước để vẽ lên canvas */
  url: string;
}

export interface Copies {
  cols: number;
  rows: number;
  /** Khoảng cách giữa các bản sao (mm) */
  gapX: number;
  gapY: number;
}

/** Thông số của hình vẽ trực tiếp, để còn chỉnh lại được (bo góc, số cạnh). */
export interface ShapeSpec {
  type: 'rect' | 'ellipse' | 'polygon' | 'line';
  /** Bán kính bo góc của hình chữ nhật (mm) */
  radius?: number;
  /** Số cạnh của đa giác đều */
  sides?: number;
}

export interface Item {
  id: string;
  name: string;
  kind: 'vector' | 'bitmap';
  shape?: ShapeSpec;
  /** Đường vector theo tọa độ gốc (đơn vị mm), sẽ được co giãn về w×h */
  paths?: Polyline[];
  bitmap?: Bitmap;
  /** Kích thước gốc lúc nhập (mm) — dùng để tính tỉ lệ co giãn */
  srcW: number;
  srcH: number;
  /** Vị trí góc dưới-trái và kích thước hiện tại (mm) */
  x: number;
  y: number;
  w: number;
  h: number;
  layerId: string;
  copies: Copies;
}

export interface MachineProfile {
  bedW: number;
  bedH: number;
  /** Giá trị $30 của GRBL */
  sMax: number;
  baud: number;
  /** Tốc độ chạy khung (mm/phút) */
  frameSpeed: number;
  /** Công suất khi chạy khung (%) — thấp để không cháy phôi */
  framePower: number;
  /** Tốc độ di chuyển không cắt G0 dùng khi chạy lệnh khắc ảnh */
  travelSpeed: number;
}

export type OriginMode = 'absolute' | 'current';
/** 9 điểm neo của vùng cắt, ví dụ 'bl' = dưới-trái, 'c' = tâm */
export type Anchor = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

export interface JobOptions {
  originMode: OriginMode;
  anchor: Anchor;
  /** Vị trí làm việc hiện tại của đầu laser (dùng cho originMode = 'current') */
  currentPos: Pt;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

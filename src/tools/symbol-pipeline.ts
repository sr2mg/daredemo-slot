/**
 * 図柄アセットの後処理パイプライン（純関数部）。
 * AI 画像生成の弱点（セット間のスタイルばらつき・透過の甘さ）を、
 * 「背景除去 → 内容トリム → 縮小 → パレット量子化 → 検証」で強制的に均す。
 * 少数色・固定解像度に潰すことで、多少ばらついた生成物も「同じ台の図柄」に見える
 * （音楽の「強拍はコードトーン」と同じ、機械検証可能な様式制約）。
 *
 * PNG の入出力は CLI（tools/process-symbols.ts）が担当し、ここは RGBA バッファのみ扱う。
 */

export interface Rgba {
  width: number;
  height: number;
  /** RGBA 8bit、長さ width*height*4 */
  data: Uint8Array;
}

const at = (img: Rgba, x: number, y: number): number => (y * img.width + x) * 4;

const colorDist = (img: Rgba, i: number, r: number, g: number, b: number): number =>
  Math.abs(img.data[i]! - r) + Math.abs(img.data[i + 1]! - g) + Math.abs(img.data[i + 2]! - b);

/**
 * 背景除去: 四隅の平均色に近い色を、外周からのフラッドフィルで透明にする。
 * 図柄内部の同色（例: 白いハイライト）は外周と繋がっていない限り残る。
 */
export function removeBackground(img: Rgba, tolerance = 90): Rgba {
  const { width, height } = img;
  const data = new Uint8Array(img.data);
  const corners = [at(img, 0, 0), at(img, width - 1, 0), at(img, 0, height - 1), at(img, width - 1, height - 1)];
  const bg = [0, 1, 2].map((c) => corners.reduce((sum, i) => sum + img.data[i + c]!, 0) / 4) as [
    number,
    number,
    number,
  ];

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (colorDist({ width, height, data }, p * 4, bg[0], bg[1], bg[2]) <= tolerance) stack.push(p);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    data[p * 4 + 3] = 0;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return { width, height, data };
}

/**
 * 不透明ピクセルのバウンディングボックスで切り出し、少し余白を足して
 * 指定アスペクト比（幅/高さ。既定 1 = 正方形）のキャンバスに中央配置する。
 * 実機の図柄は規則上も横長（縦 25mm 以上・横 35mm 以上）なので通常 1.6 を使う
 */
export function cropToContent(img: Rgba, padRatio = 0.06, aspect = 1): Rgba {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[at(img, x, y) + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img; // 全透明はそのまま（検証で落ちる）
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  // 内容がちょうど収まる aspect 比のキャンバス + 余白
  const boxH = Math.max(h, Math.ceil(w / aspect));
  const outH = Math.ceil(boxH * (1 + padRatio * 2));
  const outW = Math.ceil(outH * aspect);
  const out: Rgba = { width: outW, height: outH, data: new Uint8Array(outW * outH * 4) };
  const ox = ((outW - w) / 2) | 0;
  const oy = ((outH - h) / 2) | 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = at(img, minX + x, minY + y);
      const dst = at(out, ox + x, oy + y);
      out.data.set(img.data.subarray(src, src + 4), dst);
    }
  }
  return out;
}

/** ボックス平均で縮小（拡大は最近傍）。height 省略時は正方形 */
export function resizeTo(img: Rgba, size: number, heightSize = size): Rgba {
  const out: Rgba = { width: size, height: heightSize, data: new Uint8Array(size * heightSize * 4) };
  for (let y = 0; y < heightSize; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * img.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / size));
      const y0 = Math.floor((y * img.height) / heightSize);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / heightSize));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = at(img, sx, sy);
          const alpha = img.data[i + 3]!;
          r += img.data[i]! * alpha;
          g += img.data[i + 1]! * alpha;
          b += img.data[i + 2]! * alpha;
          a += alpha;
          n++;
        }
      }
      const o = at(out, x, y);
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * メディアンカットによるパレット量子化 + アルファ 2 値化（ドット絵の様式へ潰す）。
 * 戻り値の palette は検証・レポート用。
 */
export function quantize(img: Rgba, maxColors = 16): { image: Rgba; palette: [number, number, number][] } {
  const opaque: number[] = [];
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! >= 128) opaque.push(i);
  }
  // メディアンカット: 最大レンジの軸で再帰分割
  let buckets: number[][] = [opaque];
  while (buckets.length < maxColors) {
    let bestBucket = -1;
    let bestRange = -1;
    let bestAxis = 0;
    for (let bi = 0; bi < buckets.length; bi++) {
      const bucket = buckets[bi]!;
      if (bucket.length < 2) continue;
      for (let axis = 0; axis < 3; axis++) {
        let lo = 255;
        let hi = 0;
        for (const i of bucket) {
          const v = img.data[i + axis]!;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          bestBucket = bi;
          bestAxis = axis;
        }
      }
    }
    if (bestBucket < 0 || bestRange <= 0) break; // これ以上分けられない
    const bucket = buckets[bestBucket]!;
    bucket.sort((p, q) => img.data[p + bestAxis]! - img.data[q + bestAxis]!);
    const mid = bucket.length >> 1;
    buckets.splice(bestBucket, 1, bucket.slice(0, mid), bucket.slice(mid));
    buckets = buckets.filter((b) => b.length > 0);
  }
  const palette: [number, number, number][] = buckets.map((bucket) => {
    const avg = [0, 1, 2].map(
      (c) => Math.round(bucket.reduce((sum, i) => sum + img.data[i + c]!, 0) / bucket.length),
    );
    return [avg[0]!, avg[1]!, avg[2]!];
  });

  const out = new Uint8Array(img.data);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3]! < 128) {
      out[i + 3] = 0;
      continue;
    }
    out[i + 3] = 255;
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const [r, g, b] = palette[p]!;
      const d = (out[i]! - r) ** 2 + (out[i + 1]! - g) ** 2 + (out[i + 2]! - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const [r, g, b] = palette[best]!;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
  }
  return { image: { width: img.width, height: img.height, data: out }, palette };
}

export interface SymbolReport {
  colors: number;
  opaqueRatio: number;
  size: number;
  ok: boolean;
  problems: string[];
}

/** 様式制約の機械検証: 色数・不透明率・サイズ */
export function validateSymbol(img: Rgba, maxColors = 16): SymbolReport {
  const colors = new Set<number>();
  let opaqueCount = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! >= 128) {
      opaqueCount++;
      colors.add((img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!);
    }
  }
  const opaqueRatio = opaqueCount / (img.width * img.height);
  const problems: string[] = [];
  if (colors.size > maxColors) problems.push(`色数 ${colors.size} > ${maxColors}`);
  if (opaqueRatio < 0.1) problems.push(`不透明率 ${(opaqueRatio * 100).toFixed(1)}% < 10%（背景除去で消えすぎ？）`);
  if (opaqueRatio > 0.98) problems.push(`不透明率 ${(opaqueRatio * 100).toFixed(1)}% > 98%（背景が残っている？）`);
  if (img.width < img.height) problems.push(`縦長 ${img.width}x${img.height}（実機図柄は横長。規則も縦25mm以上・横35mm以上）`);
  return { colors: colors.size, opaqueRatio, size: img.width, ok: problems.length === 0, problems };
}

/** シート画像を等間隔グリッドでセルに分割する */
export function splitGrid(img: Rgba, cols: number, rows: number): Rgba[] {
  const cw = Math.floor(img.width / cols);
  const ch = Math.floor(img.height / rows);
  const cells: Rgba[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell: Rgba = { width: cw, height: ch, data: new Uint8Array(cw * ch * 4) };
      for (let y = 0; y < ch; y++) {
        const src = at(img, c * cw, r * ch + y);
        cell.data.set(img.data.subarray(src, src + cw * 4), y * cw * 4);
      }
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * 生成画像 1 セルぶんの標準処理: 背景除去 → トリム → 縮小 → 量子化。
 * 既定は 160×100px（アスペクト 1.6 の横長）・32 色（印刷シール調）。
 * 実機の図柄は規則上も横長（縦 25mm 以上・横 35mm 以上 = 最低 1.4:1）で、
 * リール帯の実物も概ね 2:1 前後。シミュレータのコマ枠 ≒1.6:1 に合わせる。
 * 注意: シールの白縁を使う様式では、生成背景を白でなくライトグレーにすること
 * （白背景だとフラッドフィルが白縁を食う）。
 */
export function processSymbol(
  raw: Rgba,
  opts: { size?: number; maxColors?: number; tolerance?: number; aspect?: number } = {},
): { image: Rgba; report: SymbolReport } {
  const { size = 160, maxColors = 32, tolerance = 80, aspect = 1.6 } = opts;
  const height = Math.round(size / aspect);
  const cleaned = cropToContent(removeBackground(raw, tolerance), 0.06, aspect);
  const { image } = quantize(resizeTo(cleaned, size, height), maxColors);
  return { image, report: validateSymbol(image, maxColors) };
}

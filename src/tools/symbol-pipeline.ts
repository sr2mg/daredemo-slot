/**
 * 図柄アセットの後処理パイプライン（純関数部）。
 * AI 画像生成の弱点（セット間のスタイルばらつき・透過の甘さ）を、
 * 「背景除去 → 内容トリム → 縮小 → パレット量子化 → 検証」で強制的に均す。
 * 少数色・固定解像度に潰すことで、多少ばらついた生成物も「同じ台の図柄」に見える
 * （音楽の「強拍はコードトーン」と同じ、機械検証可能な様式制約）。
 *
 * PNG の入出力は CLI（tools/process-symbols.ts）が担当し、ここは RGBA バッファのみ扱う。
 */

import { Xoshiro128 } from '../core/rng.js';

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

/** 様式制約の機械検証: 色数・不透明率・横長。既定の色数上限は現行基準の 32 */
export function validateSymbol(img: Rgba, maxColors = 32): SymbolReport {
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

// ---------------------------------------------------------------------------
// 脱 GPT 後処理（AI 生成画像に共通する「GPT っぽさ」の統計的痕跡を打ち消す）
//
// 調査で確度が高かった痕跡と対応（docs/asset-prompts.md の調査ログ参照）:
// - 黄/セピアの色被り: プロンプトでは除去不能 → LAB の a/b 軸をホワイトバランス中和
// - CFG 由来の過飽和: 彩度をわずかに下げる
// - 高周波成分の系統的欠落（ツルツル/ワックス質感）と RGB ヒストグラムの尖り:
//   紙目グレイン + 網点（ドットゲイン）で高周波と色分布の広がりを同時に足す。
//   目標様式が「90 年代の印刷シール」なので、物理的にも同じ操作になるのが好都合
// ---------------------------------------------------------------------------

/** sRGB (0..255) → CIELAB (D65)。L: 0..100 / a,b: ±128 程度 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  // sRGB D65 変換行列 → XYZ を白色点で正規化
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB (D65) → sRGB (0..255、クランプ済み) */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = fInv(fx) * 0.95047;
  const y = fInv(fy);
  const z = fInv(fz) * 1.08883;
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const enc = (v: number) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return [enc(lr), enc(lg), enc(lb)];
}

/**
 * ホワイトバランス中和: 「白いはずの画素」（明るく低彩度 = シールの白縁が典型）の
 * 平均 a/b を測り、そのぶん全画素の a/b を引き戻す。GPT 系の黄被りは白が
 * クリーム色に流れる形で現れるので、白縁を基準にするのが最も原理的。
 * 基準画素が少ない絵では全不透明画素の平均に落ち、シフト量は上限でクランプする。
 */
export function neutralizeCast(img: Rgba, strength = 1): { image: Rgba; castA: number; castB: number } {
  const MAX_SHIFT = 12; // 基準の誤検出で絵が壊れないための上限
  let sumA = 0;
  let sumB = 0;
  let n = 0;
  let allA = 0;
  let allB = 0;
  let allN = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 128) continue;
    const [L, a, b] = rgbToLab(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
    allA += a;
    allB += b;
    allN++;
    if (L > 70 && Math.hypot(a, b) < 22) {
      sumA += a;
      sumB += b;
      n++;
    }
  }
  if (allN === 0) return { image: img, castA: 0, castB: 0 };
  // 白基準が不透明画素の 2% 未満なら全体平均（グレイワールド）へフォールバック
  const useWhite = n >= allN * 0.02;
  const clamp = (v: number) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, v));
  const castA = clamp((useWhite ? sumA / n : allA / allN) * strength);
  const castB = clamp((useWhite ? sumB / n : allB / allN) * strength);
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    const [L, a, b] = rgbToLab(data[i]!, data[i + 1]!, data[i + 2]!);
    const [r, g, bb] = labToRgb(L, a - castA, b - castB);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = bb;
  }
  return { image: { width: img.width, height: img.height, data }, castA, castB };
}

/** 彩度調整: LAB の a/b をスカラー倍（1 = 変化なし、0.9 = 一割減） */
export function adjustSaturation(img: Rgba, factor: number): Rgba {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    const [L, a, b] = rgbToLab(data[i]!, data[i + 1]!, data[i + 2]!);
    const [r, g, bb] = labToRgb(L, a * factor, b * factor);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = bb;
  }
  return { width: img.width, height: img.height, data };
}

/**
 * 印刷テクスチャ: 紙目グレイン（シード付き決定論ノイズ）+ 45° 網点のドットゲイン
 * （暗部ほどドットが乗る = オフセット印刷のインク太り）。
 * AI 生成の「高周波が無いツルツル面」と「尖った色ヒストグラム」を同時に崩す。
 */
export function addPrintTexture(
  img: Rgba,
  seed: number,
  opts: { grain?: number; dot?: number; dotPeriod?: number } = {},
): Rgba {
  const { grain = 5, dot = 7, dotPeriod = 3 } = opts;
  const rng = new Xoshiro128(seed);
  const data = new Uint8Array(img.data);
  const cos = Math.SQRT1_2; // 45° 回転スクリーン（新聞・チラシ印刷の定番角度）
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const noise = (rng.nextUint32() / 0xffff_ffff - 0.5) * 2; // 透明画素でも消費して座標対応を保つ
      if (data[i + 3]! < 128) continue;
      const u = (x * cos + y * cos) / dotPeriod;
      const v = (-x * cos + y * cos) / dotPeriod;
      const screen = (Math.sin(2 * Math.PI * u) + Math.sin(2 * Math.PI * v)) / 2; // -1..1
      const lum = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) / 255;
      // 紙目は全面に、網点は暗部ほど強く（ドットゲイン）。ハイライトの白は保護
      const delta = noise * grain + screen * dot * (1 - lum) * 0.9;
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.max(0, Math.min(255, Math.round(data[i + c]! + delta)));
      }
    }
  }
  return { width: img.width, height: img.height, data };
}

export interface DegptOptions {
  /** WB 中和の強さ 0..1（既定 1） */
  wbStrength?: number;
  /** 彩度係数（既定 0.92 = CFG 由来の盛りをひと回し戻す） */
  saturation?: number;
  /** 紙目ノイズ振幅（既定 5 / 0 で無効） */
  grain?: number;
  /** 網点の振幅（既定 7 / 0 で無効） */
  dot?: number;
  /** 再量子化の色数（既定 32。0 で量子化スキップ = パネル用） */
  maxColors?: number;
}

/**
 * 脱 GPT 後処理の一括適用: WB 中和 → 彩度調整 → 印刷テクスチャ → 再量子化。
 * シード固定で完全再現可能（同じ入力 + 同じシード = 同じ出力）。
 */
export function degptImage(
  img: Rgba,
  seed: number,
  opts: DegptOptions = {},
): { image: Rgba; castA: number; castB: number } {
  const { wbStrength = 1, saturation = 0.92, grain = 5, dot = 7, maxColors = 32 } = opts;
  const { image: balanced, castA, castB } = neutralizeCast(img, wbStrength);
  const desat = saturation === 1 ? balanced : adjustSaturation(balanced, saturation);
  const textured = grain === 0 && dot === 0 ? desat : addPrintTexture(desat, seed, { grain, dot });
  const image = maxColors > 0 ? quantize(textured, maxColors).image : textured;
  return { image, castA, castB };
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

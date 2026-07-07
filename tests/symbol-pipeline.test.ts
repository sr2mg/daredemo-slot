import { describe, expect, it } from 'vitest';
import {
  addPrintTexture,
  adjustSaturation,
  cropToContent,
  degptImage,
  labToRgb,
  neutralizeCast,
  processSymbol,
  quantize,
  removeBackground,
  resizeTo,
  rgbToLab,
  splitGrid,
  validateSymbol,
} from '../src/tools/symbol-pipeline.js';
import type { Rgba } from '../src/tools/symbol-pipeline.js';

/** 単色背景 + 中央に矩形図柄の合成画像を作る */
function synthetic(
  width: number,
  height: number,
  bg: [number, number, number],
  rect: { x: number; y: number; w: number; h: number; color: [number, number, number] },
): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inRect = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inRect ? rect.color : bg;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('図柄パイプライン', () => {
  const raw = synthetic(200, 200, [250, 250, 250], { x: 60, y: 60, w: 80, h: 80, color: [200, 30, 30] });

  it('背景除去: 外周の白は透明に、図柄の赤は残る', () => {
    const out = removeBackground(raw);
    expect(out.data[3]).toBe(0); // 左上 = 背景
    const center = ((100 * 200 + 100) * 4) as number;
    expect(out.data[center + 3]).toBe(255); // 中央 = 図柄
  });

  it('図柄内部の背景色（ハイライト）は外周と繋がっていなければ残る', () => {
    const img = synthetic(100, 100, [255, 255, 255], { x: 20, y: 20, w: 60, h: 60, color: [0, 0, 200] });
    // 図柄の中に白い点（ハイライト）を打つ
    const hole = ((50 * 100 + 50) * 4) as number;
    img.data[hole] = 255;
    img.data[hole + 1] = 255;
    img.data[hole + 2] = 255;
    const out = removeBackground(img);
    expect(out.data[hole + 3]).toBe(255); // 内部の白は残る
  });

  it('トリム: 不透明領域が中央の正方形に収まる', () => {
    const out = cropToContent(removeBackground(raw));
    expect(out.width).toBe(out.height);
    expect(out.width).toBeGreaterThanOrEqual(80); // 図柄 80px + 余白
    expect(out.width).toBeLessThan(100);
  });

  it('縮小: 指定サイズの正方形になる', () => {
    const out = resizeTo(raw, 64);
    expect(out.width).toBe(64);
    expect(out.height).toBe(64);
  });

  it('量子化: 色数が上限以下に潰れ、アルファは 2 値になる', () => {
    // グラデーション画像（多色）を作る
    const grad: Rgba = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
    for (let i = 0; i < 64 * 64; i++) {
      grad.data[i * 4] = i % 256;
      grad.data[i * 4 + 1] = (i * 7) % 256;
      grad.data[i * 4 + 2] = 128;
      grad.data[i * 4 + 3] = 200;
    }
    const { image, palette } = quantize(grad, 16);
    expect(palette.length).toBeLessThanOrEqual(16);
    const report = validateSymbol(image, 16);
    expect(report.colors).toBeLessThanOrEqual(16);
    for (let i = 3; i < image.data.length; i += 4) {
      expect([0, 255]).toContain(image.data[i]);
    }
  });

  it('シート分割: 4x2 グリッドが 8 セルになり、各セルが正しい領域を持つ', () => {
    const sheet = synthetic(400, 200, [255, 255, 255], { x: 0, y: 0, w: 100, h: 100, color: [255, 0, 0] });
    const cells = splitGrid(sheet, 4, 2);
    expect(cells).toHaveLength(8);
    expect(cells[0]!.width).toBe(100);
    expect(cells[0]!.data[0]).toBe(255); // 左上セルは赤
    expect(cells[1]!.data[0]).toBe(255); // 隣セルは白（R=255 だが G も 255）
    expect(cells[1]!.data[1]).toBe(255);
  });

  it('一気通貫: 合成図柄が 160x100（実機準拠の横長）・32色・検証 OK で出てくる', () => {
    const { image, report } = processSymbol(raw);
    expect(image.width).toBe(160);
    expect(image.height).toBe(100);
    expect(report.ok, report.problems.join(' / ')).toBe(true);
    expect(report.colors).toBeLessThanOrEqual(32);
    expect(report.opaqueRatio).toBeGreaterThan(0.1);
  });

  it('トリム: aspect 指定で横長キャンバスに中央配置される', () => {
    const out = cropToContent(removeBackground(raw), 0.06, 1.6);
    expect(out.width / out.height).toBeCloseTo(1.6, 1);
  });

  it('検証: 縦長画像は NG になる（実機図柄は横長）', () => {
    const tall: Rgba = { width: 50, height: 100, data: new Uint8Array(50 * 100 * 4).fill(255) };
    const report = validateSymbol(tall);
    expect(report.problems.some((p) => p.includes('縦長'))).toBe(true);
  });

  it('白縁ステッカーはグレー背景なら縁が残る（白背景だと食われるので生成時の背景はグレー）', () => {
    // グレー背景 + 白い縁 + 中身の赤、の三層
    const img = synthetic(120, 120, [216, 216, 216], { x: 30, y: 30, w: 60, h: 60, color: [255, 255, 255] });
    for (let y = 45; y < 75; y++) {
      for (let x = 45; x < 75; x++) {
        const i = (y * 120 + x) * 4;
        img.data[i] = 200;
        img.data[i + 1] = 30;
        img.data[i + 2] = 30;
      }
    }
    const out = removeBackground(img, 80);
    const border = ((35 * 120 + 60) * 4) as number; // 白縁の上辺
    expect(out.data[border + 3]).toBe(255); // 白縁は残る
    expect(out.data[3]).toBe(0); // グレー背景は消える
  });

  it('検証: 背景が残った画像（不透明率 100%）は NG になる', () => {
    const report = validateSymbol(resizeTo(raw, 64)); // 背景除去せずに検証
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => p.includes('背景'))).toBe(true);
  });
});

describe('脱 GPT 後処理', () => {
  /** クリーム色の「白縁」+ 赤の中身（GPT の黄被りを模した合成図柄） */
  function creamSticker(): Rgba {
    const img = synthetic(80, 50, [255, 249, 224], { x: 20, y: 12, w: 40, h: 26, color: [200, 40, 30] });
    return img;
  }

  it('LAB 変換が往復する（sRGB → LAB → sRGB）', () => {
    for (const [r, g, b] of [
      [255, 255, 255],
      [0, 0, 0],
      [200, 40, 30],
      [255, 249, 224],
    ] as const) {
      const [L, a, bb] = rgbToLab(r, g, b);
      const [r2, g2, b2] = labToRgb(L, a, bb);
      expect(Math.abs(r2 - r)).toBeLessThanOrEqual(1);
      expect(Math.abs(g2 - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(b2 - b)).toBeLessThanOrEqual(1);
    }
  });

  it('WB 中和: クリーム色の白縁が中立白に寄り、黄方向の補正量が報告される', () => {
    const { image, castB } = neutralizeCast(creamSticker());
    expect(castB).toBeGreaterThan(3); // 黄被り（b* 正）を検出
    const [, , bAfter] = rgbToLab(image.data[0]!, image.data[1]!, image.data[2]!);
    expect(Math.abs(bAfter)).toBeLessThan(2); // 白がほぼ中立に
    // 赤の中身は赤のまま（彩度の高い画素も一律シフトされるが、色相は保たれる）
    const center = ((25 * 80 + 40) * 4) as number;
    expect(image.data[center]!).toBeGreaterThan(image.data[center + 2]! + 100);
  });

  it('彩度調整: LAB クロマが指定係数ぶん下がる', () => {
    const img = synthetic(10, 10, [200, 40, 30], { x: 0, y: 0, w: 0, h: 0, color: [0, 0, 0] });
    const out = adjustSaturation(img, 0.8);
    const [, a1, b1] = rgbToLab(200, 40, 30);
    const [, a2, b2] = rgbToLab(out.data[0]!, out.data[1]!, out.data[2]!);
    expect(Math.hypot(a2, b2)).toBeCloseTo(Math.hypot(a1, b1) * 0.8, 0);
  });

  it('印刷テクスチャ: 決定論（同シード同出力・異シード異出力）で、透明画素は触らない', () => {
    const img = removeBackground(creamSticker(), 60);
    const a = addPrintTexture(img, 42);
    const b = addPrintTexture(img, 42);
    const c = addPrintTexture(img, 43);
    expect(a.data).toEqual(b.data);
    expect(a.data).not.toEqual(c.data);
    for (let i = 0; i < img.data.length; i += 4) {
      expect(a.data[i + 3]).toBe(img.data[i + 3]); // アルファ不変
    }
  });

  it('印刷テクスチャ: 色数（ヒストグラムの広がり）が増える', () => {
    const img = creamSticker();
    const count = (x: Rgba) => {
      const s = new Set<number>();
      for (let i = 0; i < x.data.length; i += 4) s.add((x.data[i]! << 16) | (x.data[i + 1]! << 8) | x.data[i + 2]!);
      return s.size;
    };
    expect(count(addPrintTexture(img, 1))).toBeGreaterThan(count(img) * 4);
  });

  it('一気通貫 degptImage: 32 色以内に再量子化され、様式検証を通る', () => {
    const sticker = quantize(resizeTo(cropToContent(removeBackground(creamSticker(), 60), 0.06, 1.6), 160, 100), 32);
    const { image, castB } = degptImage(sticker.image, 7);
    expect(castB).toBeGreaterThan(0);
    const report = validateSymbol(image, 32);
    expect(report.ok, report.problems.join(' / ')).toBe(true);
  });
});

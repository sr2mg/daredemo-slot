// three.js リール描画（reel-gl.ts）の純関数部分: 円筒の幾何と図柄アトラスの配置。
// WebGL 本体はブラウザスモークで見るので、ここでは「どの面が正面に来るか」と
// 「頂点データがコマ数と整合するか」だけを固定する。
import { describe, expect, it } from 'vitest';
import {
  atlasCellUv,
  atlasLayout,
  buildDrumGeometryData,
  cameraFovDeg,
  drumApothem,
  drumRadius,
  drumRotation,
  faceAngleAfterRotation,
  lampPosition,
  lampPowerForUnitExposure,
  symbolTransmission,
  CAMERA_DISTANCE,
  LAMP_DEPTH,
  VISIBLE_ROWS,
} from '../src/ui/reel-gl.js';

describe('円筒の幾何', () => {
  it('コマ位置 p で正面は p+1 の面、上段は p+2、下段は p（下流れ）', () => {
    for (const frames of [20, 21]) {
      for (const p of [0, 7, frames - 1]) {
        expect(faceAngleAfterRotation(p + 1, p, frames)).toBeCloseTo(0, 9);
        expect(faceAngleAfterRotation((p + 2) % frames, p, frames)).toBeGreaterThan(0);
        expect(faceAngleAfterRotation(p, p, frames)).toBeLessThan(0);
      }
    }
  });

  it('コマ位置が 1 進むと回転は 1 面分進み、1 周で 2π', () => {
    const frames = 20;
    expect(drumRotation(1, frames) - drumRotation(0, frames)).toBeCloseTo((2 * Math.PI) / frames, 12);
    expect(drumRotation(frames, frames) - drumRotation(0, frames)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('正 n 角柱の辺長は 1 コマ、内接半径は CSS 版の translateZ 係数と同じ', () => {
    const frames = 21;
    const R = drumRadius(frames);
    expect(2 * R * Math.sin(Math.PI / frames)).toBeCloseTo(1, 12);
    expect(drumApothem(frames)).toBeCloseTo(1 / (2 * Math.tan(Math.PI / frames)), 12);
  });

  it('頂点データは面ごとに 4 頂点・2 三角形で、各面の弦長が 1、法線が単位長', () => {
    const frames = 20;
    const data = buildDrumGeometryData(
      frames,
      () => ({ u0: 0, u1: 1, v0: 0, v1: 1 }),
      () => 0.25,
    );
    expect(data.positions.length).toBe(frames * 4 * 3);
    expect(data.indices.length).toBe(frames * 6);
    expect(data.transmission.every((t) => t === 0.25)).toBe(true);
    for (let i = 0; i < frames; i++) {
      const base = i * 4 * 3;
      const yLo = data.positions[base + 1]!;
      const zLo = data.positions[base + 2]!;
      const yHi = data.positions[base + 3 * 3 + 1]!;
      const zHi = data.positions[base + 3 * 3 + 2]!;
      expect(Math.hypot(yHi - yLo, zHi - zLo)).toBeCloseTo(1, 5);
      const ny = data.normals[base + 1]!;
      const nz = data.normals[base + 2]!;
      expect(Math.hypot(ny, nz)).toBeCloseTo(1, 5);
    }
    // 面 0 は正面（z 最大）、面 1 はその上
    expect(data.normals[2]).toBeCloseTo(1, 5);
    expect(data.positions[4 * 3 + 1]).toBeGreaterThan(0.4);
  });

  it('カメラは窓の中心平面に 3 段がちょうど収まる視野角', () => {
    const half = Math.tan((cameraFovDeg() / 2) * (Math.PI / 180)) * CAMERA_DISTANCE;
    expect(half * 2).toBeCloseTo(VISIBLE_ROWS, 9);
  });
});

describe('バックライト', () => {
  it('3 灯は帯の内側（内接半径より奥）で、上・中・下の順に高い', () => {
    const frames = 20;
    const [top, middle, bottom] = [0, 1, 2].map((row) => lampPosition(row, frames));
    expect(top!.y).toBeGreaterThan(middle!.y);
    expect(middle!.y).toBeCloseTo(0, 12);
    expect(bottom!.y).toBeLessThan(middle!.y);
    expect(middle!.z).toBeCloseTo(drumApothem(frames) - LAMP_DEPTH, 12);
    expect(middle!.z).toBeLessThan(drumApothem(frames));
  });

  it('段の中心・正対で露光が 1 になる強度', () => {
    const d2 = LAMP_DEPTH * LAMP_DEPTH;
    expect(lampPowerForUnitExposure() / (1 + d2 / 1)).toBeCloseTo(1, 12);
  });

  it('図柄の透光性: ブランクは透けず、未知の図柄は既定値', () => {
    expect(symbolTransmission('blank')).toBe(0);
    expect(symbolTransmission('seven_red')).toBeGreaterThan(symbolTransmission('replay'));
    expect(symbolTransmission('unknown_symbol')).toBe(symbolTransmission('replay'));
  });
});

describe('図柄アトラス', () => {
  it('セルは 2 列に並び、UV 矩形が重ならず [0,1] に収まる', () => {
    const layout = atlasLayout(7);
    expect(layout.cols).toBe(2);
    expect(layout.rows).toBe(4);
    const rects = Array.from({ length: 7 }, (_, i) => atlasCellUv(i, layout));
    for (const r of rects) {
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1);
      expect(r.v0).toBeGreaterThanOrEqual(0);
      expect(r.v1).toBeLessThanOrEqual(1);
      expect(r.u1).toBeGreaterThan(r.u0);
      expect(r.v1).toBeGreaterThan(r.v0);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap = a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;
        expect(overlap).toBe(false);
      }
    }
    // 行 0 がキャンバス上端 = v が最大
    expect(rects[0]!.v1).toBe(1);
  });

  it('図柄 1 種でも 1 セル以上のキャンバスになる', () => {
    const layout = atlasLayout(1);
    expect(layout.cols).toBe(1);
    expect(layout.rows).toBe(1);
  });
});

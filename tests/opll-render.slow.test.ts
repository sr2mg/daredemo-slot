import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { PRESET_SONGS } from '../src/ui/bgm-library.js';
import { arrangePiece } from '../src/ui/opll-arrange.js';
import type { OpllExports } from '../src/ui/opll-core.js';
import { OPLL_CLOCK, OPLL_IMPORTS, OPLL_RATE, renderSequence } from '../src/ui/opll-core.js';

/**
 * プリセット BGM の実レンダリング検証（slow 層）。
 * OPLL レンダリングは実時間近くかかるため、波形の健全性チェックは先頭 2 秒だけ行う。
 * ループ長の検算はレジスタ列のメタ（duration とイベント時刻）で済ませ、レンダリングしない。
 */

const wasmBytes = readFileSync(new URL('../src/ui/emu2413.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, OPLL_IMPORTS);
const exports = instance.exports as unknown as OpllExports;
const opll = exports.OPLL_new(OPLL_CLOCK, OPLL_RATE);

describe('プリセット BGM（作曲エンジン + OPLL 編曲）', () => {
  for (const preset of PRESET_SONGS) {
    it(`${preset.name}: ループ長が拍数どおりで、先頭 2 秒が鳴る波形になる`, { timeout: 60_000 }, () => {
      const piece = compose(preset.options);
      const def = arrangePiece(piece, preset.options.styleId);
      // ループ長の検算（レンダリング不要）
      expect(def.duration).toBeCloseTo(piece.beats * (60 / preset.options.bpm), 6);
      for (const e of def.events) expect(e.at).toBeLessThanOrEqual(def.duration);
      // 先頭 2 秒だけ実レンダリングして健全性を見る
      const head = renderSequence(exports, opll, { duration: 2, events: def.events });
      expect(head.length).toBe(Math.round(2 * OPLL_RATE));
      let peak = 0;
      let energy = 0;
      for (const v of head) {
        expect(Number.isNaN(v)).toBe(false);
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        energy += abs;
      }
      expect(peak).toBeCloseTo(0.65, 2); // 正規化ピーク
      expect(energy / head.length).toBeGreaterThan(0.01); // 無音でない
    });
  }
});

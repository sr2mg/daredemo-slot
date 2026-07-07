import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import pngjs from 'pngjs';
import { degptImage, validateSymbol } from '../src/tools/symbol-pipeline.js';
import type { Rgba } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * 脱 GPT 後処理 CLI: 採用済みアセット（図柄 + 筐体パネル）に
 * WB 中和 → 彩度調整 → 印刷テクスチャ → 再量子化 を一括適用して上書きする。
 * 元画像は git 履歴にあるので、気に入らなければ revert で戻せる。
 *
 * 使い方: npm run degpt
 * オプション: --dry 1（書き込まず補正量だけ表示） --sat <係数> --grain <n> --dot <n>
 * 根拠となった調査（GPT っぽさの統計的痕跡）は docs/asset-prompts.md を参照。
 */

const SYMBOLS_DIR = 'src/ui/assets/symbols';
const PANEL_PATH = 'src/ui/assets/panel.png';

/** ファイル名 → シード（FNV-1a 32bit）。同じファイルは常に同じテクスチャになる */
function seedOf(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function readPng(path: string): Rgba {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function writePng(path: string, img: Rgba): void {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  writeFileSync(path, PNG.sync.write(png));
}

const opt = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]!.startsWith('--') || argv[i + 1] === undefined) throw new Error(`引数が不正: ${argv[i]}`);
  opt.set(argv[i]!.slice(2), argv[i + 1]!);
}
const dry = opt.get('dry') === '1';
const saturation = Number(opt.get('sat') ?? 0.92);
const grain = Number(opt.get('grain') ?? 5);
const dot = Number(opt.get('dot') ?? 7);

const symbolFiles = readdirSync(SYMBOLS_DIR).filter((f) => f.endsWith('.png'));
let failed = 0;
for (const file of symbolFiles) {
  const path = join(SYMBOLS_DIR, file);
  const src = readPng(path);
  const { image, castA, castB } = degptImage(src, seedOf(file), { saturation, grain, dot, maxColors: 32 });
  const report = validateSymbol(image, 32);
  if (!dry) writePng(path, image);
  const status = report.ok ? 'OK' : `NG: ${report.problems.join(' / ')}`;
  console.log(
    `${basename(file, '.png').padEnd(12)} 色被り補正 a=${castA.toFixed(1).padStart(5)} b=${castB.toFixed(1).padStart(5)} ` +
      `→ ${String(report.colors).padStart(2)}色 [${status}]${dry ? '（dry run）' : ''}`,
  );
  if (!report.ok) failed++;
}

// 筐体パネル: 1 枚絵なので量子化はしない（様式検証の対象外）。
// ランダム紙目は PNG 圧縮を殺してサイズが跳ねる（339KB→456KB 実測）ので、
// パネルは WB + 彩度 + 周期的な網点（圧縮が効く）だけにする
const panel = readPng(PANEL_PATH);
const { image: panelOut, castA, castB } = degptImage(panel, seedOf('panel.png'), {
  saturation,
  grain: 0,
  dot: Math.min(dot, 4),
  maxColors: 0,
});
if (!dry) writePng(PANEL_PATH, panelOut);
console.log(`panel        色被り補正 a=${castA.toFixed(1).padStart(5)} b=${castB.toFixed(1).padStart(5)}${dry ? '（dry run）' : ''}`);

if (failed > 0) {
  console.error(`\n${failed} 件が検証 NG`);
  process.exit(1);
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import pngjs from 'pngjs';
import { processSymbol, splitGrid } from '../src/tools/symbol-pipeline.js';
import type { Rgba } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * 図柄アセットの後処理 CLI。AI 生成画像（シート or 単体）を
 * 背景除去 → トリム → 縮小 → 16 色量子化して src/ui/assets/symbols/ に書き出す。
 *
 * 使い方（npm run symbols -- <args>）:
 *   シート:  npm run symbols -- sheet.png --grid 4x2 --names seven_red,bar,bell,replay,cherry,melon,blank
 *   単体:    npm run symbols -- one.png --name bell
 * オプション: --out <dir>（既定 src/ui/assets/symbols） --size <px>（既定 64）
 *             --colors <n>（既定 16） --tolerance <n>（背景除去の色距離。既定 90）
 * プロンプト仕様: docs/asset-prompts.md
 */

function parseArgs(argv: string[]): {
  input: string;
  grid?: { cols: number; rows: number };
  names: string[];
  out: string;
  size: number;
  colors: number;
  tolerance: number;
} {
  const [input, ...rest] = argv;
  if (!input) throw new Error('入力 PNG を指定してください（npm run symbols -- input.png ...）');
  const opt = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]!.startsWith('--') || rest[i + 1] === undefined) throw new Error(`引数が不正: ${rest[i]}`);
    opt.set(rest[i]!.slice(2), rest[i + 1]!);
  }
  const gridStr = opt.get('grid');
  const grid = gridStr
    ? { cols: Number(gridStr.split('x')[0]), rows: Number(gridStr.split('x')[1]) }
    : undefined;
  const names = (opt.get('names') ?? opt.get('name') ?? basename(input, '.png')).split(',');
  return {
    input,
    ...(grid ? { grid } : {}),
    names,
    out: opt.get('out') ?? 'src/ui/assets/symbols',
    size: Number(opt.get('size') ?? 64),
    colors: Number(opt.get('colors') ?? 16),
    tolerance: Number(opt.get('tolerance') ?? 90),
  };
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

const args = parseArgs(process.argv.slice(2));
const source = readPng(args.input);
const cells = args.grid ? splitGrid(source, args.grid.cols, args.grid.rows) : [source];
if (cells.length < args.names.length) {
  throw new Error(`セル数 ${cells.length} < 名前数 ${args.names.length}（--grid を確認）`);
}

mkdirSync(args.out, { recursive: true });
let failed = 0;
for (let i = 0; i < args.names.length; i++) {
  const name = args.names[i]!.trim();
  if (name === '' || name === '-') continue; // '-' = そのセルは捨てる
  const { image, report } = processSymbol(cells[i]!, {
    size: args.size,
    maxColors: args.colors,
    tolerance: args.tolerance,
  });
  const path = join(args.out, `${name}.png`);
  writePng(path, image);
  const status = report.ok ? 'OK' : `NG: ${report.problems.join(' / ')}`;
  console.log(
    `${name.padEnd(12)} ${report.size}px ${String(report.colors).padStart(2)}色 不透明${(report.opaqueRatio * 100).toFixed(0).padStart(3)}% → ${path} [${status}]`,
  );
  if (!report.ok) failed++;
}
if (failed > 0) {
  console.error(`\n${failed} 件が検証 NG（書き出しは済み。プロンプト再生成 or --tolerance 調整を検討）`);
  process.exit(1);
}

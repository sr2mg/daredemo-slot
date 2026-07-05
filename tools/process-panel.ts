import { readFileSync, statSync, writeFileSync } from 'node:fs';
import pngjs from 'pngjs';
import { resizeTo } from '../src/tools/symbol-pipeline.js';
import type { Rgba } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * 筐体パネル 1 枚絵の配置 CLI。生成画像をアスペクト維持で幅 1024px に縮小し、
 * src/ui/assets/panel.png に書き出す（リポジトリ肥大の抑制）。
 * 使い方: npm run panel -- input.png [--width 1024] [--out src/ui/assets/panel.png]
 */

const [input, ...rest] = process.argv.slice(2);
if (!input) throw new Error('入力 PNG を指定してください（npm run panel -- input.png）');
const opt = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) opt.set(rest[i]!.replace(/^--/, ''), rest[i + 1] ?? '');
const width = Number(opt.get('width') ?? 1024);
const out = opt.get('out') ?? 'src/ui/assets/panel.png';

const png = PNG.sync.read(readFileSync(input));
const src: Rgba = { width: png.width, height: png.height, data: new Uint8Array(png.data) };
const height = Math.round((png.height * width) / png.width);
const resized = resizeTo(src, width, height);
const outPng = new PNG({ width, height });
outPng.data = Buffer.from(resized.data);
writeFileSync(out, PNG.sync.write(outPng));
const kb = Math.round(statSync(out).size / 1024);
console.log(`${png.width}x${png.height} → ${width}x${height} ${kb}KB → ${out}${kb > 500 ? ' [注意: 500KB 超。--width を下げる]' : ''}`);

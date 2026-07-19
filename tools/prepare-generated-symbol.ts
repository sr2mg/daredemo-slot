import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pngjs from 'pngjs';
import { resizeTo } from '../src/tools/symbol-pipeline.js';
import type { Rgba } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * ImageGen で個別生成した高解像対象を、アスペクト比を変えずに
 * リール用の透明 640x400 キャンバスへ配置する。色とアルファは量子化しない。
 */

interface Options {
  input: string;
  output: string;
  canvasWidth: number;
  canvasHeight: number;
  widthUse: number;
  heightUse: number;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`引数が不正: ${key ?? ''}`);
    values.set(key.slice(2), value);
  }
  const input = values.get('input');
  const output = values.get('output');
  if (!input || !output) throw new Error('--input と --output は必須です');
  return {
    input,
    output,
    canvasWidth: Number(values.get('canvas-width') ?? 640),
    canvasHeight: Number(values.get('canvas-height') ?? 400),
    widthUse: Number(values.get('width-use') ?? 0.9),
    heightUse: Number(values.get('height-use') ?? 0.88),
  };
}

function readPng(path: string): Rgba {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

function cropAlpha(img: Rgba, threshold = 8): Rgba {
  let left = img.width;
  let top = img.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! < threshold) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('不透明画素がありません');
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceStart = ((top + y) * img.width + left) * 4;
    data.set(img.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
  }
  return { width, height, data };
}

function placeOnCanvas(subject: Rgba, opts: Options): Rgba {
  const maxWidth = Math.round(opts.canvasWidth * opts.widthUse);
  const maxHeight = Math.round(opts.canvasHeight * opts.heightUse);
  const scale = Math.min(maxWidth / subject.width, maxHeight / subject.height);
  const width = Math.max(1, Math.round(subject.width * scale));
  const height = Math.max(1, Math.round(subject.height * scale));
  const resized = resizeTo(subject, width, height);
  const output: Rgba = {
    width: opts.canvasWidth,
    height: opts.canvasHeight,
    data: new Uint8Array(opts.canvasWidth * opts.canvasHeight * 4),
  };
  const offsetX = Math.floor((opts.canvasWidth - width) / 2);
  const offsetY = Math.floor((opts.canvasHeight - height) / 2);
  for (let y = 0; y < height; y++) {
    const sourceStart = y * width * 4;
    const targetStart = ((offsetY + y) * opts.canvasWidth + offsetX) * 4;
    output.data.set(resized.data.subarray(sourceStart, sourceStart + width * 4), targetStart);
  }
  return output;
}

function writePng(path: string, img: Rgba): void {
  mkdirSync(dirname(path), { recursive: true });
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  writeFileSync(path, PNG.sync.write(png));
}

const opts = parseArgs(process.argv.slice(2));
const source = cropAlpha(readPng(opts.input));
const output = placeOnCanvas(source, opts);
writePng(opts.output, output);
console.log(
  `${opts.input} (${source.width}x${source.height}) -> ${opts.output} ` +
    `(${output.width}x${output.height}, width ${Math.round(opts.widthUse * 100)}%, height max ${Math.round(opts.heightUse * 100)}%)`,
);

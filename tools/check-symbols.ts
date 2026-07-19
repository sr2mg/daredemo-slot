import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { validateSymbol } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * 図柄アセットの一括検証 CLI（npm run symbols:check）。
 * src/ui/assets/symbols/ の全 PNG に透過率・キャンバス比の制約を掛けて報告する。
 * 2026 年版は滑らかな階調と半透明エッジを保つため、色数は制限しない。
 * パイプラインを通さず手置きされたアセットの検出用。NG があれば exit 1
 */

const dir = process.argv[2] ?? 'src/ui/assets/symbols';
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
  const png = PNG.sync.read(readFileSync(join(dir, file)));
  const report = validateSymbol(
    { width: png.width, height: png.height, data: new Uint8Array(png.data) },
    Number.POSITIVE_INFINITY,
  );
  const status = report.ok ? 'OK' : `NG: ${report.problems.join(' / ')}`;
  console.log(
    `${file.padEnd(44)} ${png.width}x${png.height} ${String(report.colors).padStart(2)}色 不透明${(report.opaqueRatio * 100).toFixed(0).padStart(3)}% [${status}]`,
  );
  if (!report.ok) failed++;
}
if (failed > 0) process.exit(1);

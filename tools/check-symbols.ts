import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pngjs from 'pngjs';
import { validateSymbol } from '../src/tools/symbol-pipeline.js';

const { PNG } = pngjs;

/**
 * 図柄アセットの一括検証 CLI（npm run symbols:check）。
 * src/ui/assets/symbols/ の全 PNG に様式制約（32 色・不透明率・横長）を掛けて報告する。
 * パイプラインを通さず手置きされたアセットの検出用。NG があれば exit 1
 */

const dir = process.argv[2] ?? 'src/ui/assets/symbols';
let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
  const png = PNG.sync.read(readFileSync(join(dir, file)));
  const report = validateSymbol({ width: png.width, height: png.height, data: new Uint8Array(png.data) });
  const status = report.ok ? 'OK' : `NG: ${report.problems.join(' / ')}`;
  console.log(
    `${file.padEnd(44)} ${png.width}x${png.height} ${String(report.colors).padStart(2)}色 不透明${(report.opaqueRatio * 100).toFixed(0).padStart(3)}% [${status}]`,
  );
  if (!report.ok) failed++;
}
if (failed > 0) process.exit(1);

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * テストは 2 層:
 * - `npm test`         = fast 層のみ（*.slow.test.ts を除外。数秒で回る開発ループ用）
 * - `npm run test:all` = slow 層込みのフル実行（--mode all。試射シミュレーションや
 *   OPLL 実レンダリングなどの重い統合テスト。CI やプッシュ前用）
 * .claude/ 配下（worktree のコピー）は常に除外する。
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: { port: Number(process.env['PORT']) || 5173 },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      ...(mode === 'all' ? [] : ['**/*.slow.test.ts']),
    ],
    // slow 層は数十秒級のシミュレーションを含むためタイムアウトを緩める
    testTimeout: mode === 'all' ? 120_000 : 5_000,
  },
}));

/**
 * 図柄・筐体アセットのマニフェスト。
 * src/ui/assets/symbols/<図柄ID>.png を置くとビルドに取り込まれ、リールが
 * 絵文字からドット絵に切り替わる（無い図柄は絵文字フォールバック）。
 * 新規アセットは AI 生成 + クロマキー除去後、
 * tools/prepare-generated-symbol.ts で640x400の透明キャンバスへ整形する。
 * 旧スプライトシート用パイプラインは tools/process-symbols.ts。
 * 生成プロンプト仕様: docs/asset-prompts.md
 */

const symbolFiles = import.meta.glob('./assets/symbols/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** 図柄ID → 画像 URL（例: seven_red → …/seven_red.png） */
export const SYMBOL_IMAGES: Record<string, string> = {};
for (const [path, url] of Object.entries(symbolFiles)) {
  SYMBOL_IMAGES[path.split('/').pop()!.replace(/\.png$/, '')] = url;
}

const panelFiles = import.meta.glob('./assets/panel.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** 筐体上部のパネル 1 枚絵（任意。置けば筐体に表示される） */
export const PANEL_IMAGE: string | null = Object.values(panelFiles)[0] ?? null;

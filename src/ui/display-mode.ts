export interface BrowserViewport {
  /** Chrome がレイアウトへ渡している CSS pixel 単位の表示領域 */
  width: number;
  height: number;
  /** CSS pixel から実ピクセルへの倍率 */
  devicePixelRatio: number;
}

export interface LargeDisplayMetrics {
  cellHeight: number;
  reelWidth: number;
  panelWidth: number;
  appWidth: number;
  scale: number;
  physicalWidth: number;
  physicalHeight: number;
}

const finitePositive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * 大画面モードの実寸を表示領域から求める。
 *
 * CSS transform で完成済みの画面を引き伸ばすのではなく、この値をリールや画像の
 * レイアウト寸法として使う。ブラウザが最終サイズで再描画するため、文字・境界線・
 * CSS の陰影はモニターの devicePixelRatio に応じた解像度を保てる。
 */
export function calculateLargeDisplayMetrics(viewport: BrowserViewport): LargeDisplayMetrics {
  const width = finitePositive(viewport.width, 980);
  const height = finitePositive(viewport.height, 900);
  const devicePixelRatio = finitePositive(viewport.devicePixelRatio, 1);

  // 高さ側には機種選択、パネル、操作ボタン、カウンター分として 780px を確保。
  // 横側は 3 リール（幅:高さ = 19:12）と筐体左右の余白を確保する。
  const cellFromHeight = (height - 780) / 3;
  const cellFromWidth = (width - 160) / (3 * (19 / 12));
  const minimumCellHeight = width < 760 ? 40 : 120;
  const cellHeight = Math.round(clamp(Math.min(cellFromHeight, cellFromWidth), minimumCellHeight, 240));
  const reelWidth = Math.round(cellHeight * (19 / 12));
  // 元パネルは 560px 幅。大画面でも過剰に拡大せず、リールの存在感を主役にする。
  const panelWidth = Math.round(clamp(cellHeight * 3.1, 560, 700));
  // アプリ、筐体、リール枠それぞれの左右 padding まで含めて外枠を確保する。
  const appWidth = Math.round(reelWidth * 3 + 240);

  return {
    cellHeight,
    reelWidth,
    panelWidth,
    appWidth,
    scale: cellHeight / 120,
    physicalWidth: Math.round(width * devicePixelRatio),
    physicalHeight: Math.round(height * devicePixelRatio),
  };
}

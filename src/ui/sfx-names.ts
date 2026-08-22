/**
 * スロット側の効果音契機の語彙。
 *
 * これはゲーム（スロット）のドメイン語彙であって音源エンジンのものではないため、
 * アプリ層（ui/）が所有する。エンジン側（audio/opll-core.ts 等）へ置くと、
 * エンジンを切り出したときにスロットの語彙を持ち出してしまう
 * （progression-usage.ts と同じ「スロット語彙を core/audio に置かない」原則）。
 */
export type SfxName =
  | 'bet'
  | 'lever'
  | 'betLever'
  | 'reelStop'
  | 'replay'
  | 'payout'
  | 'kyuin'
  | 'fanfare'
  | 'siren'
  | 'rush';

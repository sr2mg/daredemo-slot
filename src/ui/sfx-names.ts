/**
 * スロット側の効果音契機の語彙。
 *
 * これはゲーム（スロット）のドメイン語彙であって音源エンジンのものではないため、
 * アプリ層（ui/）が所有する。エンジン側（audio/opll-core.ts 等）へ置くと、
 * エンジンを切り出したときにスロットの語彙を持ち出してしまう
 * （progression-usage.ts と同じ「スロット語彙を core/audio に置かない」原則）。
 *
 * 契機は「強度 × 頻度」で層をなす（sfx-library.ts の SFX_TRIGGERS が正本）:
 * - 操作（毎ゲーム・目立たせない）: bet / lever / betLever / reelStop / wait / error / nav*
 * - 獲得（数ゲームに 1 回）: replay / payoutLow / payout / payoutBonus
 * - 予告（中間信頼度）: yokokuWeak / yokokuMid / yokokuStrong
 * - 告知・確定（最大強度）: kyuin / fanfare / siren / rush
 */
export type SfxName =
  | 'bet'
  | 'lever'
  | 'betLever'
  | 'reelStop'
  | 'wait'
  | 'error'
  | 'navLeft'
  | 'navCenter'
  | 'navRight'
  | 'replay'
  | 'payoutLow'
  | 'payout'
  | 'payoutBonus'
  | 'yokokuWeak'
  | 'yokokuMid'
  | 'yokokuStrong'
  | 'kyuin'
  | 'fanfare'
  | 'siren'
  | 'rush';

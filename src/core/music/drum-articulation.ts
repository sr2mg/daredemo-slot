/**
 * ドラムのアーティキュレーション導出(オープンハット・拍節アクセント)。
 *
 * スタイル表(theory.ts)は発音位置だけを持ち、「どう鳴らすか」はここで譜面から導出する。
 * 位置ごとの列挙はしない(theory-derivedの原則)。チップ5音ドラム(OPLL/NES)は
 * 付与フィールドを単に無視して従来通り鳴る=品位よく劣化(sound-capabilities.ts)。
 *
 * 導出則:
 * - オープンハット: 「次のハットまで鳴り残す余地」がある裏拍だけ開く。
 *   刻み(8分=0.5拍間隔、シャッフルの長辺=2/3拍)は閉じたまま、付点8分(0.75拍、
 *   スカの裏2連の後ろ)〜裏打ち(1拍)だけ開く。1拍を超える間隙は編曲上の余白
 *   (ターンアラウンド/ブレイク)なので開けて埋めない。表拍(拍頭)は次の刻みの
 *   起点なので開かない(交互C-O型のディスコ刻みは未導出。必要になったら
 *   スタイル表側に宣言を足すこと)。
 * - 拍節アクセント: クローズハットの刻みに拍節階層(小節頭>拍頭>8分裏>16分・三連中間)の
 *   強弱を付ける。オープンは持続で目立つ別アーティキュレーションなので減衰しない。
 *   キック/スネアはバックビートの骨格なので一定のまま。
 */
import { gridFor } from './grid.js';
import type { GridDef } from './grid.js';
import type { DrumEvent } from './types.js';

const EPS = 1e-3;

/**
 * 拍節深度1段ごとのベロシティ比。SF2のゲインはベロシティ二乗比例(sf2.ts)なので
 * 1段 ≈ -1.7dB、最深(16分)で約-5dB。生演奏のアクセント/ノンアクセント比
 * (おおむねゲイン2:1以内)に収まる単一定数から導く。
 */
const ACCENT_RATIO = 0.82;

/**
 * ゴーストノート(スタイル譜が0..1の中間値で書く弱打)の標準強度。
 * 拍節アクセントの全階層幅(小節頭→16分 = ACCENT_RATIO^3)のさらに1周下
 * = ACCENT_RATIO^6 ≈ 0.30。ゲイン(ベロシティ二乗)で約-10dBとなり、
 * 生演奏のゴーストスネア(主打への相対で概ね-10dB以下)の上端に当たる。
 * ベロシティを持たないチップドラムは主打と同じ音で鳴る(=劣化だが破綻しない)。
 */
export const DRUM_GHOST = ACCENT_RATIO ** 6;

/**
 * オープン化する間隙の下限と上限。実例の範囲=付点8分(0.75拍、スカ裏2連の後ろ)〜
 * 裏打ち(1拍)。それを超える間隙はターンアラウンド等が意図した余白なので開けて埋めない。
 */
const OPEN_MIN_GAP = 0.75 - EPS;
const OPEN_MAX_GAP = 1 + EPS;

/**
 * 拍節深度: 0=小節頭 / 1=拍頭 / 2=ステップ(8分裏。×3 の格子では 3 連の中・後ろ) / 3=細かい格子。
 * 格子に乗らない打点(bounce の 2/3、三連オーバーレイの 1/3)は従来どおり 2/3 を深さ 2、他を 3 にする。
 */
function metricDepth(beat: number, grid: GridDef): number {
  const inBar = ((beat % 4) + 4) % 4;
  const fine = (inBar * grid.sixteenthSteps) / 4;
  const index = Math.round(fine);
  if (Math.abs(fine - index) < EPS * grid.sixteenthSteps) {
    const wrapped = index % grid.sixteenthSteps;
    if (wrapped === 0) return 0;
    if (wrapped % (grid.sixteenthSteps / grid.pulses) === 0) return 1;
    return wrapped % 2 === 0 ? 2 : 3;
  }
  const inBeat = beat - Math.floor(beat);
  return Math.abs(inBeat - 2 / 3) < EPS ? 2 : 3;
}

/**
 * ハットへ open / velocity を付与した新しい配列を返す。他の音色はそのまま。
 * ループ末尾のハットの間隙は先頭(loopStartBeat)へ巻き戻して測る。
 * イントロ(loopStartBeatより前)は一度きりなのでそのまま本編へ流れ込む間隙で測る。
 */
export function applyDrumArticulation(
  drums: readonly DrumEvent[],
  loopStartBeat: number,
  endBeat: number,
  gridAtBeat: (beat: number) => GridDef = () => gridFor('4x2'),
): DrumEvent[] {
  const hatBeats = drums
    .filter((drum) => drum.inst === 'hat')
    .map((drum) => drum.beat)
    .sort((a, b) => a - b);
  const firstBodyHat = hatBeats.find((beat) => beat >= loopStartBeat - EPS);

  const gapAfter = (beat: number): number => {
    const next = hatBeats.find((candidate) => candidate > beat + EPS);
    if (next !== undefined) return next - beat;
    // 最後のハット: 本編ならループで巻き戻った先頭のハットまで、イントロだけなら無限大。
    if (firstBodyHat !== undefined && beat >= loopStartBeat - EPS) {
      return endBeat - beat + (firstBodyHat - loopStartBeat);
    }
    return Number.POSITIVE_INFINITY;
  };

  return drums.map((drum) => {
    if (drum.inst !== 'hat') return drum;
    const depth = metricDepth(drum.beat, gridAtBeat(drum.beat));
    const gap = gapAfter(drum.beat);
    const open = depth >= 2 && gap >= OPEN_MIN_GAP && gap <= OPEN_MAX_GAP;
    if (open) return { ...drum, open: true };
    // スタイル譜由来のゴースト強度(drum.velocity)があれば、拍節アクセントは乗算で重ねる。
    return { ...drum, velocity: (drum.velocity ?? 1) * ACCENT_RATIO ** depth };
  });
}

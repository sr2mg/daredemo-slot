/**
 * ベースライン生成器 — 和声計画の各コードイベントへ「ベースが弾く度数」を割り当てる。
 *
 * 分数コード(転回・半音経過)でベースをラインとして順次進行させる装置。参照様式の
 * 実測(スラッシュコード多用系: ほぼ全コードが分数コードで、ベースはルート跳躍より
 * 順次のラインを優先する)を、実音列の列挙ではなく選好コストとして定義し、
 * 最小コスト経路(Viterbi DP)から毎回導出する(理論導出の家内規約)。
 *
 * 書き先は HarmonyBarPlan.bassDegrees(キー主音からの相対半音)。ルートポジションは
 * null / 小節ごと省略とし、装置offや従来曲と同じ表現に退化する。
 */

import { CHORDS } from './theory.js';
import type { BassLinePolicy, CadenceType } from './types.js';


/** 生成器が読む最小限の和声計画。テストが小さな断片で駆動できるよう構造的に絞る。 */
export interface BassPlanBar {
  tokens: readonly string[];
  durations: readonly number[];
  cadence: CadenceType | null;
}

interface BassEvent {
  bar: number;
  index: number;
  token: string;
  dur: number;
  /** 曲頭と終止(closed/turnaround)末尾はルートで受ける(終止検査・接近装置と整合)。 */
  locked: boolean;
}

interface Candidate {
  degree: number;
  /** 0=ルート / 1=転回(第3・5音) / 2=半音経過(コードトーン外)。同点時は小さい方を優先。 */
  penalty: number;
}

/** 円環ピッチクラス距離(0..6)。 */
function circularDistance(a: number, b: number): number {
  const d = Math.abs((((a - b) % 12) + 12) % 12);
  return Math.min(d, 12 - d);
}

/**
 * 隣接イベント間の移動コスト(添字=円環距離)。順次(1..2半音)を最良、3度をその次、
 * 4度以上の跳躍を最後に置く序列が「ルート跳躍よりラインの順次進行」という実測選好の
 * 写し。静止(距離0)は装置の目的(ラインの前進)に反するので半音経過の代価(2)より
 * 高い3に置き、同一和音の分割で経過ベースが選ばれる余地を作る。機能進行の完全4度
 * (距離5)は跳躍側だが自然なので、転回をひねり出すほどは罰しない。
 */
const MOTION_COST = [3, 0, 0, 2, 2, 3, 4] as const;

const INVERSION_PENALTY = 1;
const CHROMATIC_PENALTY = 2;

function rootOf(token: string): number {
  const def = CHORDS[token];
  if (!def) throw new Error(`未知のコード: ${token}`);
  return def.root;
}

/**
 * イベントのベース候補。コードトーンは根音・第3音・第5音まで(7th以上を低音域へ
 * 置くと濁り、実測の転回もこの3種+経過音で説明できる)。半音経過(コードトーン外)は
 * 「同じ根音の和音が続く短いイベント」に限り、次の根音への半音接近として許す
 * (m7 の分割後半でベースだけ半音下がって次の根音へ届く型)。
 */
function candidatesFor(
  event: BassEvent,
  previousRoot: number | null,
  nextRoot: number | null,
): Candidate[] {
  const def = CHORDS[event.token];
  if (!def) throw new Error(`未知のコード: ${event.token}`);
  if (event.locked) return [{ degree: def.root, penalty: 0 }];
  const candidates: Candidate[] = [];
  for (const degree of def.tones.slice(0, 3)) {
    if (candidates.some((candidate) => candidate.degree === degree)) continue;
    candidates.push({ degree, penalty: degree === def.root ? 0 : INVERSION_PENALTY });
  }
  if (previousRoot === def.root && nextRoot !== null && event.dur <= 2) {
    for (const neighbor of [(nextRoot + 1) % 12, (nextRoot + 11) % 12]) {
      if (def.tones.includes(neighbor)) continue;
      if (candidates.some((candidate) => candidate.degree === neighbor)) continue;
      candidates.push({ degree: neighbor, penalty: CHROMATIC_PENALTY });
    }
  }
  return candidates;
}

/**
 * 各小節の bassDegrees を返す。全イベントがルートポジションの小節は undefined
 * (=省略)で、tokens と同じ長さの配列ではルートを null と書く。
 * 曲頭のイベントはルート固定、末尾→先頭の接続もコストへ含める(BGMは循環)。
 */
export function bassDegreesFor(
  bars: readonly BassPlanBar[],
): (readonly (number | null)[] | undefined)[] {
  const events: BassEvent[] = [];
  bars.forEach((bar, barIndex) => {
    bar.tokens.forEach((token, index) => {
      events.push({
        bar: barIndex,
        index,
        token,
        dur: bar.durations[index] ?? 4,
        locked: (barIndex === 0 && index === 0)
          || (index === bar.tokens.length - 1
            && (bar.cadence === 'closed' || bar.cadence === 'turnaround')),
      });
    });
  });
  if (events.length === 0) return bars.map(() => undefined);

  const candidateSets = events.map((event, i) => candidatesFor(
    event,
    i > 0 ? rootOf(events[i - 1]!.token) : null,
    i + 1 < events.length ? rootOf(events[i + 1]!.token) : rootOf(events[0]!.token),
  ));

  // Viterbi: layer[i][k] = イベントiで候補kを選んだときの最小累積コスト。
  let layer = candidateSets[0]!.map((candidate) => candidate.penalty);
  const backRefs: number[][] = [];
  for (let i = 1; i < events.length; i++) {
    const previousLayer = layer;
    const previousCandidates = candidateSets[i - 1]!;
    const backRow: number[] = [];
    layer = candidateSets[i]!.map((candidate) => {
      let best = Infinity;
      let bestFrom = 0;
      previousLayer.forEach((cost, from) => {
        const total = cost
          + MOTION_COST[circularDistance(previousCandidates[from]!.degree, candidate.degree)]!
          + candidate.penalty;
        if (total < best) {
          best = total;
          bestFrom = from;
        }
      });
      backRow.push(bestFrom);
      return best;
    });
    backRefs.push(backRow);
  }

  // ループ閉包: 先頭はロック済み単一候補なので、末尾からの移動コストを足すだけでよい。
  const firstDegree = candidateSets[0]![0]!.degree;
  let bestEnd = 0;
  let bestCost = Infinity;
  layer.forEach((cost, k) => {
    const total = cost + (events.length > 1
      ? MOTION_COST[circularDistance(candidateSets.at(-1)![k]!.degree, firstDegree)]!
      : 0);
    if (total < bestCost) {
      bestCost = total;
      bestEnd = k;
    }
  });

  const chosen: number[] = new Array<number>(events.length);
  let cursor = bestEnd;
  for (let i = events.length - 1; i >= 0; i--) {
    chosen[i] = candidateSets[i]![cursor]!.degree;
    cursor = i > 0 ? backRefs[i - 1]![cursor]! : 0;
  }

  const result: ((number | null)[] | undefined)[] = bars.map(() => undefined);
  events.forEach((event, i) => {
    if (chosen[i] === rootOf(event.token)) return;
    const row = result[event.bar]
      ?? (result[event.bar] = bars[event.bar]!.tokens.map(() => null));
    row[event.index] = chosen[i]!;
  });
  return result;
}

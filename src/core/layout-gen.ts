import { Xoshiro128 } from './rng.js';
import type { LayoutReport } from './validate.js';
import { checkLayout, checkSpacing, PB1_MAX_GAP } from './validate.js';
import type { MachineDef, SymbolId } from './types.js';

/**
 * リール配列の自動生成（制約充足のランダム構成 + 総当たり検証のリトライ）。
 *
 * 「PB=1 役の図柄は最大間隔 5 コマ以内」という配置制約を満たす候補を構成し、
 * checkLayout（蹴飛ばし・取りこぼし・引き込み率の総当たり検証）に通るまで
 * 試行を繰り返す。図柄の個数（リールごとの multiset）は保存するので、
 * 生成後も役の確率感（引き込み率）はおおむね維持される。
 */

export interface GenerateOptions {
  seed?: number;
  /** checkLayout まで通す最大試行回数（既定 30。1 回 ≒ 0.2 秒） */
  maxAttempts?: number;
  /** リールごとの図柄個数を指定して生成（省略時は現在の配列の個数を維持） */
  counts?: readonly Record<SymbolId, number>[];
}

export interface GenerateResult {
  ok: boolean;
  strips?: SymbolId[][];
  /** ok 時: 採用した配列の検証レポート */
  report?: LayoutReport;
  attempts: number;
  error?: string;
}

/** リールの図柄個数を数える */
export function countSymbols(strip: readonly SymbolId[]): Record<SymbolId, number> {
  const counts: Record<SymbolId, number> = {};
  for (const s of strip) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

/** PB=1 に必要な最低個数（例: 20 コマなら 4 個） */
export function minCountForPb1(frames: number): number {
  return Math.ceil(frames / PB1_MAX_GAP);
}

/** リールごとに PB=1 配置が必要な図柄の集合（guaranteed 役の要求図柄） */
export function constrainedSymbols(machine: MachineDef): Set<SymbolId>[] {
  const sets = machine.strips.map(() => new Set<SymbolId>());
  for (const role of machine.roles) {
    if (role.pullIn !== 'guaranteed') continue;
    role.pattern.forEach((symbol, reel) => {
      if (symbol !== 'any' && reel < sets.length) sets[reel]!.add(symbol);
    });
  }
  return sets;
}

function shuffle<T>(arr: T[], rng: Xoshiro128): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * 1 リールぶんの候補配列を構成する（構造制約のみ。null = この乱数では構成失敗）。
 *
 * PB=1 制約は「循環するどの 5 コマ窓にもその図柄がある」と同値なので、
 * 左から順に「締め切り（前回出現 + 5 コマ）」を守るランダム順バックトラッキングで置く。
 * 個数が最小（コマ数/5）の図柄は等間隔しか解がないケースも、DFS が自然に見つける。
 * 循環境界は「初回出現は先頭 5 コマ以内」+ 完成時の wrap チェックで担保する。
 */
export function buildStrip(
  frames: number,
  counts: Record<SymbolId, number>,
  constrained: ReadonlySet<SymbolId>,
  rng: Xoshiro128,
): SymbolId[] | null {
  const symbols = [...constrained];
  const strip: (SymbolId | null)[] = Array.from({ length: frames }, () => null);
  const remaining = new Map(symbols.map((s) => [s, counts[s] ?? 0]));
  const first = new Map<SymbolId, number>();
  const last = new Map<SymbolId, number>();
  let constrainedTotal = symbols.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  let fillerRemaining = frames - constrainedTotal;
  if (fillerRemaining < 0) return null;

  let nodes = 0;
  const NODE_BUDGET = 100_000;
  // 未出現の図柄の締め切りは「先頭 5 コマ以内」（循環窓の十分条件）
  const deadlineOf = (s: SymbolId) => (last.has(s) ? last.get(s)! + PB1_MAX_GAP : PB1_MAX_GAP - 1);

  const dfs = (i: number): boolean => {
    if (nodes++ > NODE_BUDGET) return false;
    if (i === frames) {
      // 循環境界: 末尾の出現 → 先頭の出現の間隔も 5 コマ以内
      return symbols.every(
        (s) => (counts[s] ?? 0) === 0 || first.get(s)! + frames - last.get(s)! <= PB1_MAX_GAP,
      );
    }
    const due = symbols.filter((s) => remaining.get(s)! > 0 && deadlineOf(s) === i);
    if (due.length > 1) return false; // 同時に 2 図柄の締め切り → この枝は不成立

    let candidates: (SymbolId | null)[];
    if (due.length === 1) {
      candidates = [due[0]!];
    } else {
      candidates = symbols.filter((s) => remaining.get(s)! > 0);
      if (fillerRemaining > 0) candidates.push(null); // null = 非制約図柄のプレースホルダ
      shuffle(candidates, rng);
    }

    for (const c of candidates) {
      if (c === null) {
        fillerRemaining--;
        if (dfs(i + 1)) {
          strip[i] = null; // プレースホルダのまま
          return true;
        }
        fillerRemaining++;
        continue;
      }
      const prevFirst = first.has(c);
      const prevLast = last.get(c);
      remaining.set(c, remaining.get(c)! - 1);
      if (!prevFirst) first.set(c, i);
      last.set(c, i);
      constrainedTotal--;
      if (dfs(i + 1)) {
        strip[i] = c;
        return true;
      }
      constrainedTotal++;
      remaining.set(c, remaining.get(c)! + 1);
      if (!prevFirst) first.delete(c);
      if (prevLast === undefined) last.delete(c);
      else last.set(c, prevLast);
    }
    return false;
  };

  if (!dfs(0)) return null;

  // プレースホルダに残りの図柄をシャッフルして流し込む
  const rest: SymbolId[] = [];
  for (const [symbol, count] of Object.entries(counts)) {
    const already = strip.filter((s) => s === symbol).length;
    for (let i = 0; i < count - already; i++) rest.push(symbol);
  }
  shuffle(rest, rng);
  let cursor = 0;
  for (let i = 0; i < frames; i++) {
    if (strip[i] === null) strip[i] = rest[cursor++] ?? null;
  }
  if (strip.some((s) => s === null)) return null;
  return strip as SymbolId[];
}

/**
 * リール配列を自動生成する。
 * 図柄個数を保ったまま並びだけ作り直すので、「配列を手で並べる」工程を丸ごと省ける。
 */
export function generateStrips(machine: MachineDef, opts: GenerateOptions = {}): GenerateResult {
  const frames = machine.frames;
  const rng = new Xoshiro128((opts.seed ?? 1) >>> 0);
  const maxAttempts = opts.maxAttempts ?? 30;
  const counts = opts.counts ?? machine.strips.map((s) => countSymbols(s));
  const constrained = constrainedSymbols(machine);

  // 事前の実現可能性チェック: 個数不足はリトライしても直らないので具体的に報告する
  const minCount = minCountForPb1(frames);
  for (let reel = 0; reel < machine.strips.length; reel++) {
    const total = Object.values(counts[reel] ?? {}).reduce((a, b) => a + b, 0);
    if (total !== frames) {
      return { ok: false, attempts: 0, error: `リール${reel + 1} の図柄個数の合計が ${total} です（${frames} コマぶん必要）` };
    }
    for (const symbol of constrained[reel]!) {
      const k = counts[reel]?.[symbol] ?? 0;
      if (k < minCount) {
        return {
          ok: false,
          attempts: 0,
          error: `リール${reel + 1} の「${symbol}」が ${k} 個しかありません。PB=1（どこを押しても揃う）には ${minCount} 個以上必要です`,
        };
      }
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 構造構成 + 間隔チェックは安いので、総当たり検証 1 回ぶんの予算で何度でも引き直す
    let strips: SymbolId[][] | null = null;
    for (let t = 0; t < 50 && strips === null; t++) {
      const candidate: SymbolId[][] = [];
      let failed = false;
      for (let reel = 0; reel < machine.strips.length; reel++) {
        const strip = buildStrip(frames, counts[reel]!, constrained[reel]!, rng);
        if (!strip) {
          failed = true;
          break;
        }
        candidate.push(strip);
      }
      if (!failed && !checkSpacing({ ...machine, strips: candidate }).some((c) => !c.ok)) {
        strips = candidate;
      }
    }
    if (strips === null) continue;

    const report = checkLayout({ ...machine, strips });
    if (report.ok) return { ok: true, strips, report, attempts: attempt };
  }

  return {
    ok: false,
    attempts: maxAttempts,
    error: `${maxAttempts} 回試しましたが全制約を満たす配列が見つかりませんでした。図柄の個数（特に目押し役）を見直すか、もう一度試してください`,
  };
}

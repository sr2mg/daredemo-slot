import { Xoshiro128 } from '../rng.js';
import type { ComposeOptions } from './compose.js';
import { COMPOSITION_STRATEGIES } from './composition-strategy.js';
import type { CompositionStrategy } from './composition-strategy.js';

export type BlindCandidateId = 'X' | 'Y' | 'Z';

export interface BlindStudyCandidate {
  id: BlindCandidateId;
  strategy: CompositionStrategy;
  options: ComposeOptions;
}

export interface BlindStudyTrial {
  id: string;
  seed: number;
  /** 戦略を除いた共通オプション。票へ埋めて比較を後から再現できるようにする。 */
  baseOptions: ComposeOptions;
  candidates: readonly BlindStudyCandidate[];
}

export interface BlindStudyVote {
  trialId: string;
  selected: CompositionStrategy;
  createdAt: number;
  /** v2: 比較を完全に再現するための素材。v1の票には無い。 */
  baseOptions?: ComposeOptions;
  /** v2: 匿名候補X/Y/Zへ割り当てた戦略の順。 */
  candidateOrder?: readonly CompositionStrategy[];
}

const CANDIDATE_IDS: readonly BlindCandidateId[] = ['X', 'Y', 'Z'];

/** 同じ素材の3条件を、条件名から独立した決定論的な順番へ並べる。 */
export function createBlindStudyTrial(
  id: string,
  baseOptions: ComposeOptions,
  orderSeed: number,
): BlindStudyTrial {
  if (baseOptions.bars !== 40) throw new Error('ブラインド比較は40小節の設定で生成してください');
  const rng = new Xoshiro128(orderSeed >>> 0);
  const strategies = COMPOSITION_STRATEGIES.map((strategy) => strategy.id);
  for (let index = strategies.length - 1; index > 0; index--) {
    const swap = rng.nextInt(index + 1);
    [strategies[index], strategies[swap]] = [strategies[swap]!, strategies[index]!];
  }
  const { compositionStrategy: _dropped, ...commonOptions } = baseOptions;
  return {
    id,
    seed: baseOptions.seed,
    baseOptions: commonOptions,
    candidates: CANDIDATE_IDS.map((candidateId, index) => ({
      id: candidateId,
      strategy: strategies[index]!,
      options: { ...commonOptions, compositionStrategy: strategies[index]! },
    })),
  };
}

/**
 * 票を、比較を後から完全に再現できる素材（共通オプションと匿名化順）ごと作る。
 * 票は好みの教師データとして蓄積するため、localStorage が消えても曲を復元できる形にする。
 */
export function createBlindStudyVote(
  trial: BlindStudyTrial,
  selected: CompositionStrategy,
  createdAt: number,
): BlindStudyVote {
  return {
    trialId: trial.id,
    selected,
    createdAt,
    baseOptions: trial.baseOptions,
    candidateOrder: trial.candidates.map((candidate) => candidate.strategy),
  };
}

const STRATEGY_IDS = new Set<string>(COMPOSITION_STRATEGIES.map((strategy) => strategy.id));

/** v1（素材なし）とv2（素材つき）の両方を受け付ける票の形式検証。 */
export function isBlindStudyVote(value: unknown): value is BlindStudyVote {
  if (value === null || typeof value !== 'object') return false;
  const vote = value as Record<string, unknown>;
  if (typeof vote.trialId !== 'string' || typeof vote.createdAt !== 'number') return false;
  if (!STRATEGY_IDS.has(String(vote.selected))) return false;
  if (vote.baseOptions !== undefined) {
    if (vote.baseOptions === null || typeof vote.baseOptions !== 'object') return false;
    const options = vote.baseOptions as Record<string, unknown>;
    if (
      typeof options.progressionId !== 'string'
      || typeof options.styleId !== 'string'
      || typeof options.keyRoot !== 'number'
      || typeof options.bpm !== 'number'
      || typeof options.seed !== 'number'
      || options.bars !== 40
    ) return false;
  }
  if (vote.candidateOrder !== undefined) {
    if (!Array.isArray(vote.candidateOrder) || vote.candidateOrder.length !== CANDIDATE_IDS.length) return false;
    if (!vote.candidateOrder.every((strategy) => STRATEGY_IDS.has(String(strategy)))) return false;
  }
  return true;
}

export const BLIND_VOTES_EXPORT_FORMAT = 'daredemo-slot/blind-study-votes';

export interface BlindStudyVotesExport {
  format: typeof BLIND_VOTES_EXPORT_FORMAT;
  version: 2;
  exportedAt: number;
  votes: readonly BlindStudyVote[];
}

/** 票をファイル保全用のJSONへ。localStorage 消失に備えた唯一の恒久保存経路。 */
export function serializeBlindStudyVotes(
  votes: readonly BlindStudyVote[],
  exportedAt: number,
): string {
  const payload: BlindStudyVotesExport = {
    format: BLIND_VOTES_EXPORT_FORMAT,
    version: 2,
    exportedAt,
    votes,
  };
  return JSON.stringify(payload, null, 2);
}

/** エクスポート形式（v2）と生の票配列（v1バックアップ）の両方を読む。壊れていれば例外。 */
export function parseBlindStudyVotes(json: string): BlindStudyVote[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('票ファイルをJSONとして読めません');
  }
  let votes: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    votes = parsed;
  } else if (parsed !== null && typeof parsed === 'object') {
    const envelope = parsed as Record<string, unknown>;
    if (envelope.format === BLIND_VOTES_EXPORT_FORMAT && Array.isArray(envelope.votes)) {
      votes = envelope.votes;
    }
  }
  if (votes === null) throw new Error('ブラインド比較の票ファイルではありません');
  if (!votes.every(isBlindStudyVote)) throw new Error('票ファイルに壊れた項目があります');
  return votes;
}

const voteKey = (vote: BlindStudyVote): string =>
  `${vote.trialId}|${vote.createdAt}|${vote.selected}`;

/** 手元とインポートの票を統合する。同一票は再現素材つきの方を残し、時刻順へ並べる。 */
export function mergeBlindStudyVotes(
  existing: readonly BlindStudyVote[],
  imported: readonly BlindStudyVote[],
): BlindStudyVote[] {
  const merged = new Map<string, BlindStudyVote>();
  for (const vote of [...existing, ...imported]) {
    const key = voteKey(vote);
    const prior = merged.get(key);
    merged.set(key, !prior || vote.baseOptions ? vote : prior);
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function summarizeBlindStudyVotes(
  votes: readonly BlindStudyVote[],
): Record<CompositionStrategy, number> {
  const summary: Record<CompositionStrategy, number> = { current: 0, memoryArc: 0, premiseArc: 0 };
  for (const vote of votes) summary[vote.selected]++;
  return summary;
}

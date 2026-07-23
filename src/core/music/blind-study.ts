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
  candidates: readonly BlindStudyCandidate[];
}

export interface BlindStudyVote {
  trialId: string;
  selected: CompositionStrategy;
  createdAt: number;
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
  return {
    id,
    seed: baseOptions.seed,
    candidates: CANDIDATE_IDS.map((candidateId, index) => ({
      id: candidateId,
      strategy: strategies[index]!,
      options: { ...baseOptions, compositionStrategy: strategies[index]! },
    })),
  };
}

export function summarizeBlindStudyVotes(
  votes: readonly BlindStudyVote[],
): Record<CompositionStrategy, number> {
  const summary: Record<CompositionStrategy, number> = { current: 0, memoryArc: 0, premiseArc: 0 };
  for (const vote of votes) summary[vote.selected]++;
  return summary;
}

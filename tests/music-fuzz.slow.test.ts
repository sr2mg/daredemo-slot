import { describe, expect, it } from 'vitest';
import { auditPieceInvariants, profilePieces } from '../src/core/music/audit.js';
import { compose, diagnosePiece, validatePiece, variedChoiceFor } from '../src/core/music/compose.js';
import type { ComposeOptions, Piece } from '../src/core/music/compose.js';
import { STYLES, progressionsForTonality } from '../src/core/music/theory.js';

/**
 * 作曲エンジンの一括ファズ監査（聴かない層の回帰防止・CI用）。
 *
 * 全進行 × 2調性 × スタイル/戦略/シード回転の40小節コーパスで、
 * 1. 不変条件（クラッシュ・検証エラー・退化・声部交差など）ゼロ
 * 2. 診断警告の総数が予算内（増えたら生成と診断の乖離が広がったサイン）
 * 3. 表現レンジのプロファイルが不変（変えたときはスナップショット更新で明示）
 * を守る。新機能や警告削減の効果はプロファイルとバジェットの数値に現れる。
 */

const STRATEGIES = ['current', 'memoryArc', 'premiseArc'] as const;
const SEEDS = 12;

function buildCorpus(): { options: ComposeOptions; piece: Piece; where: string }[] {
  const corpus: { options: ComposeOptions; piece: Piece; where: string }[] = [];
  for (const tonality of ['major', 'minor'] as const) {
    for (const prog of progressionsForTonality(tonality)) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const options: ComposeOptions = {
          progressionId: prog.id,
          styleId: STYLES[seed % STYLES.length]!.id,
          keyRoot: (seed * 5) % 12,
          bpm: 150,
          bars: 40,
          tonality,
          seed: seed * 7919 + 1,
          choice: variedChoiceFor(prog, 40, seed * 7919 + 1),
          compositionStrategy: STRATEGIES[seed % STRATEGIES.length]!,
        };
        corpus.push({
          options,
          piece: compose(options),
          where: `${prog.id}/${options.styleId}/${options.compositionStrategy}/seed=${options.seed}`,
        });
      }
    }
  }
  return corpus;
}

const corpus = buildCorpus();

describe('作曲エンジンの一括ファズ監査', () => {
  it('コーパスは十分な規模を持つ', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(150);
  });

  it('全曲が検証エラーゼロ・不変条件違反ゼロ', () => {
    const failures: string[] = [];
    for (const { piece, where } of corpus) {
      for (const violation of validatePiece(piece)) {
        failures.push(`${where}: validate ${JSON.stringify(violation)}`);
      }
      for (const anomaly of auditPieceInvariants(piece)) {
        failures.push(`${where}: ${anomaly.kind} ${anomaly.detail}`);
      }
    }
    expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
  });

  it('診断エラーはゼロ、警告総数はカテゴリ別バジェット内', () => {
    const warningCounts = new Map<string, number>();
    const errors: string[] = [];
    for (const { piece, where } of corpus) {
      for (const issue of diagnosePiece(piece).issues) {
        if (issue.severity === 'error') {
          errors.push(`${where}: ${issue.category} ${issue.reason}`);
        } else {
          warningCounts.set(issue.category, (warningCounts.get(issue.category) ?? 0) + 1);
        }
      }
    }
    expect(errors, errors.slice(0, 10).join('\n')).toEqual([]);
    // 計測履歴: 2026-07初回 melody 423 / harmony 282 / counterpoint 36。
    // 同月の警告削減（非和声音の生成側解決・ペダル認識・五度品質追従）後: 71 / 22 / 47。
    // 予算は計測値+25%。恒常的に超えたら「生成と診断の乖離が広がった」ので原因を調べる
    // （予算を黙って上げない。下げられるときは下げる）。
    const budget: Record<string, number> = { melody: 90, harmony: 30, counterpoint: 60 };
    for (const [category, count] of warningCounts) {
      expect(count, `${category} 警告が予算超過`).toBeLessThanOrEqual(budget[category] ?? 0);
    }
  });

  it('表現レンジのプロファイルは意図なく変わらない', () => {
    expect(profilePieces(corpus.map(({ piece }) => piece))).toMatchSnapshot();
  });
});

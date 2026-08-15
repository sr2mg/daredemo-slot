import { describe, expect, it } from 'vitest';
import { compose, variedChoiceFor } from '../src/core/music/compose.js';
import type { ComposeOptions } from '../src/core/music/compose.js';
import { digestPiece } from '../src/core/music/piece-diff.js';
import { PROGRESSIONS } from '../src/core/music/theory.js';

/**
 * 音の回帰検出（シンボリック・スナップショット）。
 *
 * compose() は決定論的なので、聴こえる層（各パートのイベント列）のセクション別
 * ダイジェストが一致すれば「音は1音も変わっていない」ことを聴かずに保証できる。
 * リファクタでこのテストが落ちたら、それは意図しない音の変化。
 *
 * 意図して音を変えたときだけ、失敗差分で「どの区間のどのパートが動いたか」を確認し、
 * 変わった区間を試聴したうえで `npm test -- -u` でスナップショットを更新すること。
 */

const minorPedal = PROGRESSIONS.find((prog) => prog.id === 'minor-pedal')!;
const jttou = PROGRESSIONS.find((prog) => prog.id === 'jttou')!;

const CASES: readonly { name: string; options: ComposeOptions }[] = [
  {
    name: 'RB風4小節 / royal-pop / eurobeat',
    options: { progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 4, seed: 42 },
  },
  {
    name: 'BB風8小節 / 短調 / rock',
    options: {
      progressionId: 'minor-pedal', styleId: 'rock', keyRoot: 9, bpm: 150, bars: 8,
      tonality: 'minor', seed: 7, choice: variedChoiceFor(minorPedal, 8, 7),
    },
  },
  {
    name: 'ゲームBGM風16小節 / 和風五音 / バウンス',
    options: {
      progressionId: 'jttou', styleId: 'eurobeat', keyRoot: 5, bpm: 160, bars: 16,
      melodicLanguage: 'japanese', grooveFeel: 'bounce', seed: 3,
      choice: variedChoiceFor(jttou, 16, 3),
    },
  },
  {
    name: 'ゲームBGM風16小節 / 連符レイヤーauto',
    options: {
      progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, bars: 16,
      seed: 11, tupletOverlay: 'auto',
    },
  },
  {
    name: '韓国MMO風16小節 / vi軌道 / lush+rich',
    options: {
      progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
    },
  },
  ...(['current', 'memoryArc', 'premiseArc'] as const).map((strategy) => ({
    name: `BIG風40小節 / ${strategy}`,
    options: {
      progressionId: 'minor-pedal', styleId: 'eurobeat', keyRoot: 0, bpm: 150,
      bars: 40 as const, tonality: 'minor' as const, seed: 42,
      choice: variedChoiceFor(minorPedal, 40, 42), compositionStrategy: strategy,
    },
  })),
];

describe('作曲エンジンの音イベントは意図なく変わらない', () => {
  for (const { name, options } of CASES) {
    it(name, () => {
      expect(digestPiece(compose(options))).toMatchSnapshot();
    });
  }

  // 「豊かに書いて編曲層で劣化」の原則により、opllとpcmは作曲能力が同等で
  // Piece層の出力は一致する(差はopll-arrange/pcm-arrangeが持つ)。
  // compose内でpcm専用の生成分岐を意図して入れるときは、このテストを
  // 更新した上でpcm用のスナップショットケースをCASESへ追加すること。
  // 同様に、最初のengineRevゲート分岐を入れるときは
  // engineRev: CURRENT_ENGINE_REV のケースをCASESへ追加すること
  // (現状の全ケースはrev0経路しか踏まない)。
  it('Piece層はopllとpcmで同一(能力差は編曲層に住む)', () => {
    const base = {
      progressionId: 'relative-orbit', styleId: 'kmmo', keyRoot: 2, bpm: 100, bars: 16, seed: 8,
    } as const;
    expect(digestPiece(compose({ ...base, soundChip: 'pcm' })))
      .toEqual(digestPiece(compose({ ...base })));
  });
});

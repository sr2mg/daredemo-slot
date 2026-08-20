/**
 * 進行ID → スロット文脈の用途ラベル。
 *
 * 元は core の ProgressionDef.usage だったが、「スロット語彙を core/music に
 * 置かない」原則によりクライアント側の表引きへ追い出したもの。core 側は
 * 進行IDを恒久凍結して公開する(theory.ts の ProgressionDef.id 参照)。
 * 表に無いID(将来の進行生成器が供給するエントリ等)はラベル無しで表示する。
 */
export const PROGRESSION_USAGE: Record<string, string> = {
  'royal-pop': 'RB 向き',
  fanfare: '単発ジングル向き（末尾 I で着地）',
  'tanaka-manabe': 'BB 向き',
  komuro: 'BPM170 と相性◎',
  canon: 'BB(8小節) 専用',
  jttou: 'AT 中/通常時向き',
  'minor-pedal': '4号機BIG・ゲームボス向き',
  'minor-incantation': 'AT前兆・ミステリアス演出向き',
  'relative-orbit': '夜フィールド・ゲームBGM向き',
  'minor-drive': 'BIG・ゲームBGM向き',
};

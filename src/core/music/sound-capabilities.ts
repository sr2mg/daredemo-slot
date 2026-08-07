/**
 * 音源バックエンドの能力プロファイル。
 *
 * 作曲・診断・UIは「チップの名前」でなく「能力」で分岐する。従来は
 * `soundChip === 'nes2a03'` 型のアイデンティティ比較が6ファイル30箇所に散らばり、
 * バックエンド追加のたびに全箇所の再訪が必要だった。ここに能力を宣言として集約し、
 * 各分岐は該当フィールドを参照するだけにする。
 *
 * 注意: 各フィールドは「本リポジトリの編曲層がそのバックエンド向けに実装済みか」の
 * 宣言であって、ハードウェアの理論上の能力ではない。例: 2A03はハード的には
 * ピッチスライドが得意だが、NES編曲層が未実装なので glide: false。trueへ変えるのは
 * 対応する編曲層の実装を用意してから。
 *
 * 原則は「豊かに書いて、チップ側で品位よく劣化させる」:
 * - 能力が無いバックエンドでは装置を作曲段階で畳む(音が破綻しないことを保証)
 * - 劣化写像(GMドラム→チップ5音など)は各編曲層が実装し、ここに文書化する
 *
 * 系統B(実機NES: nes-prototype.ts + nes/)はPieceパイプラインの外にある別ミニ
 * エンジンであり、このカタログの対象外。参考として能力を並べるなら
 * 「8ステップ/小節・16小節・3ドラム・全装置なし」の最小プロファイルに相当する。
 */

export type SoundBackendId = 'opll' | 'nes2a03' | 'pcm';

export interface SoundCapabilities {
  id: SoundBackendId;
  label: string;
  /** 独立した分散和音(オスティナート)声部の予算があるか。連符レイヤーの前提でもある。 */
  independentArpeggio: boolean;
  /** 旋律のエコー複製(遅延ダブリング)を鳴らす余裕があるか。 */
  echoDoubling: boolean;
  /** 伴奏がカラートーン(テンション)を担っても和声の同一性を失わないか。 */
  colorTones: boolean;
  /** ハモリ(平行3度/6度)専用声部を持てるか。 */
  duetLayer: boolean;
  /** ピッチのスライド(ポルタメント)を表現できるか。 */
  glide: boolean;
  /** ステレオ出力。 */
  stereo: boolean;
  /** 伴奏の同時発音(和音をそのまま鳴らせるか。falseなら単音リフに要約)。 */
  backingPolyphony: boolean;
  /** ドラム語彙。chip5 = kick/snare/tom/cymbal/hat の5音(YM2413リズムモード由来)。 */
  drumVocabulary: 'chip5' | 'gm';
}

export const SOUND_CAPABILITIES: Record<SoundBackendId, SoundCapabilities> = {
  opll: {
    id: 'opll',
    label: 'OPLL (YM2413)',
    independentArpeggio: true, // 6声+優先度スチールの範囲で
    echoDoubling: true,
    colorTones: true, // 伴奏は中央2声+コードトーン優先の差し替えで担える
    duetLayer: true, // 低優先度枠。声部が空いているときだけ鳴る(実機ドライバの様式)
    glide: true, // ピッチイベント列で近似
    stereo: false,
    backingPolyphony: false, // 単音リフへ要約
    drumVocabulary: 'chip5',
  },
  nes2a03: {
    id: 'nes2a03',
    label: 'ファミコン 2A03',
    independentArpeggio: false, // pulse2が伴奏と副旋律の全てを担う
    echoDoubling: false,
    colorTones: false, // 単声伴奏でテンションが3度を追い出すと和声が消える
    duetLayer: false,
    glide: false, // ハード(2A03)は得意だがNES編曲層が未実装
    stereo: false,
    backingPolyphony: false,
    drumVocabulary: 'chip5',
  },
  pcm: {
    id: 'pcm',
    label: 'PCM (SoundFont)',
    independentArpeggio: true,
    echoDoubling: true, // エコートラック装置(sound-design.ts)として実装済み
    colorTones: true,
    duetLayer: true,
    glide: true,
    stereo: true,
    backingPolyphony: true,
    drumVocabulary: 'gm',
  },
};

export function capabilitiesFor(chip: SoundBackendId | undefined): SoundCapabilities {
  return SOUND_CAPABILITIES[chip ?? 'opll'];
}

/**
 * 曲型(SongFormSpec)の正本: プリセットの展開・区間の検索・区間ごとの乱数・検証。
 *
 * 曲型は「小節数」ではなく「区間の列」。生成器(song-plan / phrase-plan / 各声部 /
 * arrangement / diagnostics)は「小節 N はどの区間か」をここでだけ引き、
 * `bars === 40 ? floor(bar / 8) : …` の算術を自前で持たない(構造テストで固定)。
 *
 * プリセットは同じ SongFormSpec への展開で、シードに依存しない(同じプリセットidが
 * 同じ区間列を指す。エネルギー弧のシード揺らぎは song-plan がプリセットidを見て行う)。
 */

import { Xoshiro128 } from '../rng.js';
import { BAR_GROUPING_LABELS, DEFAULT_GROUPING, gridFor, isBarGrouping } from './grid.js';
import type { GridDef } from './grid.js';
import { PROGRESSIONS, progressionForTonality } from './theory.js';
import type {
  BarGrouping,
  FormPresetId,
  PhraseFunction,
  SectionBars,
  SectionRole,
  SectionSpec,
  SectionTexture,
  SongEnding,
  SongFormRef,
  SongFormSpec,
  Tonality,
} from './types.js';

export const FORM_PRESET_IDS: readonly FormPresetId[] = ['loop4', 'loop8', 'loop16', 'arc40', 'song', 'songHemiola'];

/** UI 表示用のプリセット名。用途ラベル(RB/BB/BIG)はクライアント文脈だが、保存曲一覧の既存表記を継ぐ。 */
export const FORM_PRESET_LABELS: Record<FormPresetId, string> = {
  loop4: 'RB風4小節ループ',
  loop8: 'BB風8小節ループ',
  loop16: 'ゲームBGM風16小節',
  arc40: 'OPLL BIG風40小節',
  song: '歌もの96小節',
  songHemiola: '歌もの96小節(12/8↔6/4)',
};

export const SECTION_ROLES: readonly SectionRole[] = ['hook', 'development', 'relief', 'return', 'finale'];

export const SECTION_ROLE_LABELS: Record<SectionRole, string> = {
  hook: '看板',
  development: '展開',
  relief: '谷',
  return: '帰還',
  finale: '終幕',
};

export const SECTION_BARS_CHOICES: readonly SectionBars[] = [4, 8];

export const SONG_ENDINGS: readonly SongEnding[] = ['loop', 'final', 'ritardando'];

export const SONG_ENDING_LABELS: Record<SongEnding, string> = {
  loop: 'ループ（最終小節で頭へ渡す）',
  final: '終止（V→I で閉じる）',
  ritardando: '終止＋リタルダンド（最終 2 小節を減速して閉じる）',
};

export const SECTION_TEXTURES: readonly SectionTexture[] = ['normal', 'sustain', 'pulse'];

export const SECTION_TEXTURE_LABELS: Record<SectionTexture, string> = {
  normal: '通常',
  sustain: 'ロングトーン',
  pulse: 'パワーコード連打',
};

/** 終止で閉じる終わり方(final / ritardando)。ループでないことの判定はこれを使う。 */
export function closesWithCadence(ending: SongEnding): boolean {
  return ending !== 'loop';
}

export function isFormPresetId(value: unknown): value is FormPresetId {
  return typeof value === 'string' && (FORM_PRESET_IDS as readonly string[]).includes(value);
}

const section = (
  id: string,
  role: SectionRole,
  bars: SectionBars,
  energy: SectionSpec['energy'],
  theme: string,
  rest: Partial<Pick<SectionSpec, 'transform' | 'quote' | 'grouping'>> = {},
): SectionSpec => ({ id, role, bars, energy, theme, ...rest });

/**
 * プリセットの区間列。
 * - loop4/loop8: 1区間。
 * - loop16: Bの結論フレーズでAのフックを予告してループへ戻す(quote)。
 * - arc40: 実質2主題(AとC)。B/D/EはAの変形で、Dがリテラル帰還(現行の5区間弧をそのまま宣言)。
 * - song: 歌もの。A(提示)×2 → B → C(谷) → S(サビ) → A''(帰還) → B' → D(谷) → C' → S'(帰還) → S''(終幕) → A'''(終幕)。
 * - songHemiola: song と同じ区間列で、主題ごとに拍の割り方を揃える(A・S 系=12/8、B 系=6/4 のヘミオラ、
 *   C・D=4/4)。小節長は不変なので割り方が変わっても小節数・区間の時間は同じ。
 */
function presetSpec(id: FormPresetId): SongFormSpec {
  switch (id) {
    case 'loop4':
      return { sections: [section('A', 'hook', 4, 3, 'A')], ending: 'loop' };
    case 'loop8':
      return { sections: [section('A', 'hook', 8, 3, 'A')], ending: 'loop' };
    case 'loop16':
      return {
        sections: [
          section('A', 'hook', 8, 3, 'A'),
          section('B', 'development', 8, 3, 'B', { quote: { from: 'A', phrases: [3], transform: 'literal' } }),
        ],
        ending: 'loop',
      };
    case 'arc40':
      return {
        sections: [
          section('A', 'hook', 8, 4, 'A'),
          section('B', 'development', 8, 3, 'A', { transform: 'transpose' }),
          section('C', 'relief', 8, 2, 'C'),
          section('D', 'return', 8, 4, 'A', { transform: 'literal' }),
          section('E', 'finale', 8, 5, 'A', { transform: 'invert' }),
        ],
        ending: 'loop',
      };
    case 'song':
      return songSpec({});
    case 'songHemiola':
      return songSpec({ A: '4x3', S: '4x3', B: '3x4' });
  }
}

/** 歌ものの区間列。主題ごとの拍の割り方(省略=4x2)を受ける。 */
function songSpec(groupingByTheme: Partial<Record<'A' | 'B' | 'C' | 'D' | 'S', BarGrouping>>): SongFormSpec {
  const g = (theme: 'A' | 'B' | 'C' | 'D' | 'S'): Partial<Pick<SectionSpec, 'grouping'>> => (
    groupingByTheme[theme] ? { grouping: groupingByTheme[theme] } : {}
  );
  return {
    sections: [
      section('A', 'hook', 8, 3, 'A', g('A')),
      section("A'", 'hook', 8, 3, 'A', { transform: 'literal', ...g('A') }),
      section('B', 'development', 8, 4, 'B', g('B')),
      section('C', 'relief', 8, 2, 'C', g('C')),
      section('S', 'hook', 8, 5, 'S', g('S')),
      section("A''", 'return', 8, 3, 'A', { transform: 'transpose', ...g('A') }),
      section("B'", 'development', 8, 4, 'B', { transform: 'transpose', ...g('B') }),
      section('D', 'relief', 8, 2, 'D', g('D')),
      section("C'", 'relief', 8, 1, 'C', { transform: 'literal', ...g('C') }),
      section("S'", 'return', 8, 5, 'S', { transform: 'literal', ...g('S') }),
      section("S''", 'finale', 8, 5, 'S', { transform: 'transpose', ...g('S') }),
      section("A'''", 'finale', 8, 2, 'A', { transform: 'literal', ...g('A') }),
    ],
    ending: 'final',
  };
}

const presetCache = new Map<FormPresetId, SongFormSpec>();

/** 曲型の参照を区間列へ解決する。プリセットは展開結果をキャッシュし、呼び出し側は変更しない。 */
export function resolveForm(ref: SongFormRef): SongFormSpec {
  if (typeof ref !== 'string') return ref;
  let cached = presetCache.get(ref);
  if (!cached) {
    cached = presetSpec(ref);
    presetCache.set(ref, cached);
  }
  return cached;
}

/** プリセット参照なら id、明示の区間列なら null。上位戦略(arc40 限定)とブラインド比較が読む。 */
export function formPresetIdOf(ref: SongFormRef): FormPresetId | null {
  return typeof ref === 'string' ? ref : null;
}

/** イントロ(初回だけの2小節)の既定。短いループは従来どおり無し、それ以外は有り。 */
export function introDefaultFor(ref: SongFormRef): boolean {
  const preset = formPresetIdOf(ref);
  return preset !== 'loop4' && preset !== 'loop8';
}

/**
 * 旧入力(ComposeBars)からのプリセット対応。保存曲の移行(bgm-library)と、
 * 曲型入力へ切り替えるまでの compose の内部経路が使う。
 */
export function presetForBars(bars: number): FormPresetId {
  return bars === 40 ? 'arc40' : bars === 16 ? 'loop16' : bars === 8 ? 'loop8' : 'loop4';
}

/** 小節→区間の検索は区間の長さ列だけに依存する(SongFormSpec と SongFormPlan の両方で引ける)。 */
export interface SectionLengths {
  sections: readonly { bars: number }[];
}

export function totalBars(form: SectionLengths): number {
  return form.sections.reduce((sum, item) => sum + item.bars, 0);
}

/** 各区間の開始小節(本編内、イントロを含まない)。 */
export function sectionStartBars(form: SectionLengths): number[] {
  const starts: number[] = [];
  let bar = 0;
  for (const item of form.sections) {
    starts.push(bar);
    bar += item.bars;
  }
  return starts;
}

/** 小節 bar(本編内)が属する区間の添字。範囲外は両端へクランプする。 */
export function sectionIndexAt(form: SectionLengths, bar: number): number {
  let start = 0;
  for (let index = 0; index < form.sections.length; index++) {
    const end = start + form.sections[index]!.bars;
    if (bar < end) return index;
    start = end;
  }
  return Math.max(0, form.sections.length - 1);
}

/** 小節 bar の区間内オフセット。 */
export function barInSection(form: SectionLengths, bar: number): number {
  return bar - sectionStartBars(form)[sectionIndexAt(form, bar)]!;
}

/** 区間の最終小節か(区間境界のフィル・終止の判定)。 */
export function isSectionLastBar(form: SectionLengths, bar: number): boolean {
  const index = sectionIndexAt(form, bar);
  return barInSection(form, bar) === form.sections[index]!.bars - 1;
}

/** 4小節区間は1小節ずつ、8小節区間は2小節ずつ SRDC(提示・変奏反復・展開・結論)へ割り当てる。 */
export function phraseFunctionFor(offsetInSection: number, sectionBars: SectionBars): PhraseFunction {
  const functions: readonly PhraseFunction[] = ['statement', 'restatement', 'departure', 'conclusion'];
  if (sectionBars === 4) return functions[Math.min(3, offsetInSection)]!;
  return functions[Math.min(3, Math.floor(offsetInSection / 2))]!;
}

/**
 * 区間ごとの独立した乱数ストリーム。用途(salt)と区間添字で分け、`seed >>> (k + index)` の
 * ビット読み(mod 32 で区間21以降が衝突する)を置き換える。式は主題ジェスチャーの既存
 * ストリーム((seed ^ salt) + index * 黄金比定数)と同じ。
 */
export function sectionRng(seed: number, index: number, salt: number): Xoshiro128 {
  return new Xoshiro128(((seed ^ salt) + index * 0x9e37_79b9) >>> 0);
}

export interface FormIssue {
  level: 'error' | 'warning';
  /** 該当区間の id。曲型全体の問題なら null。 */
  section: string | null;
  message: string;
}

export interface FormDefaults {
  tonality: Tonality;
  progressionId: string;
}

/** 区間の実効値(曲既定で埋めたもの)。validateForm と song-plan が同じ解決を使う。 */
export function sectionProgressionId(spec: SectionSpec, defaults: Pick<FormDefaults, 'progressionId'>): string {
  return spec.progressionId ?? defaults.progressionId;
}

export function sectionTonality(spec: SectionSpec, defaults: Pick<FormDefaults, 'tonality'>): Tonality {
  return spec.tonality ?? defaults.tonality;
}

/** リズム族(phrase-plan)は5本なので、主題が6つ以上あると族を共有する。 */
export const RHYTHM_FAMILY_COUNT = 5;

/**
 * 曲型の検証。compose は error があれば throw し、UI は行ごとに表示する。
 * 主題の再登場と部分引用は、長さの異なる区間の間では成立しない
 * (phrase-plan の motifSourceBar が 2小節フレーズ単位で元区間を指すため)。
 */
export function validateForm(form: SongFormSpec, defaults: FormDefaults): FormIssue[] {
  const issues: FormIssue[] = [];
  const error = (section: string | null, message: string): void => {
    issues.push({ level: 'error', section, message });
  };
  if (form.sections.length === 0) {
    error(null, '区間が1つもない');
    return issues;
  }
  if (!(SONG_ENDINGS as readonly string[]).includes(form.ending)) error(null, `終わり方が不正: ${String(form.ending)}`);
  const seen = new Map<string, SectionSpec>();
  const themes: string[] = [];
  form.sections.forEach((spec, index) => {
    const id = typeof spec.id === 'string' ? spec.id : '';
    if (id === '') error(id, `${index + 1}番目の区間に id がない`);
    else if (id === 'intro') error(id, '区間 id に intro は使えない(イントロ区間と衝突する)');
    else if (seen.has(id)) error(id, `区間 id「${id}」が重複している`);
    if (!(SECTION_BARS_CHOICES as readonly number[]).includes(spec.bars)) {
      error(id, `小節数は 4 か 8(${String(spec.bars)})`);
    }
    if (!Number.isInteger(spec.energy) || spec.energy < 1 || spec.energy > 5) {
      error(id, `エネルギーは 1〜5(${String(spec.energy)})`);
    }
    if (!(SECTION_ROLES as readonly string[]).includes(spec.role)) error(id, `役割が不正: ${String(spec.role)}`);
    if (typeof spec.theme !== 'string' || spec.theme === '') error(id, '主題 id がない');
    if (spec.keyRoot !== undefined && (!Number.isInteger(spec.keyRoot) || spec.keyRoot < 0 || spec.keyRoot > 11)) {
      error(id, `キーは 0〜11 のピッチクラス(${String(spec.keyRoot)})`);
    }
    if (spec.tonality !== undefined && spec.tonality !== 'major' && spec.tonality !== 'minor') {
      error(id, `調性が不正: ${String(spec.tonality)}`);
    }
    if (spec.grouping !== undefined && !isBarGrouping(spec.grouping)) {
      error(id, `拍の割り方が不正: ${String(spec.grouping)}`);
    }
    if (spec.tempo !== undefined && !(Number.isFinite(spec.tempo) && spec.tempo >= 30 && spec.tempo <= 400)) {
      error(id, `テンポは 30〜400(${String(spec.tempo)})`);
    }
    if (spec.texture !== undefined && !(SECTION_TEXTURES as readonly string[]).includes(spec.texture)) {
      error(id, `テクスチャが不正: ${String(spec.texture)}`);
    }
    const textureOf = (candidate: SectionSpec): SectionTexture => candidate.texture ?? 'normal';
    // 先頭区間はイントロが主題を借りる(intro.ts)ので旋律が要る。
    if (index === 0 && textureOf(spec) !== 'normal') error(id, '先頭区間のテクスチャは通常であること(イントロが主題を借りる)');
    const grouping = isBarGrouping(spec.grouping) ? spec.grouping : DEFAULT_GROUPING;
    const groupingOf = (candidate: SectionSpec): string => candidate.grouping ?? DEFAULT_GROUPING;
    const groupingLabel = (value: string): string => (isBarGrouping(value) ? BAR_GROUPING_LABELS[value] : value);

    const themeSource = [...seen.values()].reverse().find((candidate) => candidate.theme === spec.theme);
    if (themeSource && themeSource.bars !== spec.bars) {
      error(id, `主題「${spec.theme}」の元区間「${themeSource.id}」(${themeSource.bars}小節)と小節数が違う`);
    }
    // リズム族の添字は拍の割り方ごとの表を指すので、割り方の違う区間間では主題を継げない
    // (再標本化は将来の仮説)。
    if (themeSource && groupingOf(themeSource) !== grouping) {
      error(id, `主題「${spec.theme}」の元区間「${themeSource.id}」(${groupingLabel(groupingOf(themeSource))})と拍の割り方が違う`);
    }
    // 旋律を持たない(ロングトーン・パワーコード)区間は主題の元になれない。
    if (themeSource && textureOf(themeSource) !== 'normal') {
      error(id, `主題「${spec.theme}」の元区間「${themeSource.id}」が${SECTION_TEXTURE_LABELS[textureOf(themeSource)]}で旋律を持たない`);
    }
    if (spec.quote) {
      if (themeSource) error(id, '主題の再登場と部分引用は併用できない(引用はフレーズ0の借用と排他)');
      const source = seen.get(spec.quote.from);
      if (!source) error(id, `引用元「${spec.quote.from}」が先行区間にない`);
      else if (source.bars !== spec.bars) error(id, `引用元「${source.id}」と小節数が違う`);
      else if (groupingOf(source) !== grouping) {
        error(id, `引用元「${source.id}」(${groupingLabel(groupingOf(source))})と拍の割り方が違う`);
      } else if (textureOf(source) !== 'normal') {
        error(id, `引用元「${source.id}」が${SECTION_TEXTURE_LABELS[textureOf(source)]}で旋律を持たない`);
      }
      const phrases = Array.isArray(spec.quote.phrases) ? spec.quote.phrases : [];
      if (phrases.length === 0) error(id, '引用するフレーズが空');
      for (const phrase of phrases) {
        if (![0, 1, 2, 3].includes(phrase)) error(id, `引用フレーズ番号が不正: ${String(phrase)}`);
        else if (spec.bars === 4 && phrase % 2 === 1) error(id, '4小節区間の引用は問い側(0・2)だけ');
      }
    }

    const progressionId = sectionProgressionId(spec, defaults);
    const progression = PROGRESSIONS.find((candidate) => candidate.id === progressionId);
    const tonality = sectionTonality(spec, defaults);
    if (!progression) error(id, `未知の進行: ${progressionId}`);
    else {
      const realized = progressionForTonality(progression, tonality);
      if (!realized) error(id, `${tonality === 'minor' ? '短調' : '長調'}では進行「${progression.name}」を使用できない`);
      else if (realized.slots.length > spec.bars) {
        error(id, `進行「${progression.name}」(${realized.slots.length}小節)が区間(${spec.bars}小節)より長い`);
      }
    }

    if (id !== '' && !seen.has(id)) seen.set(id, spec);
    if (typeof spec.theme === 'string' && !themes.includes(spec.theme)) themes.push(spec.theme);
  });
  if (themes.length > RHYTHM_FAMILY_COUNT) {
    issues.push({
      level: 'warning',
      section: null,
      message: `主題が${themes.length}種あり、リズム族(${RHYTHM_FAMILY_COUNT}本)を共有する主題が出る`,
    });
  }
  return issues;
}

/** 本編内の小節が属する区間の拍の割り方(省略=4x2)。格子の実体は grid.ts の gridFor。 */
/** 区間列の拍の割り方だけを見る構造型(SongFormSpec と SongFormPlan の両方が満たす)。 */
export type SectionGroupings = { sections: readonly { bars: number; grouping?: BarGrouping }[] };

export function groupingAt(form: SectionGroupings, bar: number): BarGrouping {
  return form.sections[sectionIndexAt(form, bar)]?.grouping ?? DEFAULT_GROUPING;
}

/** 絶対拍(イントロ込み)の拍格子。イントロ(loopStartBeat より前)は常に 4x2。診断・レンダラが使う。 */
export function gridAtBeat(form: SectionGroupings, loopStartBeat: number, beat: number): GridDef {
  if (beat < loopStartBeat) return gridFor(DEFAULT_GROUPING);
  return gridFor(groupingAt(form, Math.floor((beat - loopStartBeat) / 4)));
}

/** 検証エラーを1つの例外文へまとめる(compose が使う)。 */
export function formErrorMessage(issues: readonly FormIssue[]): string | null {
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length === 0) return null;
  return errors
    .map((issue) => (issue.section ? `[${issue.section}] ${issue.message}` : issue.message))
    .join(' / ');
}

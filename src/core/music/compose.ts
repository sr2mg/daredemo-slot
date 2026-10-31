/**
 * 決定論的な作曲エンジン（サウンドテスト用）。
 * 決定順序は「テンポ・キー → スタイル → フォーム → コード進行 → モチーフ → メロディ」の
 * トップダウン（docs 未整備。UI の SoundTestPanel が唯一の呼び出し元）。
 * 同一シード + 同一オプションなら常に同じ Piece を返す（Xoshiro128 再利用）。
 *
 * メロディの制約:
 * - 強拍（1・3 拍目）はその時点のコードトーンに限定
 * - 弱拍は 2 小節単位の動き方を反復し、スケール音の順次進行 or コードトーンへの跳躍
 * - クライマックス（最高音）はフォーム後半の2候補からシードで選び、頭に1箇所
 * - 最終小節の後半は音を減らしてループの頭に「渡す」
 *
 * データモデル（Piece / ComposeOptions / 各設計図の型）は types.ts が正本。
 */

import { Xoshiro128 } from '../rng.js';
import type { Rng } from '../rng.js';
import {
  CHORDS, COUNTER_HI, COUNTER_LO, MELODY_HI, MELODY_LO, PROGRESSIONS, STYLES, chordName,
  chordScalePcs, drumPatternStep, harmonicFunctionForToken, progressionForTonality,
} from './theory.js';
import { idiomFor } from './melodic-idiom.js';
import type { StyleDef } from './theory.js';
import { featuredGuideStrand } from './voice-leading.js';
import { arrangementPlanFor, arrangementSectionFor } from './arrangement.js';
import { defaultChoiceFor, variedChoiceFor as chooseVariedHarmony } from './harmony-plan.js';
import {
  DEFAULT_GROOVE_FEEL, grooveBeat, grooveFor, hasStraightSixteenths, tripletHatOffsets,
} from './groove.js';
import type { GrooveFeel } from './groove.js';
import { groupingDissonanceFor } from './metric-modulation.js';
import { selectTensionPcs } from './tension.js';
import { capabilitiesFor } from './sound-capabilities.js';
import { applyDiminution } from './diminution.js';
import { applyDrumArticulation } from './drum-articulation.js';
import { duetLayerFor } from './duet.js';
import { applyGlideMarks } from './glide.js';
import {
  appoggiaturaRatePercent, fragmentOf, invertTheme, realizeDegree,
  themeDegreeSpan, themeFromGesture, transposeTheme,
} from './melodic-theme.js';
import type { ThemeSpec } from './melodic-theme.js';
import {
  createSongPlan,
  legacyMelodyMode,
  resolveMelodicLanguage,
  resolveTonality,
} from './song-plan.js';
import { engineRevOf } from './types.js';
import type {
  ArrangementPlan,
  BassLinePolicy,
  CadenceType,
  ChordEvent,
  ComposeBars,
  ComposeInput,
  DiminutionPolicy,
  DrumEvent,
  DuetPolicy,
  GlidePolicy,
  HarmonicFunction,
  IntroRole,
  JapanesePlan,
  JapaneseScale,
  JapaneseScaleChoice,
  MelodicLanguage,
  MelodicMotif,
  MelodyEdit,
  MotifMove,
  MotifTransform,
  NoteArticulation,
  NoteEvent,
  OrnamentType,
  PhraseBarPlan,
  PhraseFunction,
  PhrasePlan,
  PhraseSection,
  Piece,
  SongPlan,
  TensionPolicy,
  Tonality,
  TupletDivision,
} from './types.js';
import { bridgeWithPc, nearestWithPc, stepOnScale } from './pitch.js';
import { makePhraseGesture, makePhrasePlan, sanitizeMotif } from './phrase-plan.js';
import { voiceChord } from './voicing.js';
import { realizeIntro } from './intro.js';
import type { ComposeContext } from './compose-context.js';
import { generateMelody } from './melody-voice.js';
import { generateCounterMelody } from './counter-voice.js';
import { generateBass } from './bass-voice.js';
import { generateOstinato } from './ostinato-voice.js';
import { generateDrums } from './drum-voice.js';

function withMelodyEdits(notes: readonly NoteEvent[], edits: readonly MelodyEdit[] = []): NoteEvent[] {
  const result = notes.map((note) => ({ ...note }));
  for (const edit of edits) {
    const target = result.find((note) => (
      Math.abs(note.beat - edit.beat) < 0.001 && note.midi === edit.fromMidi
    ));
    if (target) target.midi = edit.toMidi;
  }
  return result;
}


export function compose(opts: ComposeInput): Piece {
  const progression = PROGRESSIONS.find((p) => p.id === opts.progressionId);
  if (!progression) throw new Error(`未知の進行: ${opts.progressionId}`);
  const style = STYLES.find((s) => s.id === opts.styleId);
  if (!style) throw new Error(`未知のスタイル: ${opts.styleId}`);
  const tonality = resolveTonality(opts);
  const prog = progressionForTonality(progression, tonality);
  if (!prog) {
    throw new Error(`${tonality === 'minor' ? '短調' : '長調'}では進行「${progression.name}」を使用できません`);
  }
  const progBars = prog.slots.length;
  if (progBars > opts.bars) throw new Error(`進行(${progBars}小節)が尺(${opts.bars}小節)より長い`);

  const rng = new Xoshiro128(opts.seed >>> 0);
  const keyRoot = ((opts.keyRoot % 12) + 12) % 12;
  const melodicLanguage = resolveMelodicLanguage(opts);
  // 語法ごとの判断(音組織・着地規則・装置の抑制・間・弱起…)は melodic-idiom.ts の宣言を
  // 参照する。ここから先で語法名を比較しない。
  const idiom = idiomFor(melodicLanguage);
  const melodyMode = legacyMelodyMode(tonality, melodicLanguage);
  const japanesePlan = idiom.culturalPlan(keyRoot, opts.japaneseScale, opts.seed);
  const scalePcs = japanesePlan?.scalePcs
    ?? idiom.scaleIntervals(tonality).map((t) => (t + keyRoot) % 12);
  // 弱拍・経過音の音組織は小節のコードスケール（変位音でキーの音階を上書きした音組織）。
  // 旋律語彙が固定の語法(五音系・和風)は対象外とし、従来の音組織を保つ。
  // テンション導出も同じキャッシュを通し、旋律側と音組織の解釈が分岐しないようにする。
  const chordScaleCache = new Map<string, readonly number[]>();
  const chordScaleForToken = (token: string, pcs: readonly number[]): readonly number[] => {
    let cached = chordScaleCache.get(token);
    if (!cached) {
      cached = chordScalePcs(scalePcs, pcs, (CHORDS[token]!.root + keyRoot) % 12);
      chordScaleCache.set(token, cached);
    }
    return cached;
  };
  const scaleAt = (chord: ChordEvent): readonly number[] => {
    // 五音系の語法は旋律語彙が固定(コードスケールで上書きしない)。変位和音への追従は
    // 強拍のコードトーン規則が担い、弱拍の歩みは五音のまま保つ(四千年型の書法)。
    if (!idiom.followsChordScale) return scalePcs;
    return chordScaleForToken(chord.token, chord.pcs);
  };
  const grooveFeel = opts.grooveFeel ?? DEFAULT_GROOVE_FEEL;
  // カラートーンとディミニューションはスタイル既定を土台に上書き。和風五音は
  // 開放五度・間の美学と衝突するため両方とも常にoffへ落とす(語法の宣言)。
  const resolveDevicePolicy = <T extends string>(
    choice: 'auto' | T | undefined,
    styleDefault: T | undefined,
  ): T | 'off' => {
    if (idiom.suppressesDevices) return 'off';
    if (choice === undefined || choice === 'auto') return styleDefault ?? 'off';
    return choice;
  };
  // テンションは伴奏がカラートーンを担える(colorTones)バックエンドだけ。2A03は
  // pulse2の単声が和声の全てを担うため、第3音を追い出すと和声の同一性ごと失われる。
  const tensionPolicy: TensionPolicy = !capabilitiesFor(opts.soundChip).colorTones
    ? 'off'
    : resolveDevicePolicy<TensionPolicy>(opts.tensionPolicy, style.devices?.tension);
  const diminutionPolicy: DiminutionPolicy = resolveDevicePolicy<DiminutionPolicy>(
    opts.diminution, style.devices?.diminution,
  );
  const backendCaps = capabilitiesFor(opts.soundChip);
  const duetPolicy = backendCaps.duetLayer
    ? resolveDevicePolicy<DuetPolicy>(opts.duet, style.devices?.duet)
    : 'off';
  const glidePolicy = backendCaps.glide
    ? resolveDevicePolicy<GlidePolicy>(opts.glide, style.devices?.glide)
    : 'off';
  // ベースラインは全バックエンドで鳴る声部なので能力ゲートは要らない。
  const bassLinePolicy = resolveDevicePolicy<BassLinePolicy>(opts.bassLine, style.bass.line);
  const engineRev = engineRevOf(opts);
  const choice = opts.choice ?? (opts.bars >= 8
    ? chooseVariedHarmony(prog, opts.bars, opts.seed)
    : defaultChoiceFor(prog, opts.bars));
  const songPlan = createSongPlan({
    bars: opts.bars,
    seed: opts.seed,
    tonality,
    melodicLanguage,
    grooveFeel,
    soundChip: opts.soundChip ?? 'opll',
    progression: prog,
    style,
    choice,
    intro: opts.intro !== false,
    bassLine: bassLinePolicy,
    ...(opts.compositionStrategy ? { compositionStrategy: opts.compositionStrategy } : {}),
  });
  const arrangementPlan = arrangementPlanFor(
    opts.bars, opts.seed, opts.progressionId, songPlan, opts.tupletOverlay ?? 'off',
  );

  // --- SongPlanで確定した和声機能と変化位置を、実コードへ展開する。 ---
  const barTokens = songPlan.harmony.map((bar) => [...bar.tokens]);
  const barChordDurations = songPlan.harmony.map((bar) => [...bar.durations]);

  const chords: ChordEvent[] = [];
  let previousVoicing: number[] | null = null;
  barTokens.forEach((tokens, bar) => {
    const barBassDegrees = songPlan.harmony[bar]!.bassDegrees;
    if (barBassDegrees && barBassDegrees.length !== tokens.length) {
      // 生成器のオフバイワンを無音のルートポジション扱いですり抜けさせない。
      throw new Error(`${bar + 1}小節目のbassDegrees(${barBassDegrees.length})がtokens(${tokens.length})と不一致`);
    }
    let offset = 0;
    tokens.forEach((token, i) => {
      const dur = barChordDurations[bar]![i]!;
      const def = CHORDS[token]!;
      const pcs = def.tones.map((t) => (t + keyRoot) % 12);
      const rootPc = (def.root + keyRoot) % 12;
      // カラートーンはボイシングにだけ足す。機能検証・旋律の強拍アンカーはpcsのまま。
      // イントロは薄い導入なので素の三和音に留め、本編でテンションが開く出し引きにする。
      const colorPcs = (tensionPolicy === 'off'
        ? []
        : selectTensionPcs(pcs, chordScaleForToken(token, pcs), rootPc, tensionPolicy)
      ).slice(0, Math.max(0, 5 - pcs.length)); // 密集配置(≤14半音)が成立する5声まで
      const midis = voiceChord([...pcs, ...colorPcs], previousVoicing, idiom.openFifthsVoicing);
      const bassDegree = barBassDegrees?.[i] ?? null;
      chords.push({
        beat: bar * 4 + offset,
        dur,
        token,
        name: chordName(token, keyRoot),
        function: harmonicFunctionForToken(token),
        pcs,
        midis,
        colorPcs,
        // 半音下行接近を-1と書ける生成器のためにmod 12へ正規化する。
        ...(bassDegree !== null ? { bassPc: (((bassDegree + keyRoot) % 12) + 12) % 12 } : {}),
      });
      previousVoicing = midis;
      offset += dur;
    });
  });
  // ループ末尾→先頭も同じ声部進行として扱い、循環パスで配置を安定させる。
  for (let pass = 0; pass < 2; pass++) {
    let previous = chords.at(-1)?.midis ?? null;
    for (const chord of chords) {
      chord.midis = voiceChord(
        [...chord.pcs, ...(chord.colorPcs ?? [])], previous, idiom.openFifthsVoicing,
      );
      previous = chord.midis;
    }
  }
  const chordAt = (beat: number): ChordEvent => {
    let cur = chords[0]!;
    for (const c of chords) {
      if (c.beat <= beat) cur = c;
      else break;
    }
    return cur;
  };

  // --- PhrasePlan（旋律・副旋律・ベースが共有する設計図） ---
  // 強拍の着地候補は語法の規則(melodic-idiom.ts の landingPcs)。終止目標(phrase-plan)も
  // 同じ関数を使い、二重実装にしない。核音の優先は PhrasePlan の到達点だけで行う。
  const melodyPcsForChord = (chord: ChordEvent): readonly number[] => idiom.landingPcs(chord.pcs, scalePcs);
  const startMidi = nearestWithPc(76, melodyPcsForChord(chordAt(0)));
  const phrasePlan = makePhrasePlan(
    opts, style, rng, chordAt, startMidi, idiom, scalePcs, japanesePlan, arrangementPlan, songPlan,
  );
  // 区間ごとに別の音程ジェスチャーを持つ。リズムだけ変えて同じ上下動をA〜Eへ貼らない。
  // rev2: 主題ジェスチャーは主系列rngでなく区間ごとの独立ストリームから抽選する。
  // rev1以前はPhrasePlanの消費直後の主系列を使っており、フレーズ計画の抽選回数が
  // 変わるとジェスチャーが連動して変わる暗黙結合があった(保存曲は旧経路で再現)。
  const phraseGestures = songPlan.form.sections.map((_, sectionIndex) => makePhraseGesture(
    engineRev >= 2
      ? new Xoshiro128(((opts.seed ^ 0x4753_5452) + sectionIndex * 0x9e37_79b9) >>> 0)
      : rng,
    style,
  ));
  // 曲間モチーフ流用: 外部モチーフは主題区間(A)のジェスチャーだけを置き換える。
  // 乱数消費は変えない(全区間ぶん生成してから差し替える)ので、他区間・他声部は不変。
  // B〜E側への浸透は既存のモチーフ借用(motifSourceBar / externalMotifPhrases)が担う。
  if (opts.externalMotif) phraseGestures[0] = sanitizeMotif(opts.externalMotif, phraseGestures[0]!);
  // 音組織上の「隣」とみなす最大半音数(語法の宣言: 標準=2、和風=4、五音系は導出)。
  const scaleStepMax = idiom.scaleStepMax(scalePcs);
  const baseCenter = style.melody.center ?? 78;
  const climaxChord = chordAt(phrasePlan.climaxBar * 4);
  const climaxMidi = nearestWithPc(
    MELODY_HI,
    // 五音とコードの共通音が1音しかない場合も、山だけはコード全体へ開いて
    // 十分な高さを確保する。和声上は安定し、以後の音域制限にも12音分の余地が残る。
    climaxChord.pcs,
  );


  // --- 各声部の実音化（声部ジェネレータは乱数を持たない決定論的実現） ---
  const ctx: ComposeContext = {
    opts, style, keyRoot, melodicLanguage, idiom, scalePcs, grooveFeel, engineRev, bassLinePolicy,
    songPlan, arrangementPlan, phrasePlan, phraseGestures, chords, chordAt, scaleAt,
    melodyPcsForChord, startMidi, climaxMidi, baseCenter, scaleStepMax,
  };
  const melody = generateMelody(ctx);
  const counterMelody = generateCounterMelody(ctx, melody);
  const bass = generateBass(ctx);
  const ostinato = generateOstinato(ctx);
  const drums = generateDrums(ctx);

  // --- SongPlanで本編より先に決めた、初回だけのイントロ（16/40小節フォーム） ---
  // 実音はAのモチーフと入口ボイシングが確定してから逆算し、最後に本編を後ろへずらす。
  const introBars = songPlan.intro.bars;
  const introRole = songPlan.intro.role;
  const loopStartBeat = introBars * 4;
  const realizedIntro = realizeIntro(
    songPlan.intro, chords, melody, style, keyRoot, scalePcs, idiom, grooveFeel,
  );
  const introChords = realizedIntro.chords;
  const introMelody = realizedIntro.melody;
  const introBass = realizedIntro.bass;
  const introDrums = realizedIntro.drums;
  const introChordNames = realizedIntro.chordNames;

  if (loopStartBeat > 0) {
    for (const event of chords) event.beat += loopStartBeat;
    for (const event of melody) event.beat += loopStartBeat;
    for (const event of counterMelody) event.beat += loopStartBeat;
    for (const event of ostinato) event.beat += loopStartBeat;
    for (const event of bass) event.beat += loopStartBeat;
    for (const event of drums) event.beat += loopStartBeat;
  }

  const editedMelody = withMelodyEdits([...introMelody, ...melody], opts.melodyEdits);

  // --- ディミニューション（局所修正まで確定した後の最終旋律パス） ---
  // melodyEditsで骨格音が動いた後に経過音を選ぶことで、挿入音が必ず「編集後の
  // 両端の間」に挟まれる不変条件を守る。乱数は骨格生成と独立に持ち、装置のon/off
  // で骨格が1音も動かないことを保証する。イントロは薄い導入なので細分しない。
  let finalMelody = editedMelody;
  if (diminutionPolicy !== 'off') {
    const diminutionRng = new Xoshiro128((opts.seed ^ 0x44494d49) >>> 0);
    const bodyMelody = editedMelody.filter((note) => note.beat >= loopStartBeat);
    applyDiminution(
      bodyMelody,
      diminutionPolicy,
      (beat) => scaleAt(chordAt(beat - loopStartBeat)),
      (bound) => diminutionRng.nextInt(bound),
      {
        // 走句(4分対の16分埋め)はストレートな16分格子が有効なグルーヴのみ。他は従来の8分対まで。
        maxGapBeats: hasStraightSixteenths(grooveFeel) ? 1.0 : 0.75,
        // 走句は8分格子位置にも乗るため、副旋律が予約した発音位置を避ける。
        blockedBeats: [
          ...counterMelody.map((note) => note.beat),
          // 半小節タイのアンカー拍。ここへ走句・経過音を挿すとタイ音が短縮されて
          // 「食い」が消えるため、タイを跨ぐ骨格対にはフィギュアを置かせない。
          ...phrasePlan.bars
            .filter((barPlan) => barPlan.anchorTie)
            .map((barPlan) => loopStartBeat + barPlan.bar * 4 + 2),
        ],
      },
    );
    finalMelody = [
      ...editedMelody.filter((note) => note.beat < loopStartBeat),
      ...bodyMelody,
    ];
  }

  // --- ハモリ層(平行下3度、duet.ts) ---
  // 音量はここでは決めない: velocityは主旋律を継承し、バランスは各ミキサーが所有する。
  const sectionSource = { bars: opts.bars, loopStartBeat, arrangementPlan };
  const duet: NoteEvent[] = duetPolicy === 'on'
    ? duetLayerFor(
      finalMelody,
      loopStartBeat,
      (beat) => arrangementSectionFor(sectionSource, beat),
      (beat) => scaleAt(chordAt(beat - loopStartBeat)),
    )
    : [];

  // --- スライド(ポルタメント)指示 --- 付与規則と時間定数の共有規則はglide.ts。
  if (glidePolicy === 'on') applyGlideMarks(finalMelody, loopStartBeat);

  return {
    bpm: opts.bpm,
    styleId: style.id,
    tonality,
    melodicLanguage,
    melodyMode,
    japanesePlan,
    melodicScalePcs: [...scalePcs],
    motif: { moves: phraseGestures[0]!.map((move) => ({ ...move })) },
    grooveFeel,
    bars: opts.bars,
    introBars,
    introRole,
    loopStartBeat,
    beats: loopStartBeat + opts.bars * 4,
    keyRoot,
    chords: [...introChords, ...chords],
    melody: finalMelody,
    counterMelody,
    ostinato,
    duet,
    bass: [...introBass, ...bass],
    drums: applyDrumArticulation(
      [...introDrums, ...drums],
      loopStartBeat,
      loopStartBeat + opts.bars * 4,
    ),
    phrasePlan,
    songPlan,
    arrangementPlan,
    introChordNames,
    barChordNames: barTokens.map((tokens, bar) => {
      const equalDuration = 4 / tokens.length;
      return tokens.map((token, index) => {
        const duration = barChordDurations[bar]![index]!;
        const durationLabel = Math.abs(duration - equalDuration) > 0.001 ? `(${duration}拍)` : '';
        return `${chordName(token, keyRoot)}${durationLabel}`;
      }).join(' ');
    }),
  };
}

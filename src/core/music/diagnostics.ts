import { capabilitiesFor } from './sound-capabilities.js';
import { CHORDS, COUNTER_HI, COUNTER_LO, MELODY_HI, MELODY_LO } from './theory.js';
import { allowsTupletOverlay, grooveBeat } from './groove.js';
import { melodicPhraseSimilarity, melodicSectionSimilarities } from './diversity.js';
import type { ChordEvent, MelodyEdit, NoteEvent, Piece } from './compose.js';

export interface Violation {
  beat: number;
  midi: number;
  reason: string;
}

export type DiagnosticCategory =
  | 'harmony'
  | 'melody'
  | 'voiceLeading'
  | 'rhythm'
  | 'counterpoint'
  | 'texture'
  | 'form'
  | 'loop';

export interface CompositionIssue extends Violation {
  category: DiagnosticCategory;
  severity: 'error' | 'warning';
  code?: 'melody-large-leap' | 'melody-unresolved-nonchord';
  target?: { part: 'melody'; noteIndex: number };
}

export interface CompositionObservation {
  beat: number;
  kind: 'embellishment' | 'motif';
  description: string;
  relatedBeats: number[];
}

export interface CompositionReport {
  /** 構造規則の状態。曲の魅力度を表す点数ではない。 */
  status: 'pass' | 'attention' | 'error';
  categoryStatus: Record<DiagnosticCategory, 'pass' | 'attention' | 'error'>;
  /** @deprecated 既存の修正候補比較用。UIでは品質点として表示しない。 */
  overall: number;
  /** @deprecated 既存API互換。UIではカテゴリ状態を使う。 */
  scores: Record<DiagnosticCategory, number>;
  issues: CompositionIssue[];
  observations: CompositionObservation[];
}

export interface CompositionRepair {
  edit: MelodyEdit;
  strategy: 'resolve-next' | 'stabilize-note' | 'reduce-leap';
}

function melodicDirection(from: number, to: number): -1 | 0 | 1 {
  return to === from ? 0 : to > from ? 1 : -1;
}

/** 五音系の音組織では3～4半音も音階上の隣になり得るため、半音数だけで判定しない。 */
function isMelodicStep(piece: Piece, from: number, to: number): boolean {
  if (from === to) return false;
  if (Math.abs(to - from) <= 2) return true;
  // 旋律語彙はPieceが一元管理する(標準=ダイアトニック、和風/五音=各音組織)。
  // ダイアトニックでは隣接音級が常に2半音以下なので、この経路は五音系だけで効く。
  const collection = piece.melodicScalePcs;
  if (!collection?.includes(((from % 12) + 12) % 12)) return false;
  const direction = melodicDirection(from, to);
  let cursor = from + direction;
  while (Math.abs(cursor - from) <= 12) {
    if (collection.includes(((cursor % 12) + 12) % 12)) return cursor === to;
    cursor += direction;
  }
  return false;
}

function embellishmentAt(
  piece: Piece,
  before: NoteEvent | undefined,
  note: NoteEvent,
  after: NoteEvent,
  nextChord: ChordEvent,
): string | null {
  const incomingDirection = before ? melodicDirection(before.midi, note.midi) : 0;
  const outgoingDirection = melodicDirection(note.midi, after.midi);
  const incomingStep = before ? isMelodicStep(piece, before.midi, note.midi) : false;
  const outgoingStep = isMelodicStep(piece, note.midi, after.midi);
  if (before?.midi === note.midi && outgoingStep) {
    return outgoingDirection < 0 ? '掛留音' : '倚音的な保続';
  }
  if (note.midi === after.midi && nextChord.pcs.includes(note.midi % 12)) return '先取音';
  if (incomingStep && outgoingStep) {
    return incomingDirection === outgoingDirection ? '経過音' : '刺繍音';
  }
  if (!incomingStep && outgoingStep && incomingDirection === -outgoingDirection) return '倚音';
  if (incomingStep && !outgoingStep && incomingDirection === -outgoingDirection) return '逸音';
  return null;
}

/** 生成結果を和声・旋律・声部・リズム・編成・フォーム・ループに分けて診断する。 */
export function diagnosePiece(piece: Piece): CompositionReport {
  const issues: CompositionIssue[] = [];
  const observations: CompositionObservation[] = [];
  const categories: DiagnosticCategory[] = [
    'harmony', 'melody', 'voiceLeading', 'rhythm', 'counterpoint', 'texture', 'form', 'loop',
  ];
  const add = (
    category: DiagnosticCategory,
    severity: CompositionIssue['severity'],
    beat: number,
    midi: number,
    reason: string,
    metadata: Pick<CompositionIssue, 'code' | 'target'> = {},
  ) => issues.push({
    category, severity, beat, midi, reason,
    ...(metadata.code ? { code: metadata.code } : {}),
    ...(metadata.target ? { target: metadata.target } : {}),
  });
  const chordAt = (beat: number): ChordEvent => {
    let current = piece.chords[0]!;
    for (const chord of piece.chords) {
      if (chord.beat <= beat) current = chord;
      else break;
    }
    return current;
  };
  const bodyStart = piece.loopStartBeat;

  for (const note of piece.melody) {
    if (note.midi < MELODY_LO || note.midi > MELODY_HI) {
      add('melody', 'error', note.beat, note.midi, '主旋律が音域外');
    }
    if (note.beat < 0 || note.dur <= 0 || note.beat + note.dur > piece.beats + 0.001) {
      add('rhythm', 'error', note.beat, note.midi, '主旋律の音価が曲の範囲外');
    }
    const inBar = note.beat % 4;
    // 装飾（前打音・回し）は強拍に食い込んでも直後の到達音へ解決するため、強拍和声の対象にしない。
    if ((inBar === 0 || inBar === 2) && note.role !== 'ornament') {
      const chord = chordAt(note.beat);
      if (!chord.pcs.includes(note.midi % 12)) {
        // 倚音: 強拍の非和声音でも、1拍以内の次の構造音へ順次進行で解決し、
        // 解決先がその時点の和声音なら誤りではなく表現（アクセントされた非和声音）。
        // 生成側は3拍目(inBar===2)にだけ倚音を置くため、免責もそこに限る
        // （フレーズ頭や編集起因の非和声音まで偶然の条件一致で隠さない）。
        let resolution: NoteEvent | undefined;
        for (const candidate of piece.melody) {
          if (candidate.role === 'ornament' || candidate.beat <= note.beat + 0.001) continue;
          if (!resolution || candidate.beat < resolution.beat) resolution = candidate;
        }
        const resolves = inBar === 2
          && resolution !== undefined
          && resolution.beat - note.beat <= 1.001
          && isMelodicStep(piece, note.midi, resolution.midi)
          && chordAt(resolution.beat).pcs.includes(resolution.midi % 12);
        if (resolves) {
          observations.push({
            beat: note.beat,
            kind: 'embellishment',
            description: '強拍の倚音として解決',
            relatedBeats: [resolution!.beat],
          });
        } else {
          add('harmony', 'error', note.beat, note.midi, `強拍が ${chord.name} のコードトーン外`);
        }
      }
    }
  }

  const bodyMelody = piece.melody
    .map((note, noteIndex) => ({ note, noteIndex }))
    .filter(({ note }) => note.beat >= bodyStart && note.role !== 'ornament');
  const motifGroups = new Map<string, { position: number; beat: number }[]>();
  for (let position = 0; position < bodyMelody.length; position++) {
    const note = bodyMelody[position]!.note;
    const relative = note.beat - bodyStart;
    const bar = Math.min(piece.bars - 1, Math.max(0, Math.floor(relative / 4)));
    const plan = piece.phrasePlan.bars[bar]!;
    const step = Math.round((relative - bar * 4) * 2);
    const key = `${plan.motifSourceBar}:${step}`;
    const group = motifGroups.get(key) ?? [];
    group.push({ position, beat: note.beat });
    motifGroups.set(key, group);
  }
  const contextSignature = (position: number): string => {
    const before = bodyMelody[position - 1]?.note;
    const note = bodyMelody[position]!.note;
    const after = bodyMelody[position + 1]?.note;
    if (!before || !after) return '';
    const incoming = `${melodicDirection(before.midi, note.midi)}${isMelodicStep(piece, before.midi, note.midi) ? 's' : 'l'}`;
    const outgoing = `${melodicDirection(note.midi, after.midi)}${isMelodicStep(piece, note.midi, after.midi) ? 's' : 'l'}`;
    return `${incoming}:${outgoing}`;
  };
  const motifRelationsAt = (position: number): number[] => {
    const note = bodyMelody[position]!.note;
    const relative = note.beat - bodyStart;
    const bar = Math.min(piece.bars - 1, Math.max(0, Math.floor(relative / 4)));
    const plan = piece.phrasePlan.bars[bar]!;
    const step = Math.round((relative - bar * 4) * 2);
    const signature = contextSignature(position);
    if (!signature) return [];
    const sameContext = (motifGroups.get(`${plan.motifSourceBar}:${step}`) ?? [])
      .filter((entry) => entry.position !== position && contextSignature(entry.position) === signature)
      .map((entry) => entry.beat);
    const pitchLanguage = piece.melodicScalePcs;
    return step !== 0 && step !== 4 && pitchLanguage.includes(note.midi % 12) ? sameContext : [];
  };

  for (let position = 0; position < bodyMelody.length; position++) {
    const { note, noteIndex } = bodyMelody[position]!;
    const before = bodyMelody[position - 1]?.note;
    const after = bodyMelody[position + 1]?.note;
    if (before && Math.abs(note.midi - before.midi) > 9) {
      // 直後に反対方向の順次進行で受け止められた跳躍は、古典的な均衡跳躍として許容する。
      const balanced = after
        && isMelodicStep(piece, note.midi, after.midi)
        && melodicDirection(before.midi, note.midi) !== 0
        && melodicDirection(note.midi, after.midi) === -melodicDirection(before.midi, note.midi);
      if (balanced) {
        observations.push({
          beat: note.beat,
          kind: 'embellishment',
          description: '大跳躍だが反行順次で均衡',
          relatedBeats: [],
        });
      } else {
        add('melody', 'warning', note.beat, note.midi, '主旋律の跳躍が9半音を超える', {
          code: 'melody-large-leap', target: { part: 'melody', noteIndex },
        });
      }
    }
    const chord = chordAt(note.beat);
    if (!after || chord.pcs.includes(note.midi % 12)) continue;
    const nextChord = chordAt(after.beat);
    if (isMelodicStep(piece, note.midi, after.midi) || nextChord.pcs.includes(after.midi % 12)) continue;
    const embellishment = embellishmentAt(piece, before, note, after, nextChord);
    if (embellishment) {
      observations.push({
        beat: note.beat, kind: 'embellishment', description: `${embellishment}として成立`, relatedBeats: [],
      });
      continue;
    }
    const relatedBeats = motifRelationsAt(position);
    if (relatedBeats.length > 0) {
      observations.push({
        beat: note.beat, kind: 'motif', description: '反復する輪郭の特徴音として保持', relatedBeats,
      });
      continue;
    }
    add('melody', 'warning', note.beat, note.midi, '非和声音の進行方向が不明瞭', {
      code: 'melody-unresolved-nonchord', target: { part: 'melody', noteIndex },
    });
  }

  for (let index = 0; index < piece.chords.length; index++) {
    const chord = piece.chords[index]!;
    if (chord.midis.some((midi, voice) => voice > 0 && midi <= chord.midis[voice - 1]!)) {
      add('voiceLeading', 'error', chord.beat, chord.midis[0] ?? -1, `${chord.name} のボイシングが交差`);
    }
    const previous = piece.chords[index - 1];
    if (!previous || previous.beat < bodyStart && chord.beat >= bodyStart) continue;
    // テンションで声部数が和音ごとに変わると固定インデックスは別声部を比べてしまう。
    // 同数のときだけ声部対応が取れているとみなして測る。
    if (chord.midis.length !== previous.midis.length) continue;
    for (const voice of [1, 2]) {
      if (chord.midis[voice] === undefined || previous.midis[voice] === undefined) continue;
      if (Math.abs(chord.midis[voice]! - previous.midis[voice]!) > 7) {
        add('voiceLeading', 'warning', chord.beat, chord.midis[voice]!, '伴奏声部の移動が7半音を超える');
      }
    }
  }
  const loopChords = piece.chords.filter((chord) => chord.beat >= bodyStart);
  for (let bar = 0; bar < piece.bars; bar++) {
    const barStart = bodyStart + bar * 4;
    const barEnd = barStart + 4;
    const barChords = loopChords.filter((chord) => chord.beat >= barStart && chord.beat < barEnd);
    const continuous = barChords.length > 0
      && Math.abs(barChords[0]!.beat - barStart) < 0.001
      && barChords.every((chord, index) => (
        index === 0 || Math.abs(chord.beat - (barChords[index - 1]!.beat + barChords[index - 1]!.dur)) < 0.001
      ))
      && Math.abs(barChords.at(-1)!.beat + barChords.at(-1)!.dur - barEnd) < 0.001;
    if (!continuous) {
      add('harmony', 'error', barStart, -1, `${bar + 1}小節目のコード配置に空白または重複がある`);
    }
  }
  if (loopChords.length > 1) {
    const firstChord = loopChords[0]!;
    const lastChord = loopChords.at(-1)!;
    if (firstChord.midis.length === lastChord.midis.length) {
      for (const voice of [1, 2]) {
        if (firstChord.midis[voice] === undefined || lastChord.midis[voice] === undefined) continue;
        if (Math.abs(firstChord.midis[voice]! - lastChord.midis[voice]!) > 7) {
          add('voiceLeading', 'warning', lastChord.beat, lastChord.midis[voice]!, '伴奏のループ境界が7半音を超える');
        }
      }
    }
    // セカンダリードミナントの解決(III7→vi等)はトークン照合で列挙しない。両端とも
    // dominant→tonic/predominantの機能遷移として2行目が既に数えている。
    const directedTransitions = loopChords.filter((from, index) => {
      const to = loopChords[(index + 1) % loopChords.length]!;
      if (from.function === 'predominant' && to.function === 'dominant') return true;
      if (from.function === 'dominant' && (to.function === 'tonic' || to.function === 'predominant')) return true;
      return from.function === 'tonic' && (to.function === 'predominant' || to.function === 'dominant');
    }).length;
    if (directedTransitions === 0) {
      add('harmony', 'warning', firstChord.beat, -1, 'コード機能の方向づけが見えない');
    }
  }

  for (let index = 0; index < piece.counterMelody.length; index++) {
    const note = piece.counterMelody[index]!;
    if (note.midi < COUNTER_LO || note.midi > COUNTER_HI) {
      add('counterpoint', 'error', note.beat, note.midi, '副旋律が音域外');
    }
    const chord = chordAt(note.beat);
    if (!chord.pcs.includes(note.midi % 12)) {
      const beforeCandidate = piece.counterMelody[index - 1];
      const afterCandidate = piece.counterMelody[index + 1];
      const before = beforeCandidate && note.beat - beforeCandidate.beat <= 0.75 ? beforeCandidate : undefined;
      const after = afterCandidate && afterCandidate.beat - note.beat <= 0.75 ? afterCandidate : undefined;
      const embellishment = after
        ? embellishmentAt(piece, before, note, after, chordAt(after.beat))
        : null;
      if (embellishment && chordAt(after!.beat).pcs.includes(after!.midi % 12)) {
        observations.push({
          beat: note.beat,
          kind: 'embellishment',
          description: `副旋律の${embellishment}として成立`,
          relatedBeats: [before?.beat, after!.beat].filter((beat): beat is number => beat !== undefined),
        });
      } else {
        add('counterpoint', 'warning', note.beat, note.midi, `副旋律の非和声音が ${chord.name} へ解決していない`);
      }
    }
    // 保続ガイドラインは主旋律の下へ敷くロングトーンなので、時間的な重なり自体が意図。
    // 短い応答・独立対旋律では従来どおり同時発音を衝突として扱う。
    if (
      piece.arrangementPlan.counterRole !== 'guideline'
      && piece.melody.some((lead) => lead.beat < note.beat + note.dur && note.beat < lead.beat + lead.dur)
    ) {
      add('counterpoint', 'error', note.beat, note.midi, '主旋律と副旋律の発音が衝突');
    }
  }

  const expectedSections = piece.bars === 40 ? 5 : piece.bars === 16 ? 2 : 1;
  if (piece.songPlan.harmony.length !== piece.bars) {
    add('form', 'error', bodyStart, -1, 'SongPlanの和声設計と曲の小節数が一致しない');
  }
  if (
    piece.songPlan.tonality !== piece.tonality
    || piece.songPlan.melodicLanguage !== piece.melodicLanguage
    || piece.songPlan.grooveFeel !== piece.grooveFeel
  ) {
    add('form', 'error', bodyStart, -1, 'SongPlanと生成結果の作曲意図が一致しない');
  }
  const introPlan = piece.songPlan.intro;
  const hasIntro = piece.introBars > 0;
  if (introPlan.enabled !== hasIntro || introPlan.bars !== piece.introBars || introPlan.role !== piece.introRole) {
    add('form', 'error', 0, -1, 'SongPlanのイントロ設計と生成結果が一致しない');
  }
  if (hasIntro) {
    if (introPlan.barPlans.length !== 2 || bodyStart !== 8) {
      add('form', 'error', 0, -1, 'イントロが2小節の導入フォームとして計画されていない');
    }
    for (const barPlan of introPlan.barPlans) {
      const start = barPlan.bar * 4;
      const actual = piece.chords.filter((chord) => chord.beat >= start && chord.beat < start + 4);
      const tokenMatch = actual.map((chord) => chord.token).join(',') === barPlan.tokens.join(',');
      const durationMatch = actual.length === barPlan.durations.length
        && actual.every((chord, index) => Math.abs(chord.dur - barPlan.durations[index]!) < 0.001);
      if (!tokenMatch || !durationMatch) {
        add('harmony', 'error', start, -1, `イントロ${barPlan.bar + 1}小節目がSongPlanの和声設計と一致しない`);
      }
    }
    const firstBodyChord = piece.chords.find((chord) => chord.beat === bodyStart);
    if (!firstBodyChord || firstBodyChord.token !== introPlan.entryToken) {
      add('harmony', 'error', bodyStart, -1, 'イントロの到達先とA冒頭のコードが一致しない');
    }
    const introChords = piece.chords.filter((chord) => chord.beat < bodyStart);
    if (introChords.length > 0 && introChords.every((chord) => chord.token === introPlan.entryToken)) {
      add('harmony', 'warning', 0, -1, 'イントロがA冒頭と同じ和音だけで足踏みしている');
    }
    const breakStart = bodyStart - introPlan.breakBeats;
    const soundingPastBreak = [
      ...piece.melody.filter((note) => note.beat < bodyStart).map((note) => note.beat + note.dur),
      ...piece.bass.filter((note) => note.beat < bodyStart).map((note) => note.beat + note.dur),
      ...introChords.map((chord) => chord.beat + chord.dur),
    ].some((end) => end > breakStart + 0.001);
    const drumPastBreak = piece.drums.some((drum) => drum.beat < bodyStart && drum.beat >= breakStart - 0.001);
    if (soundingPastBreak || drumPastBreak) {
      add('rhythm', 'error', breakStart, -1, 'イントロのブレイクへ音がはみ出している');
    }
    const introLeadBar0 = piece.melody.filter((note) => note.beat < 4);
    const introLeadBar1 = piece.melody.filter((note) => note.beat >= 4 && note.beat < bodyStart);
    if (introPlan.role === 'groove' && (introLeadBar0.length !== 0 || introLeadBar1.length === 0)) {
      add('texture', 'error', 0, -1, 'グルーヴ提示型でリズム隊から主旋律へ受け渡せていない');
    }
    if (introPlan.role === 'runup' && introLeadBar1.length <= introLeadBar0.length) {
      add('texture', 'error', 4, -1, '駆け上がり型の後半で主旋律が加速していない');
    }
    const firstBodyLead = piece.melody.find((note) => note.beat >= bodyStart && note.role !== 'ornament');
    const lastIntroLead = piece.melody.filter((note) => note.beat < bodyStart).at(-1);
    if (firstBodyLead && lastIntroLead && Math.abs(firstBodyLead.midi - lastIntroLead.midi) > 7) {
      add('melody', 'warning', lastIntroLead.beat, lastIntroLead.midi, 'イントロ末尾からA冒頭への跳躍が7半音を超える');
    }
  }
  for (const harmonyBar of piece.songPlan.harmony) {
    const start = bodyStart + harmonyBar.bar * 4;
    const actual = piece.chords.filter((chord) => chord.beat >= start && chord.beat < start + 4);
    const tokenMatch = actual.map((chord) => chord.token).join(',') === harmonyBar.tokens.join(',');
    const durationMatch = actual.length === harmonyBar.durations.length
      && actual.every((chord, index) => Math.abs(chord.dur - harmonyBar.durations[index]!) < 0.001);
    if (!tokenMatch || !durationMatch) {
      add('harmony', 'error', start, -1, `${harmonyBar.bar + 1}小節目がSongPlanの和声設計と一致しない`);
    }
  }
  if (piece.bars === 8 && piece.songPlan.progressionBars === 4) {
    const first = piece.songPlan.harmony.slice(0, 4).map((bar) => bar.tokens.join('+')).join('|');
    const second = piece.songPlan.harmony.slice(4, 8).map((bar) => bar.tokens.join('+')).join('|');
    if (first === second) {
      add('harmony', 'warning', bodyStart, -1, '8小節の前後半が同じ4小節進行の完全コピーになっている');
    }
  }
  if (piece.bars === 16) {
    const sectionSignatures = [0, 8].map((start) => piece.songPlan.harmony
      .slice(start, start + 8).map((bar) => bar.tokens.join('+')).join('|'));
    if (sectionSignatures[0] === sectionSignatures[1]) {
      add('harmony', 'warning', bodyStart, -1, '16小節のA・Bが同じ8小節進行の完全コピーになっている');
    }
    if (piece.songPlan.progressionBars === 4) {
      for (const start of [0, 8]) {
        const first = piece.songPlan.harmony.slice(start, start + 4).map((bar) => bar.tokens.join('+')).join('|');
        const second = piece.songPlan.harmony.slice(start + 4, start + 8).map((bar) => bar.tokens.join('+')).join('|');
        if (first === second) {
          add('harmony', 'warning', bodyStart + start * 4, -1, '8小節区間の前後半が同じ進行へ固定されている');
        }
      }
    }
  }
  if (piece.bars === 40) {
    const harmonySections = Array.from({ length: 5 }, (_, sectionIndex) => (
      piece.songPlan.harmony
        .slice(sectionIndex * 8, sectionIndex * 8 + 8)
        .map((bar) => bar.tokens.join('+'))
        .join('|')
    ));
    if (new Set(harmonySections).size < 4) {
      add('harmony', 'warning', bodyStart, -1, '40小節の和声が複数セクションで完全コピーになっている');
    }
    const firstPhrases = Array.from({ length: 5 }, (_, sectionIndex) => (
      piece.songPlan.harmony
        .slice(sectionIndex * 8, sectionIndex * 8 + 4)
        .map((bar) => bar.tokens.join('+'))
        .join('|')
    ));
    if (piece.songPlan.progressionBars === 4 && new Set(firstPhrases).size < 3) {
      add('harmony', 'warning', bodyStart, -1, '各セクションの冒頭4小節が同じ進行へ固定されている');
    }
    const rhythmVariants = piece.songPlan.form.sections.map((section) => section.rhythmVariant);
    if (new Set(rhythmVariants).size < 3) {
      add('form', 'warning', bodyStart, -1, '40小節の主旋律リズムが少数の型へ固定されている');
    }
    const externalMotifSources = piece.songPlan.form.sections
      .slice(1)
      .map((section) => section.motifSourceSection)
      .filter((source) => source !== null);
    if (externalMotifSources.length >= 3 && new Set(externalMotifSources).size === 1) {
      add('form', 'warning', bodyStart, -1, '複数の展開区間がすべて同じモチーフ区間だけを参照している');
    }
    if (new Set(piece.songPlan.form.sections.map((section) => section.energy)).size < 3) {
      add('form', 'warning', bodyStart, -1, '40小節のエネルギー設計に十分な起伏がない');
    }
  }
  for (const section of piece.songPlan.form.sections) {
    if (new Set(section.phraseRhythmVariants).size < 2) {
      add('form', 'warning', bodyStart + section.startBar * 4, -1, `${section.id}の全フレーズが同じリズム型へ固定されている`);
    }
  }
  // リテラル帰還(literal)のペアは、フレーズ0の類似が装置そのものなので除外して測る。
  const literalReturnPairs = new Set(piece.songPlan.form.sections
    .filter((section) => section.motifTransform === 'literal' && section.motifSourceSection !== null)
    .map((section) => {
      const source = piece.songPlan.form.sections.find(
        (candidate) => candidate.id === section.motifSourceSection,
      );
      return source ? `${source.index}:${section.index}` : '';
    }));
  const excessiveMelodicCopies = melodicSectionSimilarities(piece).filter((comparison) => {
    const scores = literalReturnPairs.has(`${comparison.firstSection}:${comparison.secondSection}`)
      ? comparison.phraseScores.slice(1)
      : comparison.phraseScores;
    const average = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
    return scores.filter((score) => score >= 0.84).length >= 3 || average >= 0.88;
  });
  for (const comparison of excessiveMelodicCopies) {
    const first = piece.songPlan.form.sections[comparison.firstSection]?.id ?? comparison.firstSection + 1;
    const second = piece.songPlan.form.sections[comparison.secondSection]?.id ?? comparison.secondSection + 1;
    add(
      'melody',
      'warning',
      bodyStart + comparison.secondSection * 8 * 4,
      -1,
      `${first}と${second}の旋律が、完全一致ではないがリズムと輪郭の似たフレーズへ収束している`,
    );
  }
  // フック反復の下限（記憶性の反転診断）: 記憶性はリテラル反復が担う。提示(フレーズ0)と
  // 変奏反復(フレーズ1)、およびリテラル帰還は、同じ実音図形として聴こえる程度に
  // 似ていなければならない。表現デバイスが意図してリズムを変えた小節は対象外。
  const phraseModifiedByDevice = (startBar: number, bars = 2): boolean => (
    piece.phrasePlan.bars.slice(startBar, startBar + bars).some((plan) => (
      plan.counterSteps.length > 0
      || plan.longToneStep !== null
      || plan.anchorTie
      || plan.anacrusis
      || plan.restStart
      || plan.sustainedEntry
      || plan.ornamentType !== null
      || plan.cadence === 'turnaround'
      || plan.bar === piece.phrasePlan.climaxBar
      || plan.bar === piece.phrasePlan.signatureLeapBar
    ))
  );
  if (piece.bars >= 8) {
    for (const section of piece.songPlan.form.sections) {
      if (section.bars < 8) continue;
      // 提示が外部借用(リテラル帰還等でリズム族が異なる)区間は、区間内の反復類似を要求しない。
      if (section.externalMotifPhrases.includes(0)) continue;
      // デバイスが答句だけを変えた場合は問い小節1小節で比較する(2小節要求のままだと
      // 免責が広すぎて検査がほとんど眠る)。問い側まで変えられていたら対象外。
      const fullClean = !phraseModifiedByDevice(section.startBar)
        && !phraseModifiedByDevice(section.startBar + 2);
      const promptClean = !phraseModifiedByDevice(section.startBar, 1)
        && !phraseModifiedByDevice(section.startBar + 2, 1);
      if (!fullClean && !promptClean) continue;
      const hookWindow = fullClean ? 2 : 1;
      if (melodicPhraseSimilarity(piece, section.startBar, section.startBar + 2, hookWindow) < 0.6) {
        add(
          'melody', 'warning', bodyStart + (section.startBar + 2) * 4, -1,
          `${section.id}の変奏反復が提示のフックを反復として聴かせていない`,
        );
      }
    }
    for (const section of piece.songPlan.form.sections) {
      if (section.motifTransform !== 'literal' || section.motifSourceSection === null) continue;
      const source = piece.songPlan.form.sections.find(
        (candidate) => candidate.id === section.motifSourceSection,
      );
      const returnPhrase = section.externalMotifPhrases[0];
      if (!source || returnPhrase === undefined) continue;
      const returnBar = section.startBar + returnPhrase * 2;
      // 回収フレーズの答句がターンアラウンド(16小節Bの結論等)なら、ループ渡しが
      // 優先されるため問い小節1小節だけで帰還を測る(2小節要求だと常に免責されて
      // 検査がデッドコードになる)。
      const windowBars = piece.phrasePlan.bars[returnBar + 1]?.cadence === 'turnaround' ? 1 : 2;
      if (
        phraseModifiedByDevice(source.startBar, windowBars)
        || phraseModifiedByDevice(returnBar, windowBars)
      ) continue;
      if (melodicPhraseSimilarity(piece, source.startBar, returnBar, windowBars) < 0.5) {
        add(
          'form', 'warning', bodyStart + returnBar * 4, -1,
          `${section.id}の主題帰還が${source.id}のフックとして聴こえない`,
        );
      }
    }
  }
  const climaxSection = piece.songPlan.form.sections.find((section) => (
    piece.phrasePlan.climaxBar >= section.startBar
    && piece.phrasePlan.climaxBar < section.startBar + section.bars
  ));
  const peakSectionEnergy = Math.max(...piece.songPlan.form.sections.map((section) => section.energy));
  if (climaxSection && climaxSection.energy < peakSectionEnergy) {
    add('form', 'warning', bodyStart + piece.phrasePlan.climaxBar * 4, -1, 'クライマックスが低エネルギー区間へ固定されている');
  }
  const textureSections = piece.arrangementPlan.sections;
  if (textureSections.length !== expectedSections) {
    add('texture', 'error', bodyStart, -1, '編成設計の区間数がフォームと一致しない');
  }
  if (textureSections.length > 1) {
    const signatures = textureSections.map((section) => [
      section.backingDensity,
      section.echo ? 'echo' : '-',
      section.counterDensity,
      section.ostinatoDensity,
      section.drum,
      section.entrance,
      section.exitFill,
      section.ostinatoPeak ?? '-',
    ].join(':'));
    if (new Set(signatures).size < 2) {
      add('texture', 'warning', bodyStart, -1, '全セクションの編成が同一で、出し引きがない');
    }
  }
  textureSections.forEach((section, sectionIndex) => {
    const optionalLayers = Number(section.echo)
      + Number(section.counterDensity > 0)
      + Number(section.ostinatoDensity > 0);
    if (textureSections.length > 1 && optionalLayers > 1) {
      add(
        'texture', 'warning', bodyStart + sectionIndex * 8 * 4, -1,
        'エコー・対旋律・分散和音が同一区間で足し算になっている',
      );
    }
    const sectionStart = bodyStart + sectionIndex * (piece.bars === 40 ? 8 : piece.bars === 16 ? 8 : piece.bars) * 4;
    const sectionEnd = sectionStart + (piece.bars === 40 || piece.bars === 16 ? 8 : piece.bars) * 4;
    if (
      section.counterDensity > 0
      && !piece.counterMelody.some((note) => note.beat >= sectionStart && note.beat < sectionEnd)
    ) {
      add('texture', 'warning', sectionStart, -1, '副旋律を計画した区間に実音が生成されていない');
    }
    if (
      section.ostinatoDensity > 0
      && !piece.ostinato.some((note) => note.beat >= sectionStart && note.beat < sectionEnd)
    ) {
      add('texture', 'warning', sectionStart, -1, '分散和音を計画した区間に実音が生成されていない');
    }
  });
  const deviceCoverage = [
    ['エコー', textureSections.filter((section) => section.echo).length],
    ['対旋律', textureSections.filter((section) => section.counterDensity > 0).length],
    ['分散和音', textureSections.filter((section) => section.ostinatoDensity > 0).length],
  ] as const;
  for (const [label, coverage] of deviceCoverage) {
    if (textureSections.length > 1 && coverage === textureSections.length) {
      add('texture', 'warning', bodyStart, -1, `${label}が全セクションに貼り付いている`);
    } else if (textureSections.length >= 5 && coverage > 3) {
      add('texture', 'warning', bodyStart, -1, `${label}の使用区間が多く、対比を弱めている`);
    }
  }
  if (
    textureSections.length >= 5
    && textureSections.slice(0, -1).every((section) => section.exitFill === 'full')
  ) {
    add('rhythm', 'warning', bodyStart, -1, '全セクション境界へ同じフルフィルが固定されている');
  }
  const ostinatoPeaks = textureSections
    .filter((section) => section.ostinatoDensity > 0)
    .map((section) => section.ostinatoPeak);
  if (ostinatoPeaks.length > 1 && new Set(ostinatoPeaks).size === 1) {
    add('texture', 'warning', bodyStart, -1, '分散和音の加速位置が全区間で同じ役割へ固定されている');
  }
  if (piece.arrangementPlan.bassRole === 'pedal' && piece.arrangementPlan.textureStrategy !== 'bassDrive') {
    add('texture', 'warning', bodyStart, -1, 'ペダル低音が低音主導以外の編成へ常設されている');
  }
  if (
    !capabilitiesFor(piece.songPlan.soundChip).independentArpeggio
    && (piece.ostinato.length > 0 || textureSections.some((section) => section.ostinatoDensity > 0))
  ) {
    add('texture', 'error', bodyStart, -1, '声部予算を超える独立分散和音が計画されている');
  }
  if (
    textureSections.some((section) => section.ostinatoTuplet !== null)
    && !allowsTupletOverlay(piece.grooveFeel)
  ) {
    add('rhythm', 'error', bodyStart, -1, '三連オーバーレイと連符レイヤーが同一曲へ計画されている');
  }
  textureSections.forEach((section, sectionIndex) => {
    const sectionStart = bodyStart + sectionIndex * (piece.bars === 40 ? 8 : piece.bars === 16 ? 8 : piece.bars) * 4;
    const sectionEnd = sectionStart + (piece.bars === 40 || piece.bars === 16 ? 8 : piece.bars) * 4;
    for (const note of piece.ostinato) {
      if (note.beat < sectionStart || note.beat >= sectionEnd) continue;
      const offsetInBar = (note.beat - bodyStart) % 4;
      if (section.ostinatoTuplet !== null) {
        // 連符レイヤーの打点は宣言グリッド（半小節をdiv等分）へ正確に乗る。
        const steps = offsetInBar * section.ostinatoTuplet / 2;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) {
          add('rhythm', 'error', note.beat, -1, '連符レイヤーの打点が宣言グリッドから外れている');
        }
      } else {
        // 基準面は8分/16分（bounceの2/3含む）から動かない。連符化の漏れ出しを検出する。
        const steps = offsetInBar * 12;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) {
          add('rhythm', 'error', note.beat, -1, '分散和音の打点が基準グリッドから外れている');
        }
      }
    }
  });

  if (piece.phrasePlan.bars.length !== piece.bars) {
    add('form', 'error', bodyStart, -1, 'PhrasePlanと曲の小節数が一致しない');
  }
  for (const barPlan of piece.phrasePlan.bars) {
    const expectedSteps = barPlan.rhythm
      .map((on, step) => on ? step : -1)
      .filter((step) => step >= 0);
    const actualSteps = piece.melody
      .filter((note) => (
        note.role !== 'ornament'
        && note.beat >= bodyStart + barPlan.bar * 4
        && note.beat < bodyStart + (barPlan.bar + 1) * 4
      ))
      .map((note) => Math.round((note.beat - bodyStart - barPlan.bar * 4) * 2));
    if (expectedSteps.join(',') !== actualSteps.join(',')) {
      add('rhythm', 'error', bodyStart + barPlan.bar * 4, -1, `${barPlan.bar + 1}小節目がPhrasePlanのリズムと不一致`);
    }
    if (!actualSteps.includes(0)) {
      // 意図した休符始まり、または前小節のロングトーンが頭拍を覆う小節は頭打ちを要求しない。
      const barStartBeat = bodyStart + barPlan.bar * 4;
      const coveredBySustain = barPlan.sustainedEntry && piece.melody.some((note) => (
        note.role !== 'ornament' && note.beat < barStartBeat && note.beat + note.dur >= barStartBeat + 0.25
      ));
      if (!barPlan.restStart && !coveredBySustain) {
        add('rhythm', 'error', barStartBeat, -1, `${barPlan.bar + 1}小節目の強拍に主旋律がない`);
      }
    }
    if (!actualSteps.includes(4)) {
      // 半小節タイ(anchorTie)の小節は、直前の発音が3拍目を跨いで保続していれば頭打ち不要。
      // ただし保続音は先取音の定義どおり、跨いだ先(3拍目時点)の和音の構成音であること。
      const anchorBeat = bodyStart + barPlan.bar * 4 + 2;
      const tieNote = barPlan.anchorTie
        ? piece.melody.find((note) => (
          note.role !== 'ornament'
          && note.beat < anchorBeat
          && note.beat + note.dur >= anchorBeat + 0.25
        ))
        : undefined;
      if (!tieNote) {
        add('rhythm', 'error', bodyStart + barPlan.bar * 4, -1, `${barPlan.bar + 1}小節目の強拍に主旋律がない`);
      } else if (!chordAt(anchorBeat).pcs.includes(tieNote.midi % 12)) {
        add('harmony', 'error', anchorBeat, tieNote.midi, `${barPlan.bar + 1}小節目の3拍目を跨ぐタイが和声音でない`);
      }
    }
    if (barPlan.targetStep === null || barPlan.targetPc === null) continue;
    const targetBeat = bodyStart + grooveBeat(
      barPlan.bar * 4 + barPlan.targetStep * 0.5,
      piece.grooveFeel,
    );
    const target = piece.melody.find((note) => Math.abs(note.beat - targetBeat) < 0.001);
    if (!target || target.midi % 12 !== barPlan.targetPc) {
      add('form', 'error', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目が終止目標へ未到達`);
    }
    const targetChord = chordAt(targetBeat);
    if (barPlan.cadence === 'half' && targetChord.function !== 'dominant') {
      add('harmony', 'warning', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目の半終止がドミナント機能ではない`);
    }
    if (barPlan.cadence === 'closed' && targetChord.function !== 'tonic') {
      add('harmony', 'warning', targetBeat, target?.midi ?? -1, `${barPlan.bar + 1}小節目の完全終止がトニック機能ではない`);
    }
  }

  const pedalPcs = piece.arrangementPlan.bassRole === 'pedal'
    ? [piece.keyRoot % 12, (piece.keyRoot + 7) % 12]
    : [];
  for (let index = 0; index < piece.bass.length; index++) {
    const note = piece.bass[index]!;
    if (note.beat < bodyStart) continue;
    const chord = chordAt(note.beat);
    if (chord.pcs.includes(note.midi % 12)) continue;
    // 曲全体で低音主導を選んだ場合のペダル低音（主音とその5度）は、意図した保続音であり経過音ではない。
    if (pedalPcs.includes(note.midi % 12)) continue;
    // 分数コード(bassDegrees→bassPc)のベースは意図した転回・半音経過であり、経過音違反ではない。
    if (chord.bassPc !== undefined && note.midi % 12 === chord.bassPc) continue;
    const inBar = note.beat % 1;
    const next = piece.bass[index + 1] ?? piece.bass.find((candidate) => candidate.beat >= bodyStart);
    const nextChordBeat = next === piece.bass[index + 1] ? next?.beat ?? note.beat : bodyStart;
    const nextChord = chordAt(nextChordBeat);
    // 解決先は次コードでベースが実際に弾く音(分数コードならbassPc、通常はルート)。
    const nextAnchorPc = nextChord.bassPc ?? (CHORDS[nextChord.token]!.root + piece.keyRoot) % 12;
    // ピックアップの正位置は「8分裏をグルーヴ格子へ写した位置」(スウィング軸に追随)。
    const pickupPosition = grooveBeat(0.5, piece.grooveFeel);
    if (Math.abs(inBar - pickupPosition) > 0.001 || !next || next.midi % 12 !== nextAnchorPc) {
      add('harmony', 'warning', note.beat, note.midi, 'ベースの経過音が弱拍から次コードの根音へ解決していない');
    }
  }

  if (bodyMelody.length > 1) {
    const first = bodyMelody[0]!.note;
    const last = bodyMelody.at(-1)!.note;
    if (Math.abs(first.midi - last.midi) > 7) {
      add('loop', 'warning', last.beat, last.midi, '主旋律のループ境界が7半音を超える');
    }
  }
  const lastPlan = piece.phrasePlan.bars.at(-1);
  if (!lastPlan || lastPlan.cadence !== 'turnaround') {
    add('loop', 'error', piece.beats, -1, 'ループ終端にターンアラウンド設計がない');
  }

  const scores = Object.fromEntries(categories.map((category) => {
    const score = issues
      .filter((issue) => issue.category === category)
      .reduce((value, issue) => value - (issue.severity === 'error' ? 20 : 7), 100);
    return [category, Math.max(0, score)];
  })) as Record<DiagnosticCategory, number>;
  const overall = Math.round(categories.reduce((sum, category) => sum + scores[category], 0) / categories.length);
  const categoryStatus = Object.fromEntries(categories.map((category) => {
    const categoryIssues = issues.filter((issue) => issue.category === category);
    const status = categoryIssues.some((issue) => issue.severity === 'error')
      ? 'error'
      : categoryIssues.length > 0 ? 'attention' : 'pass';
    return [category, status];
  })) as CompositionReport['categoryStatus'];
  const status = issues.some((issue) => issue.severity === 'error')
    ? 'error'
    : issues.length > 0 ? 'attention' : 'pass';
  return { status, categoryStatus, overall, scores, issues, observations };
}

function chordAtInPiece(piece: Piece, beat: number): ChordEvent {
  let current = piece.chords[0]!;
  for (const chord of piece.chords) {
    if (chord.beat <= beat) current = chord;
    else break;
  }
  return current;
}

function protectedMelodyNote(piece: Piece, note: NoteEvent): boolean {
  if (note.role === 'ornament' || note.ornament !== undefined) return true;
  const relative = note.beat - piece.loopStartBeat;
  if (relative < 0) return true;
  const bar = Math.min(piece.bars - 1, Math.max(0, Math.floor(relative / 4)));
  if (bar === piece.phrasePlan.climaxBar && Math.abs(relative - bar * 4) < 0.001) return true;
  const plan = piece.phrasePlan.bars[bar]!;
  if (plan.targetStep === null) return false;
  const targetBeat = piece.loopStartBeat + grooveBeat(
    bar * 4 + plan.targetStep * 0.5,
    piece.grooveFeel,
  );
  return Math.abs(note.beat - targetBeat) < 0.001;
}

function midiCandidates(pcs: readonly number[], around: number): number[] {
  return Array.from({ length: MELODY_HI - MELODY_LO + 1 }, (_, offset) => MELODY_LO + offset)
    .filter((midi) => midi !== around && pcs.includes(midi % 12))
    .sort((a, b) => Math.abs(a - around) - Math.abs(b - around));
}

function applyMelodyEdit(notes: readonly NoteEvent[], edit: MelodyEdit): NoteEvent[] {
  const result = notes.map((note) => ({ ...note }));
  const target = result.find((note) => (
    Math.abs(note.beat - edit.beat) < 0.001 && note.midi === edit.fromMidi
  ));
  if (target) target.midi = edit.toMidi;
  return result;
}

/** 診断1件へ、再診断で悪化しないことを確認した最小の旋律修正を提案する。 */
export function suggestCompositionRepair(
  piece: Piece,
  issue: CompositionIssue,
): CompositionRepair | null {
  if (!issue.code || !issue.target || issue.target.part !== 'melody') return null;
  const target = piece.melody[issue.target.noteIndex];
  if (!target) return null;
  const structural = piece.melody
    .map((note, noteIndex) => ({ note, noteIndex }))
    .filter(({ note }) => note.beat >= piece.loopStartBeat && note.role !== 'ornament');
  const position = structural.findIndex(({ noteIndex }) => noteIndex === issue.target!.noteIndex);
  if (position < 0) return null;
  const before = structural[position - 1];
  const after = structural[position + 1];
  const candidates: { edit: MelodyEdit; strategy: CompositionRepair['strategy']; priority: number }[] = [];

  if (issue.code === 'melody-unresolved-nonchord') {
    if (after && !protectedMelodyNote(piece, after.note)) {
      const nextChord = chordAtInPiece(piece, after.note.beat);
      for (const midi of midiCandidates(nextChord.pcs, after.note.midi)) {
        if (!isMelodicStep(piece, target.midi, midi)) continue;
        candidates.push({
          edit: { beat: after.note.beat, fromMidi: after.note.midi, toMidi: midi },
          strategy: 'resolve-next',
          priority: Math.abs(midi - after.note.midi),
        });
      }
    }
    if (!protectedMelodyNote(piece, target)) {
      const chord = chordAtInPiece(piece, target.beat);
      for (const midi of midiCandidates(chord.pcs, target.midi)) {
        candidates.push({
          edit: { beat: target.beat, fromMidi: target.midi, toMidi: midi },
          strategy: 'stabilize-note',
          priority: 20 + Math.abs(midi - target.midi),
        });
      }
    }
  }

  if (issue.code === 'melody-large-leap' && before && !protectedMelodyNote(piece, target)) {
    const relative = target.beat - piece.loopStartBeat;
    const inBar = ((relative % 4) + 4) % 4;
    const strong = Math.abs(inBar) < 0.001 || Math.abs(inBar - 2) < 0.001;
    const chord = chordAtInPiece(piece, target.beat);
    const collection = piece.melodicScalePcs;
    const allowedPcs = strong ? chord.pcs : collection;
    for (const midi of midiCandidates(allowedPcs, target.midi)) {
      if (Math.abs(midi - before.note.midi) > 9) continue;
      candidates.push({
        edit: { beat: target.beat, fromMidi: target.midi, toMidi: midi },
        strategy: 'reduce-leap',
        priority: Math.abs(midi - target.midi),
      });
    }
  }

  const baseline = diagnosePiece(piece);
  const baselineErrors = baseline.issues.filter((candidate) => candidate.severity === 'error').length;
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) {
    const repaired: Piece = { ...piece, melody: applyMelodyEdit(piece.melody, candidate.edit) };
    const report = diagnosePiece(repaired);
    const targetRemains = report.issues.some((nextIssue) => (
      nextIssue.code === issue.code && Math.abs(nextIssue.beat - issue.beat) < 0.001
    ));
    const errorCount = report.issues.filter((nextIssue) => nextIssue.severity === 'error').length;
    if (
      !targetRemains
      && errorCount <= baselineErrors
      && report.issues.length < baseline.issues.length
      && report.overall >= baseline.overall
    ) {
      return { edit: candidate.edit, strategy: candidate.strategy };
    }
  }
  return null;
}

/** 後方互換用の厳格検証。診断レポート中、生成上のエラーだけを返す。 */
export function validatePiece(piece: Piece): Violation[] {
  return diagnosePiece(piece).issues
    .filter((issue) => issue.severity === 'error')
    .map(({ beat, midi, reason }) => ({ beat, midi, reason }));
}

/** 品質採点ではなく、生成規則・フォーム・声部の構造的不整合を調べる公開名。 */
export const checkPieceStructure = diagnosePiece;
export type StructuralReport = CompositionReport;
export type StructuralIssue = CompositionIssue;

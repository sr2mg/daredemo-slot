/**
 * 主旋律の実音化: 実音テーマの確定 → フレーズアンカーの事前計画 →
 * テーマの反復・引用・ゼクエンツ展開（+ 装飾・弱起の後埋め）。
 * 乱数は使わない（テーマ抽選は phrase-plan、シードのビット読みは順序非依存）。
 */

import { fragmentOf, invertTheme, realizeDegree, themeDegreeSpan, themeFromGesture, transposeTheme } from './melodic-theme.js';
import type { ThemeSpec } from './melodic-theme.js';
import { grooveBeat } from './groove.js';
import { bridgeWithPc, nearestWithPc, stepOnScale } from './pitch.js';
import { MELODY_HI, MELODY_LO } from './theory.js';
import type { ComposeContext } from './compose-context.js';
import type { NoteArticulation, NoteEvent } from './types.js';

export function generateMelody(ctx: ComposeContext): NoteEvent[] {
  const {
    opts, style, melodicLanguage, scalePcs, grooveFeel, songPlan, phrasePlan, phraseGestures,
    chordAt, scaleAt, melodyPcsForChord, startMidi, climaxMidi, baseCenter, scaleStepMax,
  } = ctx;
  // --- 実音テーマ（melodic-theme.ts） ---
  // 区間ごとに、ジェスチャーと提示リズム族から「音度列×16ステップ」の具体的テーマを
  // 一度だけ確定する。以後の反復・引用・展開はすべてこの度数列からの決定論的導出で、
  // 「反復のたびに毎音を和声へ吸着して音程が変異する」従来方式をやめる
  // （和声へ合わせるのはアンカーと強拍だけ）。
  const sectionThemes: ThemeSpec[] = songPlan.form.sections.map((section, index) => {
    const family = phrasePlan.rhythmFamilies[section.phraseRhythmVariants[0]]!;
    return themeFromGesture(phraseGestures[index]!, family[0], family[1]);
  });
  // 借用フレーズが実現するテーマ。literal=原形(フックの帰還)、transpose=全音度移調
  // (トーナルアンサー)、invert=輪郭反転。フレーズ0が外部借用の区間は、区間全体が
  // その主題を展開する(提示した主題を変奏反復・展開・結論が受け継ぐSRDCの一貫性)。
  // 借用元には「その区間で実際に鳴った主題」(activeTheme)を使う。B自身がAを借用して
  // いる場合、EがBを引用するとき聴いたことのないBの潜在テーマではなく、
  // 実際に聴こえたAの変形を引き継ぐ(主題の回帰は聴取可能でなければ意味がない)。
  const borrowedThemes: (ThemeSpec | null)[] = [];
  const activeThemes: ThemeSpec[] = [];
  for (const [sectionIndex, section] of songPlan.form.sections.entries()) {
    let borrowed: ThemeSpec | null = null;
    const source = section.motifSourceSection === null
      ? undefined
      : songPlan.form.sections.find((candidate) => candidate.id === section.motifSourceSection);
    // 借用元は常に先行区間(A<B<...)なので activeThemes[source.index] は確定済み。
    const sourceTheme = source ? activeThemes[source.index] : undefined;
    if (sourceTheme) {
      if (section.motifTransform === 'invert') borrowed = invertTheme(sourceTheme);
      else if (section.motifTransform === 'transpose') {
        const magnitude = ((opts.seed >>> (7 + section.index)) & 1) === 0 ? 1 : 2;
        const direction = ((opts.seed >>> (11 + section.index)) & 1) === 0 ? 1 : -1;
        borrowed = transposeTheme(sourceTheme, magnitude * direction);
      } else borrowed = sourceTheme;
    }
    borrowedThemes.push(borrowed);
    activeThemes.push(
      section.externalMotifPhrases.includes(0) && borrowed !== null
        ? borrowed
        : sectionThemes[sectionIndex]!,
    );
  }

  // --- フレーズアンカーの事前計画 ---
  // テーマは実音の図形なので、音域とクライマックス一意性は「音を潰すクランプ」ではなく
  // アンカーの置き場所で解決する(テーマの頂点がクライマックス未満へ収まるまでアンカーを
  // 下げる)。変奏反復は提示のアンカーを継いでフックをリテラルに繰り返し(平行ピリオド)、
  // リテラル帰還は元フレーズのアンカー(=実音高)を継ぐ。
  const pairCount = Math.ceil(opts.bars / 2);
  const climaxPair = phrasePlan.climaxBar >> 1;
  const phraseAnchors: number[] = [];
  const sectionStartAnchors: number[] = [];
  for (let pair = 0; pair < pairCount; pair++) {
    const pairBar = pair * 2;
    const pairPlan = phrasePlan.bars[pairBar]!;
    const pairSection = songPlan.form.sections.find((section) => section.id === pairPlan.section)!;
    const pairPhraseIndex = (['statement', 'restatement', 'departure', 'conclusion'] as const)
      .indexOf(pairPlan.phraseFunction) as 0 | 1 | 2 | 3;
    const pairBorrows = pairSection.externalMotifPhrases.includes(pairPhraseIndex)
      && borrowedThemes[pairSection.index] !== null;
    const pairTheme = pairBorrows ? borrowedThemes[pairSection.index]! : activeThemes[pairSection.index]!;
    const pairChordPcs = melodyPcsForChord(chordAt(pairBar * 4));
    const returnRegister = songPlan.compositionPolicy.melody.returnRegister;
    const appliesReturnRegister = pairBorrows
      && returnRegister !== null
      && pairSection.id === returnRegister.to
      && pairSection.motifSourceSection === returnRegister.from;
    if (pairBorrows && pairSection.motifTransform === 'literal') {
      const sourcePair = Math.floor(pairPlan.motifSourceBar / 2);
      let anchor = phraseAnchors[sourcePair] ?? startMidi;
      if (appliesReturnRegister) anchor = nearestWithPc(anchor + returnRegister!.offset, pairChordPcs);
      phraseAnchors.push(anchor);
      // リテラル帰還は元区間と同音で入るのが装置(区間頭記録は重複回避の対象外)。
      if (pairBar === pairSection.startBar) sectionStartAnchors[pairSection.index] = anchor;
      continue;
    }
    if (pairPlan.phraseFunction === 'restatement' && pair > 0) {
      phraseAnchors.push(phraseAnchors[pair - 1]!);
      continue;
    }
    // クライマックス区間ではフレーズアンカーを段階的に上げ、頂点へ登る。
    const containsClimax = phrasePlan.climaxBar >= pairSection.startBar
      && phrasePlan.climaxBar < pairSection.startBar + pairSection.bars;
    const lift = containsClimax && pair <= climaxPair ? Math.max(0, 2 - (climaxPair - pair)) : 0;
    const center = baseCenter + pairPlan.energy - 2 + pairPlan.registerOffset + lift;
    let anchor = nearestWithPc(center, pairChordPcs);
    if (appliesReturnRegister) anchor = nearestWithPc(anchor + returnRegister!.offset, pairChordPcs);
    const span = themeDegreeSpan(pairTheme);
    const ceiling = pair === climaxPair ? MELODY_HI : climaxMidi - 1;
    for (let guard = 0; guard < 24; guard++) {
      if (realizeDegree(anchor, span.max, scalePcs, 0, 127) <= ceiling) break;
      anchor = stepOnScale(anchor, -1, scalePcs);
    }
    for (let guard = 0; guard < 12; guard++) {
      if (realizeDegree(anchor, span.min, scalePcs, 0, 127) >= MELODY_LO
        || realizeDegree(anchor, span.max, scalePcs, 0, 127) > ceiling) break;
      anchor = stepOnScale(anchor, 1, scalePcs);
    }
    anchor = nearestWithPc(anchor, pairChordPcs);
    // 区間頭は直前区間の頭と同音で入らない。区間の入りが同じ音で並ぶとフォームの
    // 分節と対比が聴こえない(リテラル帰還だけは同音こそが装置なので上の分岐)。
    // 比較はアンカーでなく「step0が実際に鳴る音」で行う。移調テーマは度数列自体が
    // シフトされているため、アンカーだけ見ても強拍スナップ後に同音へ戻ることがある。
    const startDegree = pairTheme.degreeByStep[0] ?? 0;
    const realizedStartFor = (candidateAnchor: number): number => {
      const raw = realizeDegree(candidateAnchor, startDegree, scalePcs, MELODY_LO, MELODY_HI);
      return pairChordPcs.includes(((raw % 12) + 12) % 12) ? raw : nearestWithPc(raw, pairChordPcs);
    };
    if (pairBar === pairSection.startBar && pairSection.index > 0) {
      const previousStart = sectionStartAnchors[pairSection.index - 1];
      if (previousStart !== undefined && realizedStartFor(anchor) === previousStart) {
        const direction = pairPlan.registerOffset >= 0 ? 1 : -1;
        // 音域端では±3半音内に別の和声音がないことがあるため、±5まで広げて探す。
        const displaced = [3, -3, 5, -5]
          .map((offset) => nearestWithPc(anchor + direction * offset, pairChordPcs))
          .find((candidate) => realizedStartFor(candidate) !== previousStart);
        if (displaced !== undefined) anchor = displaced;
      }
    }
    if (pairBar === pairSection.startBar) {
      sectionStartAnchors[pairSection.index] = realizedStartFor(anchor);
    }
    phraseAnchors.push(anchor);
  }

  // --- 主旋律（実音テーマの反復・引用・ゼクエンツ展開） ---
  const melody: NoteEvent[] = [];
  let prev = startMidi;
  let prevBeat = 0;
  let pendingAppoggiaturaResolution: number | null = null;
  let lastSequenceHead: number | null = null;
  let signatureLeapPending = false;
  let signatureStepBack: 1 | -1 | null = null;
  for (const barPlan of phrasePlan.bars) {
    const { bar } = barPlan;
    const barInSection = opts.bars >= 16 ? bar % 8 : bar;
    // 4小節フォームは1小節=1機能のSRDCなので、毎小節テーマの前半(問い)を実現する
    // (提示→リテラル反復→展開→結論の8ステップ版。フックが4小節で3回聴こえる)。
    const phraseStepOffset = opts.bars === 4 ? 0 : (barInSection % 2) * 8;
    const center = bar === phrasePlan.climaxBar
      ? MELODY_HI - 2
      : baseCenter + barPlan.energy - 2 + barPlan.registerOffset;
    const onsets: number[] = [];
    barPlan.rhythm.forEach((on, step) => on && onsets.push(step));
    const sectionDesign = songPlan.form.sections.find((section) => section.id === barPlan.section)!;
    const borrowsExternalMotif = barPlan.motifSourceBar < sectionDesign.startBar
      || barPlan.motifSourceBar >= sectionDesign.startBar + sectionDesign.bars;
    const barTheme = borrowsExternalMotif && borrowedThemes[sectionDesign.index] !== null
      ? borrowedThemes[sectionDesign.index]!
      : activeThemes[sectionDesign.index]!;
    const barAnchor = phraseAnchors[bar >> 1] ?? startMidi;
    // ゼクエンツ用の断片と方向。クライマックスが前方にあれば上行で頂点へ向かう。
    const sequenceFragment = fragmentOf(barTheme, 'tail');
    const sequenceAscending = phrasePlan.climaxBar > bar
      || (phrasePlan.climaxBar < bar && ((opts.seed >>> (5 + sectionDesign.index)) & 1) === 0);
    pendingAppoggiaturaResolution = null;
    if (barPlan.phraseFunction !== 'departure' || barInSection % 2 === 0) lastSequenceHead = null;

    for (let index = 0; index < onsets.length; index++) {
      const step = onsets[index]!;
      const logicalBeat = bar * 4 + step * 0.5;
      const beat = grooveBeat(logicalBeat, grooveFeel);
      const chord = chordAt(logicalBeat);
      const structuralPcs = melodyPcsForChord(chord);
      const strong = step === 0 || step === 4;
      const phraseStep = phraseStepOffset + step;
      let midi: number;
      let resolvedAppoggiatura = false;
      if (bar === phrasePlan.climaxBar && step === 0) {
        midi = climaxMidi;
      } else if (barPlan.targetStep === step && barPlan.targetPc !== null) {
        // 応答小節は、先に決めた終止音（終止音度の物語）へ実際に到達させる。
        if (barPlan.cadence === 'turnaround') {
          // ループの渡し先は固定のstartMidiでなく、実際のA冒頭アンカーへ合わせる。
          midi = nearestWithPc(phraseAnchors[0] ?? startMidi, [barPlan.targetPc]);
        } else if (bar + 1 === phrasePlan.climaxBar) {
          midi = bridgeWithPc(prev, climaxMidi, [barPlan.targetPc], MELODY_LO, climaxMidi - 1);
        } else {
          // クライマックス未満で束縛する。天井近くの候補を選んでから後段のクランプで
          // 1オクターブ落とすと、終止への跳躍が突然11半音級になる。
          midi = nearestWithPc(
            prev + Math.round((center - prev) / 2), [barPlan.targetPc], MELODY_LO, climaxMidi - 1,
          );
        }
      } else if (pendingAppoggiaturaResolution !== null) {
        // 倚音の解決音（強拍で保持した非和声音を2度の和声音で受ける）。
        midi = pendingAppoggiaturaResolution;
        resolvedAppoggiatura = true;
      } else if (bar === phrasePlan.climaxBar && index === 1 && onsets[0] === 0) {
        // クライマックスの受け: 頂点の直後は反行順次で降りる（均衡跳躍の古典則）。
        midi = stepOnScale(prev, -1, scaleAt(chord));
      } else if (barPlan.anacrusis && step === 7) {
        // 弱起: 次フレーズのアンカー（クライマックス小節なら頂点音）の2度下から掛かる。
        const nextAnchor = bar + 1 === phrasePlan.climaxBar
          ? climaxMidi
          : phraseAnchors[(bar + 1) >> 1] ?? barAnchor;
        midi = stepOnScale(nextAnchor, -1, scaleAt(chord));
      } else if (barPlan.phraseFunction === 'departure' && !borrowsExternalMotif) {
        // ゼクエンツ: テーマ末尾断片を半小節ごとに2度ずつ移して繰り返す
        // (断片化→反復進行→終止のリキダーションというセンテンス構文の展開)。
        // 強拍に落ちる断片音は直後の強拍規則で和声へ量子化されるが、弱拍の断片音と
        // ランプの輪郭が「同じ材料が動いていく」知覚を残す。
        const groupStart = (step >> 2) << 2;
        const positionInGroup = onsets.filter(
          (candidate) => candidate >= groupStart && candidate < step,
        ).length;
        const fragmentDegrees = sequenceFragment.relativeDegrees;
        const degree = (sequenceAscending ? 1 : -1) * (phraseStep >> 2)
          + (fragmentDegrees[positionInGroup % Math.max(1, fragmentDegrees.length)] ?? 0);
        midi = realizeDegree(barAnchor, degree, scaleAt(chord), MELODY_LO, MELODY_HI);
        if (positionInGroup === 0 && strong && lastSequenceHead !== null) {
          // ゼクエンツの単調性: 断片頭は強拍量子化で前グループと同音へ戻りやすく、
          // それではランプ(2度ずつの移高)が聴こえない。進行方向にある次の和声音を
          // 頭に選び、移高の錨を強拍側で保証する。
          const rampDirection = sequenceAscending ? 1 : -1;
          let candidate = lastSequenceHead + rampDirection;
          while (
            candidate >= MELODY_LO && candidate <= MELODY_HI
            && !structuralPcs.includes(((candidate % 12) + 12) % 12)
          ) candidate += rampDirection;
          if (candidate >= MELODY_LO && candidate <= MELODY_HI) midi = candidate;
        }
      } else {
        // 実音テーマの実現。アンカーからのスケールウォークで内部の音程を保存する。
        // 提示・変奏反復・結論の引用・リテラル帰還は、すべて同じ度数列のここを通る。
        // 歩く音組織は小節のコードスケール(変位音がキーの音階を局所上書きした音組織)。
        // 度数は不変のまま、V7の導音やIV7の♮6のような変位へ旋律が追従する。
        midi = realizeDegree(barAnchor, barTheme.degreeByStep[phraseStep] ?? 0, scaleAt(chord), MELODY_LO, MELODY_HI);
      }
      pendingAppoggiaturaResolution = null;
      const nextPlannedStep = index + 1 < onsets.length ? onsets[index + 1]! : null;
      // 終止接近: 次の発音が終止目標なら、目標へ向けて中間音を橋渡しする。
      // ターンアラウンドはループ頭へ、他の終止は目標音度の実音へ寄せることで、
      // 狭い音域の端(単一オクターブしか候補のない音級)への跳躍を半減させる。
      const bridgesToCadence = (
        barPlan.targetPc !== null
        && nextPlannedStep === barPlan.targetStep
        && step !== barPlan.targetStep
        // 倚音の解決音は2度解決が契約なので、終止への橋渡しで上書きしない。
        && !resolvedAppoggiatura
      );
      if (bridgesToCadence) {
        // ゴール予測は実際の終止計算と同じくクライマックス未満で束縛する。
        const goal = barPlan.cadence === 'turnaround'
          ? nearestWithPc(phraseAnchors[0] ?? startMidi, [barPlan.targetPc!])
          : nearestWithPc(
            prev + Math.round((center - prev) / 2), [barPlan.targetPc!], MELODY_LO, climaxMidi - 1,
          );
        midi = bridgeWithPc(prev, goal, strong ? chord.pcs : scaleAt(chord));
      }
      // 署名跳躍: 旋律の常用域(中心±数半音)からは9半音超を音域内に収められないため、
      // 展開小節の頭を低い和声音の「踏み切り」にし、2音目で一度だけ上へ跳ぶ。直後は反行順次。
      let isSignatureLeapNote = false;
      // 踏み切りは、跳躍の直後(3音目)が弱拍で受けられる小節だけに置く。受けが不可能だと
      // 音域最下部の踏み切りだけが残り、そこからの通常旋律が畳めない大跳躍になる。
      if (
        bar === phrasePlan.signatureLeapBar && step === 0 && onsets.length >= 3
        && onsets[2] !== 4
      ) {
        // 踏み切りは音域最下部の和声音。ここからでないと9半音超をクライマックス未満に収められない。
        midi = nearestWithPc(MELODY_LO + 1, structuralPcs, MELODY_LO, MELODY_LO + 4);
        if (midi >= MELODY_LO) signatureLeapPending = true;
        else midi = nearestWithPc(center, structuralPcs);
      } else if (signatureLeapPending) {
        signatureLeapPending = false;
        const lo = prev + 10;
        const hi = Math.min(climaxMidi - 1, prev + 14);
        const leapMidi = hi >= lo ? nearestWithPc(hi, structuralPcs, lo, hi) : -1;
        const followUp = onsets[index + 1];
        // 直後を弱拍の順次で受け止められるときだけ跳ぶ（均衡跳躍をデバイス側で保証する）。
        const canBalance = followUp !== undefined && followUp !== 4;
        if (leapMidi >= lo && leapMidi <= hi && canBalance) {
          midi = leapMidi;
          isSignatureLeapNote = true;
          signatureStepBack = -1;
        }
      } else if (signatureStepBack !== null) {
        // 受け音が強拍に当たる場合は和声音で受ける（順次幅は広がるが強拍規則を守る）。
        // コードスケールの増2度(和声的短音階等)で受けが3半音になる場合は素の音組織で
        // 受け、均衡跳躍の「2度で戻る」定義を守る。
        const byChordScale = stepOnScale(prev, signatureStepBack, strong ? structuralPcs : scaleAt(chord));
        midi = strong || Math.abs(byChordScale - prev) <= 2
          ? byChordScale
          : stepOnScale(prev, signatureStepBack, scalePcs);
        signatureStepBack = null;
      }
      if (
        !(bar === phrasePlan.climaxBar && step === 0)
        && !(barPlan.cadence === 'turnaround' && step === barPlan.targetStep)
        && !isSignatureLeapNote
        && Math.abs(midi - prev) > 9
      ) {
        // 音級は保ちつつ近いオクターブを選び、偶発的な大跳躍を避ける。
        midi = nearestWithPc(prev, [midi % 12]);
        if (
          Math.abs(midi - prev) > 9
          && !(barPlan.targetStep === step && barPlan.targetPc !== null)
        ) {
          // 音域端では畳む先のオクターブが範囲外になり得る。その場合は音級を諦め、
          // 9半音以内の音組織音で受ける(終止目標音は音級が契約なので対象外)。
          // 目標を6半音先に置くのは、和声音の最大間隔(3度=最大4半音)を足しても
          // 9半音を超えないため。
          midi = nearestWithPc(prev + (midi > prev ? 6 : -6), strong ? structuralPcs : scaleAt(chord));
        }
      }
      if (!(bar === phrasePlan.climaxBar && step === 0) && midi >= climaxMidi) {
        const allowedPcs = barPlan.targetStep === step && barPlan.targetPc !== null
          ? [barPlan.targetPc]
          : strong
            ? structuralPcs
            : scaleAt(chord);
        midi = nearestWithPc(climaxMidi - 1, allowedPcs, MELODY_LO, climaxMidi - 1);
      }
      // 強拍規則: フレーズ頭(step0)は必ず和声音へ吸着する(アンカー調整)。3拍目(step4)は
      // 倚音許可小節に限り、半拍〜1拍後の発音で2度の和声音へ解決できる場合だけ
      // 非和声のまま保持し、次の発音を解決音として予約する(できなければ従来どおり吸着)。
      if (
        strong
        && !(bar === phrasePlan.climaxBar && step === 0)
        && !(barPlan.targetStep === step && barPlan.targetPc !== null)
        && !structuralPcs.includes(((midi % 12) + 12) % 12)
      ) {
        let keptAsAppoggiatura = false;
        // 倚音の接近: 直前音が和声音(掛留を含む)か、2度で掛かる場合だけ保持する。
        // 非和声音からの同音連打・跳躍で入ると、直前音が宙吊りのまま残る。
        const approachedProperly = chordAt(prevBeat).pcs.includes(((prev % 12) + 12) % 12)
          || (Math.abs(midi - prev) <= 2 && midi !== prev);
        if (barPlan.appoggiaturaStep === step && midi < climaxMidi && approachedProperly) {
          const resolutionStep = [5, 6].find((candidate) => barPlan.rhythm[candidate]);
          if (resolutionStep !== undefined) {
            const resolutionPcs = melodyPcsForChord(chordAt(bar * 4 + resolutionStep * 0.5));
            // 解決音はクライマックスの一意性を壊さない範囲(climaxMidi未満)に限る。
            // でないと後段のクランプが解決音を動かし、倚音が宙吊りのまま残る。
            const usable = (candidate: number): boolean => (
              candidate < climaxMidi && resolutionPcs.includes(((candidate % 12) + 12) % 12)
            );
            const below = stepOnScale(midi, -1, scaleAt(chord));
            const above = stepOnScale(midi, 1, scaleAt(chord));
            const resolution = usable(below) ? below : usable(above) ? above : null;
            if (resolution !== null) {
              pendingAppoggiaturaResolution = resolution;
              keptAsAppoggiatura = true;
            }
          }
        }
        if (!keptAsAppoggiatura) midi = nearestWithPc(midi, structuralPcs);
      }
      if (barPlan.phraseFunction === 'departure' && !borrowsExternalMotif && strong) {
        lastSequenceHead = midi;
      }
      const intervalFromPrev = Math.abs(midi - prev);
      const stepwiseFromPrev = (intervalFromPrev >= 1 && intervalFromPrev <= 2)
        || (scaleStepMax > 2
          && intervalFromPrev >= 1 && intervalFromPrev <= scaleStepMax
          && scalePcs.includes(((prev % 12) + 12) % 12)
          && scalePcs.includes(midi % 12));
      if (
        !strong
        && melody.length > 0
        && barPlan.targetStep !== step
        && !stepwiseFromPrev
        && !chordAt(prevBeat).pcs.includes(prev % 12)
        && !chord.pcs.includes(midi % 12)
      ) {
        // 直前の弱拍非和声音を宙に浮かせない。同音連打は順次進行で、跳躍は和声音で受けて解決する。
        if (intervalFromPrev === 0) {
          midi = stepOnScale(prev, center >= prev ? 1 : -1, scaleAt(chord));
        } else {
          midi = nearestWithPc(midi, structuralPcs);
          if (Math.abs(midi - prev) > 9) midi = nearestWithPc(prev, [midi % 12]);
        }
      }
      const nextLeadStep = index + 1 < onsets.length ? onsets[index + 1]! : 8;
      const nextCounterStep = barPlan.counterSteps.find((counterStep) => counterStep > step) ?? 8;
      const nextOrnamentStep = barPlan.ornamentSteps
        .map((ornamentStep) => ornamentStep * 0.5)
        .find((ornamentStep) => ornamentStep > step) ?? 8;
      const boundaryStep = Math.min(nextLeadStep, nextCounterStep, nextOrnamentStep);
      const boundaryBeat = grooveBeat(bar * 4 + boundaryStep * 0.5, grooveFeel);
      // 半小節タイ: アンカー(3拍目)を跨いで保続する音は、跨いだ先(3拍目時点)の和音の
      // 構成音を先に取る(先取音)。跨ぎ先が同じ和音なら和声音への吸着と同義。
      const tiesOverAnchor = barPlan.anchorTie && step < 4 && nextLeadStep > 4;
      if (tiesOverAnchor) {
        midi = nearestWithPc(midi, melodyPcsForChord(chordAt(bar * 4 + 2)));
      }
      // ロングトーン: 到達音を次小節の最初の発音（主旋律・副旋律・装飾のどれか）まで保続する。
      const nextBarPlan = phrasePlan.bars[bar + 1];
      const longToneBoundary = barPlan.longToneStep === step && nextBarPlan !== undefined
        ? (() => {
            const nextMelodyOnset = nextBarPlan.rhythm.findIndex((on) => on);
            const boundary = Math.min(
              nextMelodyOnset < 0 ? 8 : nextMelodyOnset,
              nextBarPlan.counterSteps[0] ?? 8,
              (nextBarPlan.ornamentSteps[0] ?? 16) * 0.5,
            );
            return grooveBeat((bar + 1) * 4 + boundary * 0.5, grooveFeel);
          })()
        : null;
      const articulation: NoteArticulation = tiesOverAnchor
        ? 'tenuto'
        : barPlan.targetStep === step
        ? barPlan.ornamentType === 'shake' ? 'ornament' : 'tenuto'
        : bar === phrasePlan.climaxBar && step === 0
          ? 'accent'
          : strong
            ? 'accent'
            : style.melody.articulation === 'offbeatStaccato'
              ? 'staccato'
              : style.melody.articulation === 'longTenuto' && boundaryStep - step >= 2
                ? 'tenuto'
                : 'normal';
      const gate = articulation === 'staccato'
        ? style.melody.gate * 0.65
        : articulation === 'tenuto'
          ? Math.max(style.melody.gate, 0.92)
          : style.melody.gate;
      const velocity = Math.min(1, barPlan.dynamic + (strong ? 0.08 : 0) + (articulation === 'accent' ? 0.08 : 0));
      melody.push({
        beat,
        dur: longToneBoundary !== null
          ? Math.max(0.1, longToneBoundary - beat)
          // タイはアンカーを跨いで次の発音まで途切れず保続する(ゲート比を掛けない)。
          : tiesOverAnchor
            ? Math.max(0.1, boundaryBeat - beat)
            : Math.max(0.1, (boundaryBeat - beat) * gate),
        midi,
        velocity,
        articulation,
        ...(barPlan.targetStep === step && barPlan.ornamentType === 'shake'
          ? { ornament: barPlan.ornamentType }
          : {}),
        role: 'structural',
      });
      prev = midi;
      prevBeat = logicalBeat;
    }

    // 和風モードの装飾は独立した「飛び道具」ではなく、応答の到達音へ食い込む前打音として置く。
    for (let ornamentIndex = 0; ornamentIndex < barPlan.ornamentSteps.length; ornamentIndex++) {
      const ornamentStep = barPlan.ornamentSteps[ornamentIndex]!;
      const beat = grooveBeat(bar * 4 + ornamentStep * 0.25, grooveFeel);
      const targetBeat = grooveBeat(bar * 4 + barPlan.targetStep! * 0.5, grooveFeel);
      const target = melody.find((note) => Math.abs(note.beat - targetBeat) < 0.001);
      if (!target) continue;
      const baseDirection: 1 | -1 = ((bar + opts.seed) & 1) === 0 ? -1 : 1;
      const direction: 1 | -1 = barPlan.ornamentType === 'turn' && ornamentIndex === 1
        ? (baseDirection === 1 ? -1 : 1)
        : baseDirection;
      const midi = stepOnScale(target.midi, direction, scaleAt(chordAt(bar * 4 + barPlan.targetStep! * 0.5)));
      melody.push({
        beat,
        dur: 0.18,
        midi,
        velocity: Math.max(0.35, barPlan.dynamic - 0.18),
        articulation: 'ornament',
        ...(barPlan.ornamentType ? { ornament: barPlan.ornamentType } : {}),
        role: 'ornament',
      });
    }
  }
  melody.sort((a, b) => a.beat - b.beat);

  // 弱起の音高を、次フレーズ頭の「実現音」から確定する(2度下で掛かる契約)。
  // 前方予測のアンカーは強拍の再吸着等で実現音とずれることがあるため、
  // 全実音の確定後に逆算で合わせる。
  for (const barPlan of phrasePlan.bars) {
    if (!barPlan.anacrusis) continue;
    const pickupBeat = grooveBeat(barPlan.bar * 4 + 3.5, grooveFeel);
    const pickup = melody.find((note) => (
      note.role !== 'ornament' && Math.abs(note.beat - pickupBeat) < 0.001
    ));
    const head = melody.find((note) => (
      note.role !== 'ornament' && note.beat >= (barPlan.bar + 1) * 4
    ));
    if (!pickup || !head) continue;
    pickup.midi = stepOnScale(head.midi, -1, scaleAt(chordAt(barPlan.bar * 4 + 3.5)));
  }
  return melody;
}

/**
 * ベース: スタイルの刻み様式（octave8/root8/rootFifth/sustain/kickSync）+
 * PhrasePlan の終止機能（終止・接近音）+ ベースライン装置（分数コードのライン）。
 * 度数計画は bassline.ts（HarmonyBarPlan.bassDegrees）が済ませている。
 */

import { sectionIndexAt } from './form.js';
import { grooveBeat } from './groove.js';
import { nearestWithPc } from './pitch.js';
import { drumPatternStep } from './theory.js';
import type { ComposeContext } from './compose-context.js';
import type { NoteEvent } from './types.js';

export function generateBass(ctx: ComposeContext): NoteEvent[] {
  const {
    form, bars, style, keyRoot, idiom, grooveFeel, bassLinePolicy,
    songPlan, arrangementPlan, phrasePlan, phraseGestures, chords, chordAt, scaleAt,
  } = ctx;
  // --- ベース（スタイルの刻み + PhrasePlanの終止機能） ---
  const bass: NoteEvent[] = [];
  // kickSync用: その小節で実際に鳴るキック骨格の強度。ドラム生成と同じ節解決
  // (sectionB/breakdown)を通すことで、ベースが譜面上のAパターンでなく
  // 「聴こえているキック」に同置される。
  const kickStepLevel = (bar: number, step: number): number => {
    // 打楽器のない様式にはキック骨格が無い(kickSync はキット前提の刻み)。
    if (style.percussion.kind !== 'kit') return 0;
    const sectionPlan = arrangementPlan.sections[sectionIndexAt(form, bar)] ?? arrangementPlan.sections[0]!;
    if (sectionPlan.drum === 'breakdown') return step === 0 || step === 8 ? 1 : 0;
    const pattern = sectionPlan.drum === 'sectionB' ? style.percussion.sectionB.kick : style.percussion.kick;
    return drumPatternStep(pattern, bar, step);
  };
  const bassPattern = style.bass.pattern;
  let previousAnchor: number | null = null;
  for (const c of chords) {
    // ペダル低音は進行名だけで常設せず、曲全体で低音主導を選んだ場合にだけ使う。
    // 分数コード(bassPc)があればそれをアンカーにする(ペダルはラインより優先)。
    const anchorPc = arrangementPlan.bassRole === 'pedal' ? keyRoot : (c.bassPc ?? c.rootPc);
    // アンカーは直前アンカーへの最短連結(D#2..D3窓)。固定写像だとE/D#間で11半音跳ぶ。
    const root = nearestWithPc(previousAnchor ?? 43, [anchorPc], 36, 50);
    previousAnchor = root;
    if (bassPattern === 'rootFifth') {
      // 五度は和音の品質に追従する（dimは減5度、augは増5度）。機械的な+7で和声外に落とさない。
      // アンカーが転回音でも「アンカーの5度圏上にあるコードトーン」を探す同じ規則で拾う。
      const fifthPc = ([7, 6, 8] as const)
        .map((interval) => (anchorPc + interval) % 12)
        .find((pc) => c.pcs.includes(pc));
      // 5度を省いた和音(M13 等)では機械的な完全5度を和声外へ落とさず、オクターブで交替する。
      const fifthOffset = fifthPc === undefined ? 12 : (fifthPc - anchorPc + 12) % 12;
      for (let b = 0; b < c.dur; b++) {
        bass.push({ beat: c.beat + b, dur: 0.9, midi: b % 2 === 0 ? root : root + fifthOffset });
      }
    } else if (bassPattern === 'sustain') {
      // 持続サブ: コードイベントごとに1音を長く保つ。倍速ドラムに対する低音の
      // 持続(速度対比)が様式の核なので、刻まずイベント長のほぼ全部を鳴らす。
      bass.push({ beat: c.beat, dur: Math.max(0.5, c.dur - 0.1), midi: root });
    } else if (bassPattern === 'kickSync') {
      // キック同期シンコペ: 実際に鳴るキックに同置し、各キックの2×16分後
      // (同一コードイベント内のみ)で応答する。応答位置もキック由来なので、
      // 16分押し込み(s7)への応答はシャッフル格子ごと跳ねる。
      const startStep = Math.round(c.beat * 4);
      const endStep = Math.round((c.beat + c.dur) * 4);
      let pushed = 0;
      for (let s = startStep; s < endStep; s++) {
        const onKick = kickStepLevel(Math.floor(s / 16), s % 16) > 0;
        const answers = !onKick && s - 2 >= startStep
          && kickStepLevel(Math.floor((s - 2) / 16), (s - 2) % 16) > 0;
        if (!onKick && !answers) continue;
        const beat = grooveBeat(s * 0.25, grooveFeel);
        const nextBeat = grooveBeat(s * 0.25 + 0.5, grooveFeel);
        bass.push({ beat, dur: Math.min(0.4, Math.max(0.18, (nextBeat - beat) * 0.8)), midi: root });
        pushed++;
      }
      // コード変更は低音でも聴かせる: イベント内にキックが無ければ頭で1音だけ打つ。
      if (pushed === 0) bass.push({ beat: grooveBeat(c.beat, grooveFeel), dur: 0.4, midi: root });
    } else {
      for (let e = 0; e < c.dur * 2; e++) {
        const midi = bassPattern === 'octave8' && e % 2 === 1 ? root + 12 : root;
        const beat = grooveBeat(c.beat + e * 0.5, grooveFeel);
        const nextBeat = grooveBeat(c.beat + (e + 1) * 0.5, grooveFeel);
        bass.push({ beat, dur: Math.min(0.4, Math.max(0.18, (nextBeat - beat) * 0.8)), midi });
      }
    }
  }

  for (const barPlan of phrasePlan.bars) {
    const bar = barPlan.bar;
    const phraseGesture = phraseGestures[sectionIndexAt(form, bar)]!;
    const inBar = bass.filter((note) => note.beat >= bar * 4 && note.beat < (bar + 1) * 4);
    const last = inBar[inBar.length - 1];
    if (!last) continue;
    const endChord = chordAt((bar + 1) * 4 - 0.001);
    const endRootPc = endChord.rootPc;
    // 最終小節の次はループなら先頭、終止曲型なら(次が無いので)終止和音そのもの。
    const nextChord = bar + 1 < bars
      ? chordAt((bar + 1) * 4)
      : songPlan.form.ending === 'loop' ? chordAt(0) : endChord;
    // 接近の目標は次コードでベースが実際に弾く音(分数コードならbassPc、通常はルート)。
    const nextAnchorPc = nextChord.bassPc ?? nextChord.rootPc;
    // 持続サブの終止音: 長音そのものを再ピッチすると小節全体の低音が動いてしまうため、
    // 長音は保ったまま最後の8分だけを終止音・接近音へ割く。
    const placeSustainedCadenceNote = (midi: number): void => {
      const pickupBeat = grooveBeat(bar * 4 + 3.5, grooveFeel);
      if (bassPattern === 'sustain' && last.beat < pickupBeat - 0.001) {
        last.dur = Math.min(last.dur, pickupBeat - last.beat - 0.05);
        bass.push({
          beat: pickupBeat,
          dur: 0.35,
          midi,
          velocity: Math.max(0.4, barPlan.dynamic - 0.1),
          articulation: 'staccato',
          role: 'structural',
        });
      } else {
        last.midi = midi;
      }
    };
    if (barPlan.cadence === 'closed') {
      last.midi = nearestWithPc(last.midi, [endRootPc], 36, 64);
    } else if (barPlan.cadence === 'open') {
      // 開放終止の5度は和音の品質に追従する(dimは減5度、augは増5度。rootFifth刻みと同じ規則。
      // 機械的な+7だと短調のiiDim上で和声外の完全5度に落ちる)。持続サブは長音を保って
      // 最後の8分だけを5度へ割く(終止小節の低音の土台を1小節ぶん動かさない)。
      // 5度を省いた和音(M13 等)では完全5度が和声外になるので、根音で開いたまま受ける。
      const fifthPc = ([7, 6, 8] as const)
        .map((interval) => (endRootPc + interval) % 12)
        .find((pc) => endChord.pcs.includes(pc)) ?? endRootPc;
      placeSustainedCadenceNote(nearestWithPc(last.midi, [fifthPc], 36, 64));
    } else if (barPlan.cadence === 'half' || barPlan.cadence === 'turnaround') {
      // 様式の終止作法(半音接近・和声音接近)は語法が許すときだけ。和風は全音階の経過音へ。
      if (idiom.allowsStyledBassCadence && style.bass.cadence === 'chromatic') {
        const approachPc = (nextAnchorPc + (phraseGesture[15]!.direction === 1 ? 11 : 1)) % 12;
        last.midi = nearestWithPc(last.midi, [approachPc], 36, 64);
      } else if (idiom.allowsStyledBassCadence && style.bass.cadence === 'chordTone') {
        const nextAnchorMidi = nearestWithPc(last.midi, [nextAnchorPc], 36, 64);
        const approachMidi = nearestWithPc(nextAnchorMidi, endChord.pcs, 36, 64);
        placeSustainedCadenceNote(approachMidi);
      } else {
        const dir = phraseGesture[15]!.direction;
        let distance = 1;
        let approachPc = nextAnchorPc;
        while (distance < 12 && approachPc === nextAnchorPc) {
          const candidate = (nextAnchorPc - dir * distance + 120) % 12;
          if (scaleAt(endChord).includes(candidate)) approachPc = candidate;
          distance++;
        }
        const pickup: NoteEvent = {
          beat: grooveBeat(bar * 4 + 3.5, grooveFeel),
          dur: 0.35,
          midi: nearestWithPc(last.midi, [approachPc], 36, 64),
          velocity: Math.max(0.4, barPlan.dynamic - 0.1),
          articulation: 'staccato',
          role: 'structural',
        };
        if (last.beat < pickup.beat) bass.push(pickup);
        else last.midi = pickup.midi;
      }
    } else if (bassLinePolicy === 'on' && barPlan.cadence === null) {
      // 小節内順次進行(装置on時): 終止小節以外でも、次のアンカーへ3半音以上跳ぶなら
      // 8分裏へ音階上の接近音を1つ挟み、ラインの前進を終止部の外へも広げる。
      // 接近音の選び方はdiatonicPickupと同じ「目標から進行方向の逆へ音階を辿る」規則。
      const nextMidi = nearestWithPc(last.midi, [nextAnchorPc], 36, 64);
      const gap = nextMidi - last.midi;
      if (Math.abs(gap) >= 3) {
        const dir = gap > 0 ? 1 : -1;
        let approachPc = nextAnchorPc;
        let distance = 1;
        while (distance <= 2 && approachPc === nextAnchorPc) {
          const candidate = (nextAnchorPc - dir * distance + 24) % 12;
          if (scaleAt(endChord).includes(candidate)) approachPc = candidate;
          distance++;
        }
        if (approachPc !== nextAnchorPc) {
          const pickup: NoteEvent = {
            beat: grooveBeat(bar * 4 + 3.5, grooveFeel),
            dur: 0.35,
            midi: nearestWithPc(nextMidi - dir, [approachPc], 36, 64),
            velocity: Math.max(0.4, barPlan.dynamic - 0.1),
            articulation: 'staccato',
            role: 'structural',
          };
          // 8分刻みのスタイルは裏拍が既にあるので、増やさず最後の8分を接近音へ差し替える。
          if (last.beat < pickup.beat) bass.push(pickup);
          else last.midi = pickup.midi;
        }
      }
    }
  }
  for (const note of bass) {
    const barPlan = phrasePlan.bars[Math.min(bars - 1, Math.floor(note.beat / 4))]!;
    note.velocity = Math.min(1, barPlan.dynamic + (note.beat % 1 === 0 ? 0.06 : -0.05));
    // 持続サブの長音はテヌート(終止の接近音など短音はスタッカートのまま)。
    note.articulation = bassPattern === 'sustain' && note.dur >= 0.5
      ? 'tenuto'
      : style.bass.articulation ?? 'staccato';
    note.role = 'structural';
  }
  bass.sort((a, b) => a.beat - b.beat);
  return bass;
}

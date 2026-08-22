import type {
  ArrangementPlan,
  ArrangementSectionPlan,
  ComposeBars,
  Piece,
  TupletDivision,
  TupletOverlayChoice,
} from './types.js';
import type { SectionRole, SongPlan } from './types.js';
import { allowsTupletOverlay, grooveFor } from './groove.js';
import { GROUPING_DISSONANCES } from './metric-modulation.js';
import { capabilitiesFor } from './sound-capabilities.js';
import { CHORDS } from './theory.js';
import { featuredGuideStrand } from './voice-leading.js';

/**
 * 進行の実トークン列が「全移動半音以内」の最短連結ストランドを持つときだけ、
 * 保続ガイドラインを対旋律役割の候補にする。導出は常に行い、採用は品質ゲート＋
 * シード抽選＋テクスチャ戦略の土俵で決める（全曲への一律適用を構造的に防ぐ）。
 */
function guidelineEligible(plan: SongPlan | undefined): boolean {
  if (!plan) return false;
  const tokens = plan.harmony.flatMap((bar) => bar.tokens);
  const seq = tokens.map((token) => CHORDS[token]!.tones);
  const roots = tokens.map((token) => CHORDS[token]!.tones[0]!);
  return featuredGuideStrand(seq, roots) !== null;
}

type SectionDevice = 'none' | 'echo' | 'counter1' | 'counter2' | 'arp1' | 'arp2';

const section = (
  backingDensity: ArrangementSectionPlan['backingDensity'],
  drum: ArrangementSectionPlan['drum'],
  device: SectionDevice = 'none',
): ArrangementSectionPlan => ({
  backingDensity,
  drum,
  entrance: 'none',
  exitFill: 'none',
  echo: device === 'echo',
  counterDensity: device === 'counter1' ? 1 : device === 'counter2' ? 2 : 0,
  ostinatoDensity: device === 'arp1' ? 1 : device === 'arp2' ? 2 : 0,
  ostinatoPeak: null,
  ostinatoTuplet: null,
  leadColor: 0,
});

/**
 * 旋律の受け渡し(音色によるフォーム分節)。役割→パレット番号の固定写像:
 * hook/return/finaleは看板の色0で帰ってきて、developmentが第2、reliefが第3の色。
 * パレットが1色しかないレンダラ/スタイルでは全区間同じ音になる(後方互換)。
 */
const LEAD_COLOR_BY_ROLE: Record<SectionRole, number> = {
  hook: 0,
  development: 1,
  relief: 2,
  return: 0,
  finale: 0,
};

/** 帰還区間の前進感を、曲全体で選ばれたテクスチャ戦略の主役から導く。 */
function returnDeviceFor(
  textureStrategy: ArrangementPlan['textureStrategy'],
  plan: SongPlan,
): SectionDevice {
  const caps = capabilitiesFor(plan.soundChip);
  if (textureStrategy === 'counterDrive') return 'counter2';
  if (textureStrategy === 'arpDrive') return caps.independentArpeggio ? 'arp2' : 'counter2';
  if (textureStrategy === 'bassDrive') return 'counter1';
  if (textureStrategy === 'hybrid') return caps.independentArpeggio ? 'arp2' : 'counter2';
  return caps.echoDoubling ? 'echo' : 'counter1';
}

function withTransitions(
  source: readonly ArrangementSectionPlan[],
  energies: readonly number[],
  seed: number,
): ArrangementSectionPlan[] {
  const peakChoices = ['restatement', 'departure', 'conclusion'] as const;
  return source.map((item, index) => {
    const previousEnergy = index > 0 ? energies[index - 1]! : item.backingDensity === 'full' ? 2 : 3;
    const nextEnergy = index + 1 < source.length ? energies[index + 1]! : null;
    const deltaIn = energies[index]! - previousEnergy;
    const entrance = index === 0 || (deltaIn > 0 && ((seed + index) & 1) === 0)
      ? 'cymbal'
      : 'none';
    let exitFill: ArrangementSectionPlan['exitFill'] = 'none';
    if (nextEnergy !== null) {
      const deltaOut = nextEnergy - energies[index]!;
      if (deltaOut >= 2) exitFill = 'full';
      else if (deltaOut > 0) exitFill = ((seed + index * 3) & 1) === 0 ? 'light' : 'full';
      else if (deltaOut === 0) exitFill = ((seed + index * 5) % 3) === 0 ? 'light' : 'none';
      else exitFill = ((seed + index * 7) % 4) === 0 ? 'light' : 'none';
    }
    return {
      ...item,
      entrance,
      exitFill,
      ostinatoPeak: item.ostinatoDensity > 0
        ? peakChoices[(seed + index * 5) % peakChoices.length]!
        : null,
    };
  });
}

/** seedは互換候補内の揺らぎにだけ使い、候補集合そのものは曲調・密度・チップで決める。 */
function textureStrategyFor(
  bars: ComposeBars,
  seed: number,
  plan: SongPlan | undefined,
  forceArp: boolean,
): ArrangementPlan['textureStrategy'] {
  // 連符レイヤー有効時は、担い手のオスティナート区間が必ず生まれる編成に固定する。
  if (forceArp) return 'arpDrive';
  if (!plan) {
    const fallback = bars < 16
      ? ['classic', 'counterDrive', 'arpDrive', 'bassDrive'] as const
      : ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'] as const;
    return fallback[(seed >>> 1) % fallback.length]!;
  }
  let candidates: ArrangementPlan['textureStrategy'][];
  if (!capabilitiesFor(plan.soundChip).independentArpeggio) {
    // 独立アルペジオの声部予算が無いバックエンドでは、作って後段で捨てない。
    candidates = plan.styleId === 'ska' ? ['counterDrive', 'classic'] : ['bassDrive', 'classic'];
  } else if (plan.styleId === 'rock') {
    candidates = ['bassDrive', 'counterDrive', 'hybrid'];
  } else if (plan.styleId === 'ska') {
    candidates = ['counterDrive', 'hybrid'];
  } else {
    candidates = ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'];
  }
  if (plan.melodyDensity >= 5.75) candidates = candidates.filter((item) => item !== 'hybrid');
  // 短形式の細分オーバーレイは既存フレーズへ重ねる層なので、ここで編成候補まで変えて主旋律を作り直さない。
  if (grooveFor(plan.grooveFeel).subdivisionOverlay !== 'none' && bars >= 16) {
    candidates = candidates.filter((item) => item !== 'arpDrive');
  }
  if (bars < 16) {
    // 1区間しかない短形式では、複数奏法の交替を前提にするhybridを選ばない。
    candidates = [
      ...new Set<ArrangementPlan['textureStrategy']>([
        'classic', ...candidates.filter((item) => item !== 'hybrid'),
      ]),
    ];
  }
  if (candidates.length === 0) candidates = ['classic'];
  return candidates[(seed >>> 1) % candidates.length]!;
}

/** 連符レイヤーの発動判定。声部予算のないバックエンド・細分オーバーレイ併用時は静かに無効へ落とす。 */
function resolveTupletOverlay(
  choice: TupletOverlayChoice,
  songPlan: SongPlan | undefined,
): TupletDivision | 'auto' | null {
  if (choice === 'off' || !songPlan) return null;
  // 連符レイヤーは独立オスティナート声部が担い手。予算のないバックエンドでは畳む。
  if (!capabilitiesFor(songPlan.soundChip).independentArpeggio) return null;
  if (!allowsTupletOverlay(songPlan.grooveFeel)) return null;
  return choice;
}

/**
 * 連符レイヤーを担う区間を確定する。数値指定は全区間同値。autoは区間エネルギーの
 * 順位を拍節的不協和の緊張度順位（metric-modulation.tsのカタログ順）へ写す:
 * 頂点区間=最も不協和な分割、中位=中位、それ以外と単一区間=最も協和的な分割。
 */
function withTupletLayer(
  plan: ArrangementPlan,
  tuplet: TupletDivision | 'auto',
  seed: number,
  songPlan: SongPlan | undefined,
): ArrangementPlan {
  const energies = songPlan?.form.sections.map((item) => item.energy) ?? plan.sections.map(() => 3);
  const sections = [...plan.sections];
  if (!sections.some((item) => item.ostinatoDensity > 0)) {
    // 編成方針の上書き（不在区間の整理など）で担い手が消えた場合、最高エネルギー区間へ復帰させる。
    const index = sections
      .map((_, i) => i)
      .filter((i) => sections[i]!.drum !== 'breakdown')
      .sort((a, b) => energies[b]! - energies[a]!)[0] ?? 0;
    sections[index] = {
      ...sections[index]!,
      ostinatoDensity: 1,
      ostinatoPeak: (['restatement', 'departure', 'conclusion'] as const)[(seed + index * 5) % 3]!,
    };
  }
  const arpEnergies = sections.map((item, i) => item.ostinatoDensity > 0 ? energies[i]! : -1);
  const peakEnergy = Math.max(...arpEnergies);
  const sorted = [...energies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  // 緊張度の昇順カタログ。低エネルギー→協和的（ヘミオラ族）、頂点→最も不協和。
  const byTension = GROUPING_DISSONANCES;
  const calmest = byTension[0]!.division;
  const middle = byTension[Math.floor((byTension.length - 1) / 2)]!.division;
  const tensest = byTension[byTension.length - 1]!.division;
  const mapped = sections.map((item, i) => {
    if (item.ostinatoDensity === 0) return item;
    const division: TupletDivision = tuplet !== 'auto'
      ? tuplet
      : sections.length === 1
        ? calmest
        : arpEnergies[i] === peakEnergy ? tensest : energies[i]! >= median ? middle : calmest;
    return { ...item, ostinatoTuplet: division };
  });
  return {
    ...plan,
    sectionA: mapped[0]!,
    sectionB: mapped[1] ?? mapped[0]!,
    sections: mapped,
  };
}

/**
 * 曲全体のテクスチャ設計。奏法は「使えるから全部使う」のではなく、
 * 主役を一つ決め、別区間で休止・再登場させる。音数制限より前に密度を整理する。
 */
export function arrangementPlanFor(
  bars: ComposeBars,
  seed: number,
  progressionId?: string,
  songPlan?: SongPlan,
  tupletOverlay: TupletOverlayChoice = 'off',
): ArrangementPlan {
  const tuplet = resolveTupletOverlay(tupletOverlay, songPlan);
  const plan = planArrangement(bars, seed, progressionId, songPlan, tuplet !== null);
  return tuplet === null ? plan : withTupletLayer(plan, tuplet, seed, songPlan);
}

function planArrangement(
  bars: ComposeBars,
  seed: number,
  progressionId: string | undefined,
  songPlan: SongPlan | undefined,
  forceArp: boolean,
): ArrangementPlan {
  const textureStrategy = textureStrategyFor(bars, seed, songPlan, forceArp);
  // 対旋律が主役の戦略では counterline と同格（1/2）の抽選対象、2A03では応答の
  // 代替候補（1/4）。それ以外の編成では従来どおり短い応答に限定し、保続ラインを
  // 常設装置にしない。抽選は単一ビット参照でなくハッシュで取り、小さいシード帯でも
  // 一様に発火させる（発火率はテストで観測できる）。
  const guidelineDraw = (Math.imul((seed ^ 0x4755_4944) >>> 0, 0x9e37_79b1) >>> 13) & 3;
  const counterRole: ArrangementPlan['counterRole'] = textureStrategy === 'counterDrive' || textureStrategy === 'hybrid'
    ? (guidelineDraw & 1) === 1 && guidelineEligible(songPlan) ? 'guideline' : 'counterline'
    : guidelineDraw === 3
      && songPlan !== undefined
      && !capabilitiesFor(songPlan.soundChip).independentArpeggio
      && guidelineEligible(songPlan)
      ? 'guideline'
      : 'response';
  const bassRole = textureStrategy === 'bassDrive' && progressionId === 'minor-pedal'
    ? 'pedal'
    : 'rootMotion';

  if (bars === 40) {
    const energies = songPlan?.form.sections.map((item) => item.energy) ?? [4, 3, 2, 4, 5];
    const sortedEnergy = [...energies].sort((a, b) => a - b);
    const median = sortedEnergy[Math.floor(sortedEnergy.length / 2)]!;
    const minimum = sortedEnergy[0]!;
    const sections = energies.map((energy) => section(
      energy >= median ? 'full' : 'sparse',
      energy === minimum ? 'breakdown' : energy > median ? 'sectionB' : 'base',
    ));
    const rankedHigh = sections.map((_, index) => index).filter((index) => index > 0).sort((a, b) => (
      energies[b]! - energies[a]! || ((a + seed) % 5) - ((b + seed) % 5)
    ));
    const rankedLow = sections.map((_, index) => index).filter((index) => index > 0).sort((a, b) => (
      energies[a]! - energies[b]! || ((a + seed) % 5) - ((b + seed) % 5)
    ));
    const mainCount = 1 + ((seed >>> 11) & 1);
    const applyDevice = (index: number, device: Exclude<SectionDevice, 'none'>): void => {
      sections[index] = section(sections[index]!.backingDensity, sections[index]!.drum, device);
    };
    if (textureStrategy === 'counterDrive') {
      rankedHigh.slice(0, mainCount).forEach((index) => applyDevice(index, 'counter2'));
    } else if (textureStrategy === 'arpDrive') {
      rankedHigh.slice(0, mainCount).forEach((index) => applyDevice(index, 'arp2'));
      const echoIndex = rankedLow.find((index) => !rankedHigh.slice(0, mainCount).includes(index));
      if (echoIndex !== undefined && ((seed >>> 12) & 1) === 1) applyDevice(echoIndex, 'echo');
    } else if (textureStrategy === 'bassDrive') {
      applyDevice(rankedLow[0]!, 'counter1');
    } else if (textureStrategy === 'hybrid') {
      applyDevice(rankedHigh[0]!, ((seed >>> 12) & 1) === 0 ? 'arp1' : 'arp2');
      const counterIndex = rankedLow.find((index) => index !== rankedHigh[0]);
      if (counterIndex !== undefined) applyDevice(counterIndex, 'counter1');
      const echoIndex = rankedHigh.find((index) => index !== rankedHigh[0] && index !== counterIndex);
      if (echoIndex !== undefined && ((seed >>> 13) & 1) === 1) applyDevice(echoIndex, 'echo');
    } else {
      applyDevice(rankedLow[0]!, ((seed >>> 12) & 1) === 0 ? 'counter1' : 'echo');
    }
    const arrangementPolicy = songPlan?.compositionPolicy.arrangement;
    const sectionIndexFor = (id: string | null | undefined): number => id && songPlan
      ? songPlan.form.sections.findIndex((candidate) => candidate.id === id)
      : -1;
    const absenceIndex = sectionIndexFor(arrangementPolicy?.absenceSection);
    const returnIndex = sectionIndexFor(arrangementPolicy?.returnSection);
    const finaleIndex = sectionIndexFor(arrangementPolicy?.finaleSection);
    if (songPlan && arrangementPolicy?.emphasizeReturn) {
      if (absenceIndex >= 0) {
        const absenceDevice: SectionDevice = capabilitiesFor(songPlan.soundChip).echoDoubling
          && (textureStrategy === 'classic' || textureStrategy === 'arpDrive')
          ? 'echo'
          : 'none';
        sections[absenceIndex] = section('sparse', 'breakdown', absenceDevice);
      }
      if (returnIndex >= 0) {
        sections[returnIndex] = section('full', 'sectionB', returnDeviceFor(textureStrategy, songPlan));
      }
      if (finaleIndex >= 0) {
        sections[finaleIndex] = {
          ...sections[finaleIndex]!,
          backingDensity: 'full',
          drum: 'base',
        };
      }
    }
    const plannedSections = withTransitions(sections, energies, seed);
    plannedSections.forEach((section, index) => {
      section.leadColor = LEAD_COLOR_BY_ROLE[songPlan?.form.sections[index]?.role ?? 'hook'];
    });
    if (arrangementPolicy?.emphasizeReturn) {
      if (absenceIndex >= 0) plannedSections[absenceIndex]!.exitFill = 'full';
      if (returnIndex >= 0) plannedSections[returnIndex]!.entrance = 'cymbal';
    }
    return {
      arc: 'hookFirst', counterRole, textureStrategy, bassRole,
      sectionA: plannedSections[0]!, sectionB: plannedSections[1]!, sections: plannedSections,
    };
  }
  if (bars !== 16) {
    const device = textureStrategy === 'counterDrive'
      ? bars === 8 && ((seed >>> 4) & 1) === 1 ? 'counter2' : 'counter1'
      : textureStrategy === 'arpDrive'
        ? bars === 8 && ((seed >>> 4) & 1) === 1 ? 'arp2' : 'arp1'
        : textureStrategy === 'classic' && ((seed >>> 5) & 1) === 1 ? 'counter1' : 'none';
    const compact = section(
      ((seed >>> 6) & 1) === 0 ? 'full' : 'sparse',
      ((seed >>> 7) & 1) === 0 ? 'base' : 'sectionB',
      device,
    );
    compact.echo = capabilitiesFor(songPlan?.soundChip).echoDoubling
      && textureStrategy === 'classic'
      && ((seed >>> 8) & 1) === 1;
    compact.entrance = ((seed >>> 9) & 1) === 0 ? 'cymbal' : 'none';
    if (compact.ostinatoDensity > 0) {
      compact.ostinatoPeak = (['restatement', 'departure', 'conclusion'] as const)[
        (seed >>> 10) % 3
      ]!;
    }
    return {
      arc: 'compact',
      counterRole,
      textureStrategy,
      bassRole,
      sectionA: compact, sectionB: compact, sections: [compact],
    };
  }
  const energies = songPlan?.form.sections.map((item) => item.energy) ?? [2, 4];
  const arc = energies[1]! > energies[0]! ? 'build' : energies[1]! < energies[0]! ? 'contrast' : 'terrace';
  const firstFull = energies[0]! >= energies[1]!;
  const low = firstFull ? 1 : 0;
  const high = firstFull ? 0 : 1;
  const sections = [
    section(firstFull ? 'full' : 'sparse', firstFull ? 'sectionB' : 'base'),
    section(firstFull ? 'sparse' : 'full', firstFull ? 'breakdown' : 'sectionB'),
  ];
  if (textureStrategy === 'counterDrive') sections[high] = section('full', 'sectionB', 'counter2');
  else if (textureStrategy === 'arpDrive') {
    sections[low] = section('sparse', low === 0 ? 'base' : 'breakdown', 'echo');
    sections[high] = section('full', 'sectionB', 'arp1');
  } else if (textureStrategy === 'bassDrive') sections[low] = section('sparse', 'base', 'counter1');
  else if (textureStrategy === 'hybrid') {
    sections[low] = section('sparse', 'base', 'counter1');
    sections[high] = section('full', 'sectionB', 'arp1');
  } else sections[low] = section('sparse', 'base', 'counter1');
  const plannedSections = withTransitions(sections, energies, seed);
  plannedSections.forEach((section, index) => {
    section.leadColor = LEAD_COLOR_BY_ROLE[songPlan?.form.sections[index]?.role ?? 'hook'];
  });
  return {
    arc, counterRole, textureStrategy, bassRole,
    sectionA: plannedSections[0]!, sectionB: plannedSections[1]!, sections: plannedSections,
  };
}

/** 本編内の小節を編成区間へ写す。イントロは sectionA の薄い導入として扱う。 */
export function arrangementSectionFor(
  piece: Pick<Piece, 'bars' | 'loopStartBeat' | 'arrangementPlan'>,
  beat: number,
): ArrangementSectionPlan {
  if (beat < piece.loopStartBeat) return piece.arrangementPlan.sectionA;
  const bodyBar = Math.max(0, Math.floor((beat - piece.loopStartBeat) / 4));
  const index = piece.bars === 40
    ? Math.min(4, Math.floor(bodyBar / 8))
    : piece.bars === 16 && bodyBar >= 8 ? 1 : 0;
  return piece.arrangementPlan.sections[index] ?? piece.arrangementPlan.sectionA;
}

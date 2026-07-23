import type {
  ArrangementPlan,
  ArrangementSectionPlan,
  ComposeBars,
  Piece,
} from './compose.js';
import type { SongPlan } from './song-plan.js';

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
});

/** 帰還区間の前進感を、曲全体で選ばれたテクスチャ戦略の主役から導く。 */
function returnDeviceFor(
  textureStrategy: ArrangementPlan['textureStrategy'],
  plan: SongPlan,
): SectionDevice {
  if (textureStrategy === 'counterDrive') return 'counter2';
  if (textureStrategy === 'arpDrive') return plan.soundChip === 'opll' ? 'arp2' : 'counter2';
  if (textureStrategy === 'bassDrive') return 'counter1';
  if (textureStrategy === 'hybrid') return plan.soundChip === 'opll' ? 'arp2' : 'counter2';
  return plan.soundChip === 'opll' ? 'echo' : 'counter1';
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
): ArrangementPlan['textureStrategy'] {
  if (!plan) {
    const fallback = bars < 16
      ? ['classic', 'counterDrive', 'arpDrive', 'bassDrive'] as const
      : ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'] as const;
    return fallback[(seed >>> 1) % fallback.length]!;
  }
  let candidates: ArrangementPlan['textureStrategy'][];
  if (plan.soundChip === 'nes2a03') {
    // 2パルス+三角波では、独立アルペジオを作って後段で捨てない。
    candidates = plan.styleId === 'ska' ? ['counterDrive', 'classic'] : ['bassDrive', 'classic'];
  } else if (plan.styleId === 'rock') {
    candidates = ['bassDrive', 'counterDrive', 'hybrid'];
  } else if (plan.styleId === 'ska') {
    candidates = ['counterDrive', 'hybrid'];
  } else {
    candidates = ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'];
  }
  if (plan.melodyDensity >= 5.75) candidates = candidates.filter((item) => item !== 'hybrid');
  // 短形式の三連は既存フレーズへ重ねる層なので、ここで編成候補まで変えて主旋律を作り直さない。
  if (plan.grooveFeel === 'tripletOverlay' && bars >= 16) {
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

/**
 * 曲全体のテクスチャ設計。奏法は「使えるから全部使う」のではなく、
 * 主役を一つ決め、別区間で休止・再登場させる。音数制限より前に密度を整理する。
 */
export function arrangementPlanFor(
  bars: ComposeBars,
  seed: number,
  progressionId?: string,
  songPlan?: SongPlan,
): ArrangementPlan {
  const textureStrategy = textureStrategyFor(bars, seed, songPlan);
  const counterRole = textureStrategy === 'counterDrive' || textureStrategy === 'hybrid'
    ? 'counterline'
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
        const absenceDevice: SectionDevice = songPlan.soundChip === 'opll'
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
    compact.echo = songPlan?.soundChip !== 'nes2a03'
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

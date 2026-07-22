import type {
  ArrangementPlan,
  ArrangementSectionPlan,
  ComposeBars,
  Piece,
} from './compose.js';
import type { SongPlan } from './song-plan.js';

const section = (
  backingDensity: ArrangementSectionPlan['backingDensity'],
  drum: ArrangementSectionPlan['drum'],
  device: 'none' | 'echo' | 'counter1' | 'counter2' | 'arp1' | 'arp2' = 'none',
): ArrangementSectionPlan => ({
  backingDensity,
  drum,
  echo: device === 'echo',
  counterDensity: device === 'counter1' ? 1 : device === 'counter2' ? 2 : 0,
  ostinatoDensity: device === 'arp1' ? 1 : device === 'arp2' ? 2 : 0,
});

/** seedは互換候補内の揺らぎにだけ使い、候補集合そのものは曲調・密度・チップで決める。 */
function textureStrategyFor(
  bars: ComposeBars,
  seed: number,
  plan: SongPlan | undefined,
): ArrangementPlan['textureStrategy'] {
  if (bars < 16) return 'classic';
  if (!plan) {
    const fallback = ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'] as const;
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
  if (plan.grooveFeel === 'tripletOverlay') candidates = candidates.filter((item) => item !== 'arpDrive');
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
    const sections = textureStrategy === 'counterDrive'
      ? [
        section('full', 'sectionB'), section('sparse', 'base', 'counter2'),
        section('sparse', 'breakdown'), section('full', 'sectionB', 'counter2'), section('full', 'sectionB'),
      ]
      : textureStrategy === 'arpDrive'
        ? [
          section('full', 'sectionB'), section('sparse', 'base', 'arp2'),
          section('sparse', 'breakdown'), section('full', 'sectionB', 'arp2'), section('full', 'sectionB', 'echo'),
        ]
        : textureStrategy === 'bassDrive'
          ? [
            section('full', 'sectionB'), section('sparse', 'base', 'counter1'),
            section('sparse', 'breakdown'), section('full', 'sectionB'), section('full', 'sectionB', 'counter1'),
          ]
          : textureStrategy === 'hybrid'
            ? [
              section('full', 'base', 'counter1'), section('sparse', 'sectionB', 'arp1'),
              section('sparse', 'breakdown'), section('full', 'sectionB', 'arp2'), section('sparse', 'base', 'counter1'),
            ]
            : [
              section('full', 'base'), section('sparse', 'sectionB', 'counter1'),
              section('sparse', 'breakdown'), section('full', 'sectionB'), section('full', 'base', 'echo'),
            ];
    return {
      arc: 'hookFirst', counterRole, textureStrategy, bassRole,
      sectionA: sections[0]!, sectionB: sections[1]!, sections,
    };
  }
  if (bars !== 16) {
    const compact = {
      ...section('full', 'base', 'counter1'),
      // OPLLの短いフォームは、主旋律の薄いディレイを標準編成の一部として扱う。
      echo: songPlan?.soundChip !== 'nes2a03',
    };
    return {
      arc: 'compact', counterRole: 'response', textureStrategy: 'classic', bassRole: 'rootMotion',
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
  return {
    arc, counterRole, textureStrategy, bassRole,
    sectionA: sections[0]!, sectionB: sections[1]!, sections,
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

import type {
  AccompanimentFigure,
  ArrangementPlan,
  ArrangementSectionPlan,
  PhraseFunction,
  Piece,
  SongFormSpec,
  TupletDivision,
  TupletOverlayPolicy,
} from './types.js';
import type { SectionRole, SongPlan } from './types.js';
import { SECTION_ENERGY_MAX, sectionIndexAt } from './form.js';
import { grooveFor } from './groove.js';
import { GROUPING_DISSONANCES } from './metric-modulation.js';
import { capabilitiesFor } from './sound-capabilities.js';
import { CHORDS, accompanimentCandidates, hasArpeggioAccompaniment, styleForId } from './theory.js';
import type { TextureFacet } from './theory.js';
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
  backingRhythm: 'normal',
  accompaniment: 'pad',
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

const PEAK_CHOICES = ['restatement', 'departure', 'conclusion'] as const;

/** 16分へ加速するフレーズ位置の抽選。区間ごとに同じ場所へ固定しない(withTransitions と同じ写像)。 */
function ostinatoPeakFor(seed: number, index: number): PhraseFunction {
  return PEAK_CHOICES[(seed + index * 5) % PEAK_CHOICES.length]!;
}

/** 区間の力(SectionEnergy 1〜5)を伴奏型の候補列(力の弱い順)の添字へ写す。候補 3 つなら 1-2 / 3-4 / 5。 */
function figureIndexFor(energy: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(((energy - 1) * count) / SECTION_ENERGY_MAX)));
}

/**
 * 区間の伴奏型を確定する。曲型の明示指定(SectionSpec.accompaniment)があればそれ、無ければ
 * 様式の候補列(StyleDef.texture.accompaniment、力の弱い順)へ区間の力を写して選ぶ。
 * - 候補が保続(pad)だけの装置型の様式では、何も変えない(分散和音はテクスチャ戦略の装置のまま)。
 * - 分散和音の型は ostinatoDensity(16分=2、8分=1)になり、全小節に敷く伴奏役として鳴る
 *   (ostinato-voice は区間の accompaniment を見てフレーズ帯の間引きをしない)。独立アルペジオの
 *   予算が無いバックエンドでは chords へ落とす。
 * - 分散和音が伴奏役の様式で保続・拍打ちが選ばれた区間は、装置として置かれた分散和音も外す
 *   (伴奏を 2 重に置かない)。装置型の様式では装置をそのまま残す。
 * - 拍打ち(chords)は backingRhythm 'beat'(各拍頭でブロックコード)。
 */
function withAccompaniment(
  plan: ArrangementPlan,
  form: SongFormSpec,
  seed: number,
  songPlan: SongPlan | undefined,
  texture: TextureFacet | undefined,
): ArrangementPlan {
  const candidates = accompanimentCandidates(texture);
  const arpeggioRole = hasArpeggioAccompaniment(texture);
  const independent = capabilitiesFor(songPlan?.soundChip).independentArpeggio;
  const energies = songPlan?.form.sections.map((item) => item.energy) ?? form.sections.map((item) => item.energy);
  const sections = plan.sections.map((section, index) => {
    const requested = form.sections[index]?.accompaniment
      ?? candidates[figureIndexFor(energies[index] ?? 3, candidates.length)]!;
    const figure: AccompanimentFigure = !independent && (requested === 'arpeggio8' || requested === 'arpeggio16')
      ? 'chords'
      : requested;
    const ostinatoDensity: ArrangementSectionPlan['ostinatoDensity'] = figure === 'arpeggio16'
      ? 2
      : figure === 'arpeggio8'
        ? 1
        : arpeggioRole ? 0 : section.ostinatoDensity;
    return {
      ...section,
      accompaniment: figure,
      backingRhythm: figure === 'chords' ? 'beat' as const : section.backingRhythm,
      ostinatoDensity,
      ostinatoPeak: ostinatoDensity > 0 ? section.ostinatoPeak ?? ostinatoPeakFor(seed, index) : null,
    };
  });
  return { ...plan, sections };
}

function withTransitions(
  source: readonly ArrangementSectionPlan[],
  energies: readonly number[],
  seed: number,
): ArrangementSectionPlan[] {
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
      ostinatoPeak: item.ostinatoDensity > 0 ? ostinatoPeakFor(seed, index) : null,
    };
  });
}

/** seedは互換候補内の揺らぎにだけ使い、候補集合そのものは曲調・密度・チップで決める。 */
function textureStrategyFor(
  form: SongFormSpec,
  seed: number,
  plan: SongPlan | undefined,
  texture: TextureFacet | undefined,
  forceArp: boolean,
): ArrangementPlan['textureStrategy'] {
  const singleSection = form.sections.length === 1;
  // 連符レイヤー有効時は、担い手のオスティナート区間が必ず生まれる編成に固定する。
  if (forceArp) return 'arpDrive';
  if (!plan) {
    const fallback = singleSection
      ? ['classic', 'counterDrive', 'arpDrive', 'bassDrive'] as const
      : ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'] as const;
    return fallback[(seed >>> 1) % fallback.length]!;
  }
  let candidates: ArrangementPlan['textureStrategy'][];
  if (!capabilitiesFor(plan.soundChip).independentArpeggio) {
    // 独立アルペジオの声部予算が無いバックエンドでは、作って後段で捨てない。
    candidates = [texture?.compactStrategy ?? 'bassDrive', 'classic'];
  } else {
    candidates = [...(texture?.strategies ?? ['counterDrive', 'arpDrive', 'bassDrive', 'hybrid'])];
  }
  if (plan.melodyDensity >= 5.75) candidates = candidates.filter((item) => item !== 'hybrid');
  // 短形式の細分オーバーレイは既存フレーズへ重ねる層なので、ここで編成候補まで変えて主旋律を作り直さない。
  if (grooveFor(plan.grooveFeel).subdivisionOverlay !== 'none' && !singleSection) {
    candidates = candidates.filter((item) => item !== 'arpDrive');
  }
  if (singleSection) {
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
 * 連符レイヤーを担う区間を確定する。数値指定は全区間同値。autoは区間エネルギーの
 * 順位を拍節的不協和の緊張度順位（metric-modulation.tsのカタログ順）へ写す:
 * 頂点区間=最も不協和な分割、中位=中位、それ以外と単一区間=最も協和的な分割。
 */
function withTupletLayer(
  plan: ArrangementPlan,
  tuplet: Exclude<TupletOverlayPolicy, 'off'>,
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
      ostinatoPeak: ostinatoPeakFor(seed, index),
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
    const division: TupletDivision = tuplet !== 'bySection'
      ? tuplet
      : sections.length === 1
        ? calmest
        : arpEnergies[i] === peakEnergy ? tensest : energies[i]! >= median ? middle : calmest;
    return { ...item, ostinatoTuplet: division };
  });
  return { ...plan, sections: mapped };
}

/**
 * 曲全体のテクスチャ設計。奏法は「使えるから全部使う」のではなく、
 * 主役を一つ決め、別区間で休止・再登場させる。音数制限より前に密度を整理する。
 */
export function arrangementPlanFor(
  form: SongFormSpec,
  seed: number,
  progressionId?: string,
  songPlan?: SongPlan,
  /** 解決済みの連符方針(devices.ts)。能力・グルーヴのゲートは解決側が済ませている。 */
  tupletOverlay: TupletOverlayPolicy = 'off',
): ArrangementPlan {
  const texture = songPlan ? styleForId(songPlan.styleId)?.texture : undefined;
  const plan = withAccompaniment(
    planArrangement(form, seed, progressionId, songPlan, texture, tupletOverlay !== 'off'),
    form, seed, songPlan, texture,
  );
  return withSectionTextures(tupletOverlay === 'off' ? plan : withTupletLayer(plan, tupletOverlay, seed, songPlan), form);
}

/**
 * 区間テクスチャ(SectionSpec.texture)を編成へ写す。旋律を持たない区間は副旋律・分散和音・連符・
 * エコーを持たず、sustain は伴奏を再打鍵せずドラムを落とし、pulse は厚い伴奏を格子で刻む。
 */
function withSectionTextures(plan: ArrangementPlan, form: SongFormSpec): ArrangementPlan {
  if (!form.sections.some((spec) => spec.texture !== undefined && spec.texture !== 'normal')) return plan;
  const sections = plan.sections.map((section, index) => {
    const texture = form.sections[index]?.texture ?? 'normal';
    if (texture === 'normal') return section;
    return {
      ...section,
      backingRhythm: texture === 'sustain' ? 'sustain' as const : 'stab' as const,
      // 伴奏の刻み方はテクスチャが決める(伴奏型の選択は無効。validateForm が明示指定を弾く)。
      accompaniment: 'pad' as const,
      backingDensity: 'full' as const,
      drum: texture === 'sustain' ? 'breakdown' as const : section.drum,
      echo: false,
      counterDensity: 0 as const,
      ostinatoDensity: 0 as const,
      ostinatoPeak: null,
      ostinatoTuplet: null,
    };
  });
  return { ...plan, sections };
}

function planArrangement(
  form: SongFormSpec,
  seed: number,
  progressionId: string | undefined,
  songPlan: SongPlan | undefined,
  texture: TextureFacet | undefined,
  forceArp: boolean,
): ArrangementPlan {
  const count = form.sections.length;
  const textureStrategy = textureStrategyFor(form, seed, songPlan, texture, forceArp);
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

  if (count >= 3) {
    // 3区間以上: エネルギーの順位で厚み・装置を配る(区間数に上限はない)。
    const energies = songPlan?.form.sections.map((item) => item.energy)
      ?? form.sections.map((item) => item.energy);
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
    return { arc: 'hookFirst', counterRole, textureStrategy, bassRole, sections: plannedSections };
  }
  if (count === 1) {
    const eightBars = form.sections[0]!.bars === 8;
    const device = textureStrategy === 'counterDrive'
      ? eightBars && ((seed >>> 4) & 1) === 1 ? 'counter2' : 'counter1'
      : textureStrategy === 'arpDrive'
        ? eightBars && ((seed >>> 4) & 1) === 1 ? 'arp2' : 'arp1'
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
      compact.ostinatoPeak = PEAK_CHOICES[(seed >>> 10) % PEAK_CHOICES.length]!;
    }
    return { arc: 'compact', counterRole, textureStrategy, bassRole, sections: [compact] };
  }
  const energies = songPlan?.form.sections.map((item) => item.energy)
    ?? form.sections.map((item) => item.energy);
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
  return { arc, counterRole, textureStrategy, bassRole, sections: plannedSections };
}

/** 本編内の小節を編成区間へ写す。イントロは先頭区間の薄い導入として扱う。 */
export function arrangementSectionFor(
  piece: Pick<Piece, 'loopStartBeat' | 'arrangementPlan'> & { songPlan: Pick<SongPlan, 'form'> },
  beat: number,
): ArrangementSectionPlan {
  const sections = piece.arrangementPlan.sections;
  if (beat < piece.loopStartBeat) return sections[0]!;
  const bodyBar = Math.max(0, Math.floor((beat - piece.loopStartBeat) / 4));
  return sections[sectionIndexAt(piece.songPlan.form, bodyBar)] ?? sections[0]!;
}

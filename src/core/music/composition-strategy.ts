/**
 * ブラインド比較で切り替える作曲戦略。
 * 既存の保存曲は compositionStrategy を持たないため、current と同じ挙動になる。
 */
export type CompositionStrategy = 'current' | 'memoryArc' | 'premiseArc';
export type StrategySectionId = 'A' | 'B' | 'C' | 'D' | 'E';
export type CompositionPremise = 'forwardLonging';
export type PolicyMotifTransform = 'transpose' | 'invert';

export interface MotifReturnEvent {
  from: StrategySectionId;
  to: StrategySectionId;
  phrases: readonly (0 | 1 | 2 | 3)[];
  transform: PolicyMotifTransform;
}

export interface CompositionPolicy {
  strategy: CompositionStrategy;
  /** ブラインド比較の対象である40小節フォームでだけ、上位戦略を作曲へ適用する。 */
  active: boolean;
  premise: CompositionPremise | null;
  motif: {
    absenceSections: readonly StrategySectionId[];
    returnEvent: MotifReturnEvent | null;
    continuationEvent: MotifReturnEvent | null;
  };
  surface: {
    /** nullなら既存のシード依存エネルギー弧を使う。 */
    sectionEnergies: readonly number[] | null;
    valleySection: StrategySectionId | null;
    peakSection: StrategySectionId | null;
  };
  harmony: {
    /** 不在区間では同じ進行スロット内でトニックを避け、主題帰還時はAの選択を回帰させる。 */
    absenceSection: StrategySectionId | null;
    returnEvent: Pick<MotifReturnEvent, 'from' | 'to'> | null;
    avoidTonicDuringAbsence: boolean;
    delayResolution: boolean;
  };
  melody: {
    /** 表層の頂点に対して帰還主題を内向きに置く、半音単位の目標変位。 */
    returnRegister: (Pick<MotifReturnEvent, 'from' | 'to'> & { offset: number }) | null;
  };
  arrangement: {
    absenceSection: StrategySectionId | null;
    returnSection: StrategySectionId | null;
    finaleSection: StrategySectionId | null;
    emphasizeReturn: boolean;
  };
}

export interface CompositionStrategyInfo {
  id: CompositionStrategy;
  condition: 1 | 2 | 3;
  label: string;
  description: string;
}

export const COMPOSITION_STRATEGIES: readonly CompositionStrategyInfo[] = [
  {
    id: 'current',
    condition: 1,
    label: '通常構成',
    description: '現在の作曲エンジン。各区間でモチーフを展開しながら40小節を構成します。',
  },
  {
    id: 'memoryArc',
    condition: 2,
    label: '不在と帰還',
    description: 'Aの主題をB・Cでは伏せ、Dで二つのフレーズを変奏して帰還させます。',
  },
  {
    id: 'premiseArc',
    condition: 3,
    label: '中心命題',
    description: '不在と帰還に加え、前進する表層と帰りたがる旋律・和声の対立を全体へ通します。',
  },
] as const;

const inactivePolicy = (strategy: CompositionStrategy): CompositionPolicy => ({
  strategy,
  active: false,
  premise: null,
  motif: { absenceSections: [], returnEvent: null, continuationEvent: null },
  surface: { sectionEnergies: null, valleySection: null, peakSection: null },
  harmony: {
    absenceSection: null,
    returnEvent: null,
    avoidTonicDuringAbsence: false,
    delayResolution: false,
  },
  melody: { returnRegister: null },
  arrangement: {
    absenceSection: null,
    returnSection: null,
    finaleSection: null,
    emphasizeReturn: false,
  },
});

/**
 * 戦略名を、全作曲層が共有する実効ポリシーへ一度だけ解決する。
 * 下流はstrategy名を再判定せず、この意味イベントを消費する。
 */
export function resolveCompositionPolicy(
  strategy: CompositionStrategy,
  bars: number,
  seed: number,
): CompositionPolicy {
  if (bars !== 40 || strategy === 'current') return inactivePolicy(strategy);

  const returnTransform: PolicyMotifTransform = strategy === 'premiseArc'
    ? 'transpose'
    : ((seed >>> 7) & 1) === 0 ? 'transpose' : 'invert';
  const continuationTransform: PolicyMotifTransform = ((seed >>> 9) & 1) === 0
    ? 'invert'
    : 'transpose';
  const motif: CompositionPolicy['motif'] = {
    absenceSections: ['B', 'C'],
    returnEvent: { from: 'A', to: 'D', phrases: [0, 1], transform: returnTransform },
    continuationEvent: { from: 'D', to: 'E', phrases: [0], transform: continuationTransform },
  };

  if (strategy === 'memoryArc') {
    return { ...inactivePolicy(strategy), active: true, motif };
  }

  // Cを谷、Dを一意な頂点に保ちながら、絶対値はシードで揺らして固定表への収束を避ける。
  const energyArcs = [
    [4, 3, 2, 5, 4],
    [3, 4, 2, 5, 3],
    [4, 2, 1, 5, 3],
    [3, 2, 1, 5, 4],
  ] as const;
  return {
    strategy,
    active: true,
    premise: 'forwardLonging',
    motif,
    surface: {
      sectionEnergies: energyArcs[(seed >>> 2) % energyArcs.length]!,
      valleySection: 'C',
      peakSection: 'D',
    },
    harmony: {
      absenceSection: 'C',
      returnEvent: { from: 'A', to: 'D' },
      avoidTonicDuringAbsence: true,
      delayResolution: true,
    },
    melody: { returnRegister: { from: 'A', to: 'D', offset: -3 } },
    arrangement: {
      absenceSection: 'C',
      returnSection: 'D',
      finaleSection: 'E',
      emphasizeReturn: true,
    },
  };
}

export function compositionStrategyInfo(id: CompositionStrategy): CompositionStrategyInfo {
  return COMPOSITION_STRATEGIES.find((strategy) => strategy.id === id)!;
}

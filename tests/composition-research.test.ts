import { describe, expect, it } from 'vitest';
import {
  COMPOSITION_EXPERIMENTS,
  COMPOSITION_HYPOTHESES,
  compositionExperiment,
} from '../src/core/music/composition-research.js';

describe('作曲仮説と検証履歴', () => {
  it('仮説と実験のIDが一意で、参照先が存在する', () => {
    expect(new Set(COMPOSITION_EXPERIMENTS.map((experiment) => experiment.id)).size)
      .toBe(COMPOSITION_EXPERIMENTS.length);
    expect(new Set(COMPOSITION_HYPOTHESES.map((hypothesis) => hypothesis.id)).size)
      .toBe(COMPOSITION_HYPOTHESES.length);

    for (const hypothesis of COMPOSITION_HYPOTHESES) {
      for (const experimentId of hypothesis.experimentIds) {
        expect(compositionExperiment(experimentId), `${hypothesis.id} -> ${experimentId}`).toBeDefined();
      }
    }
  });

  it('最初の3条件比較を3対3対3の探索的結果として残す', () => {
    const experiment = compositionExperiment('EXP-001')!;
    expect(experiment.status).toBe('completed');
    expect(experiment.result).toContain('通常3・不在と帰還3・中心命題3');
    expect(experiment.result).toContain('顕著な差は観測されなかった');
    expect(experiment.limitations.some((limitation) => limitation.includes('9試行'))).toBe(true);
  });

  it('再登場時期は差が小さい、エネルギー弧は一部検証として区別する', () => {
    const motifReturn = COMPOSITION_HYPOTHESES.find((hypothesis) => hypothesis.id === 'HYP-001')!;
    const energyArc = COMPOSITION_HYPOTHESES.find((hypothesis) => hypothesis.id === 'HYP-002')!;

    expect(motifReturn.status).toBe('tested');
    expect(motifReturn.assessment).toContain('差は小さい');
    expect(energyArc.status).toBe('partiallyTested');
    expect(energyArc.assessment).toContain('単独では検証できていない');
  });

  it('未検証仮説には次の比較方法がある', () => {
    const untested = COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'untested');
    expect(untested).toHaveLength(7);
    expect(untested.every((hypothesis) => hypothesis.nextComparison.length > 0)).toBe(true);
  });
});

/**
 * 作曲仮説と検証履歴の表示パネル（研究ログUI）。
 * データの正本は core/music/composition-research.ts。ここは純表示で状態を持たない。
 */

import {
  COMPOSITION_EXPERIMENTS,
  COMPOSITION_EXPERIMENT_STATUS_LABELS,
  COMPOSITION_HYPOTHESES,
  COMPOSITION_HYPOTHESIS_STATUS_LABELS,
} from '../core/music/composition-research.js';

const COMPOSITION_RESEARCH_COUNTS = {
  tested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'tested').length,
  partiallyTested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'partiallyTested').length,
  untested: COMPOSITION_HYPOTHESES.filter((hypothesis) => hypothesis.status === 'untested').length,
} as const;

export function CompositionResearchPanel() {
  return (
    <details className="composition-research" data-testid="composition-research">
      <summary>
        <span>作曲仮説と検証履歴</span>
        <small>
          検証済み {COMPOSITION_RESEARCH_COUNTS.tested} ／
          一部検証 {COMPOSITION_RESEARCH_COUNTS.partiallyTested} ／
          未検証 {COMPOSITION_RESEARCH_COUNTS.untested}
        </small>
      </summary>
      <div className="composition-research-body">
        <p className="composition-research-intro">
          比較で分かったことと、まだ比較できていない仮説を同じ研究ログで管理します。
          新しい条件は、ここに仮説と比較方法を書いてから追加します。
        </p>

        <section className="composition-experiment-history" aria-labelledby="composition-experiment-title">
          <h4 id="composition-experiment-title">今までに検証したことと結果</h4>
          {COMPOSITION_EXPERIMENTS.map((experiment, index) => (
            <article key={experiment.id} className="composition-experiment" data-testid={`composition-experiment-${experiment.id}`}>
              <header>
                <div>
                  <small>{index === COMPOSITION_EXPERIMENTS.length - 1 ? '直近の検証' : experiment.id}</small>
                  <h5>{experiment.title}</h5>
                </div>
                <span className={`research-status experiment-${experiment.status}`}>
                  {COMPOSITION_EXPERIMENT_STATUS_LABELS[experiment.status]}
                </span>
              </header>
              <p><b>問い:</b> {experiment.question}</p>
              <div className="composition-condition-list" aria-label="比較条件">
                {experiment.conditions.map((condition) => <span key={condition}>{condition}</span>)}
              </div>
              <p className="composition-experiment-result"><b>結果:</b> {experiment.result}</p>
              <p><b>暫定結論:</b> {experiment.conclusion}</p>
              <details className="composition-limitations">
                <summary>この結果でまだ言えないこと</summary>
                <ul>
                  {experiment.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                </ul>
              </details>
            </article>
          ))}
        </section>

        <section className="composition-hypothesis-section" aria-labelledby="composition-hypothesis-title">
          <h4 id="composition-hypothesis-title">仮説リスト</h4>
          <p>未検証のものを順次、同じ素材を使ったブラインド比較へ入れていきます。</p>
          <div className="composition-hypothesis-list">
            {COMPOSITION_HYPOTHESES.map((hypothesis) => (
              <details
                key={hypothesis.id}
                className={`composition-hypothesis hypothesis-${hypothesis.status}`}
                data-testid={`composition-hypothesis-${hypothesis.id}`}
              >
                <summary>
                  <span>
                    <small>{hypothesis.id}</small>
                    {hypothesis.title}
                  </span>
                  <b className={`research-status hypothesis-${hypothesis.status}`}>
                    {COMPOSITION_HYPOTHESIS_STATUS_LABELS[hypothesis.status]}
                  </b>
                </summary>
                <div className="composition-hypothesis-detail">
                  <p><b>仮説:</b> {hypothesis.proposition}</p>
                  <p><b>現在の判断:</b> {hypothesis.assessment}</p>
                  {hypothesis.experimentIds.length > 0 && (
                    <p><b>根拠:</b> {hypothesis.experimentIds.join('、')}</p>
                  )}
                  <p><b>次の比較:</b> {hypothesis.nextComparison}</p>
                </div>
              </details>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

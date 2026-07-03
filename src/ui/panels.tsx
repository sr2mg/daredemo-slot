import { useState } from 'react';
import { simulate } from '../core/sim.js';
import type { SimResult, StrategyName } from '../core/sim.js';
import type { MachineDef } from '../core/types.js';
import { checkLayout } from '../core/validate.js';
import type { LayoutReport } from '../core/validate.js';

const STRATEGY_LABEL: Record<StrategyName, string> = {
  naive: '適当打ち',
  navFollow: 'ナビ追従',
  perfect: '完全打ち',
};

/**
 * スペック実測パネルと配列チェックパネル
 * （docs/design/05 保存時検証パイプライン 3・4 の WebUI 前倒し実装）。
 * TODO: 計測は同期実行なので大きなゲーム数では UI が数秒固まる。Worker 化は将来。
 */

function oneIn(games: number, count: number): string {
  return count > 0 ? `1/${(games / count).toFixed(1)}` : '—';
}

export function SpecPanel({ machine }: { machine: MachineDef }) {
  const [games, setGames] = useState(100_000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Partial<Record<StrategyName, SimResult>> | null>(null);

  // ナビ層のある機種は「ナビ追従（AT の実戦値）」も測る
  const strategies: StrategyName[] = machine.nav ? ['naive', 'navFollow', 'perfect'] : ['naive', 'perfect'];

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const seed = Date.now() >>> 0;
      const results: Partial<Record<StrategyName, SimResult>> = {};
      for (const strategy of strategies) {
        results[strategy] = simulate(machine, { games, strategy, seed });
      }
      setResult(results);
      setBusy(false);
    }, 30);
  };

  const bonusIds = machine.bonuses.map((b) => b.id);

  return (
    <details className="panel">
      <summary>スペック実測（機械割チェック）</summary>
      <div className="panel-body">
        <div className="panel-controls">
          <select value={games} onChange={(e) => setGames(Number(e.target.value))} disabled={busy}>
            <option value={10_000}>1万ゲーム（すぐ）</option>
            <option value={100_000}>10万ゲーム（標準）</option>
            <option value={500_000}>50万ゲーム（じっくり）</option>
          </select>
          <button onClick={run} disabled={busy} data-testid="run-spec">
            {busy ? '計測中…' : '実測する'}
          </button>
        </div>
        {result && (
          <table className="spec-table" data-testid="spec-result">
            <thead>
              <tr>
                <th></th>
                {strategies.map((s) => (
                  <th key={s}>{STRATEGY_LABEL[s]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>機械割</td>
                {strategies.map((s) => (
                  <td key={s}>{((result[s]?.payoutRate ?? 0) * 100).toFixed(1)}%</td>
                ))}
              </tr>
              {bonusIds.map((id) => (
                <tr key={id}>
                  <td>{id}</td>
                  {strategies.map((s) => (
                    <td key={s}>{oneIn(result[s]?.games ?? 0, result[s]?.bonusStarts[id] ?? 0)}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>リプレイ</td>
                {strategies.map((s) => (
                  <td key={s}>{oneIn(result[s]?.games ?? 0, result[s]?.replayCount ?? 0)}</td>
                ))}
              </tr>
              {machine.nav && (
                <tr>
                  <td>AT 滞在率</td>
                  {strategies.map((s) => (
                    <td key={s}>{(((result[s]?.atGames ?? 0) / (result[s]?.games ?? 1)) * 100).toFixed(1)}%</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        )}
        {result && result.naive && result.perfect && (
          <p className="panel-note">
            完全打ちとの差 {((result.perfect.payoutRate - result.naive.payoutRate) * 100).toFixed(1)}pt が技術介入度（ナビ・目押し）の指標
          </p>
        )}
      </div>
    </details>
  );
}

export function LayoutPanel({ machine }: { machine: MachineDef }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<LayoutReport | null>(null);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      setReport(checkLayout(machine));
      setBusy(false);
    }, 30);
  };

  return (
    <details className="panel">
      <summary>リール配列チェック（総当たり検証）</summary>
      <div className="panel-body">
        <div className="panel-controls">
          <button onClick={run} disabled={busy} data-testid="run-layout">
            {busy ? '検証中…' : '検証する'}
          </button>
        </div>
        {report && (
          <div data-testid="layout-result">
            <p className={report.ok ? 'badge-ok' : 'badge-ng'}>
              {report.ok ? '✓ 配列は全制約を満たしています' : '✗ 配列に問題があります'}
              （{report.casesChecked.toLocaleString()} ケース検証）
            </p>
            <table className="spec-table">
              <tbody>
                <tr>
                  <td>蹴飛ばし違反（非成立役の入賞）</td>
                  <td className={report.kickViolations === 0 ? 'ok' : 'ng'}>{report.kickViolations}</td>
                </tr>
                <tr>
                  <td>リプレイ取りこぼし</td>
                  <td className={report.replayMisses === 0 ? 'ok' : 'ng'}>{report.replayMisses}</td>
                </tr>
              </tbody>
            </table>
            <table className="spec-table">
              <thead>
                <tr>
                  <th>役</th>
                  <th>宣言</th>
                  <th>実測引き込み率</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {report.roleChecks.map((check) => (
                  <tr key={check.id}>
                    <td>{check.id}</td>
                    <td>
                      {check.declared === 'guaranteed'
                        ? 'PB=1'
                        : `目標 ${(check.declared.missable.targetRate * 100).toFixed(0)}%`}
                    </td>
                    <td>{(check.measured * 100).toFixed(1)}%</td>
                    <td className={check.ok ? 'ok' : 'ng'}>{check.ok ? '✓' : '✗'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

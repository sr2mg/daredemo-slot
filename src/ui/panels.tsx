import { useMemo, useState } from 'react';
import { checkCompliance, RULESETS } from '../core/compliance.js';
import type { ComplianceResult, RulesetId } from '../core/compliance.js';
import { describeMachine } from '../core/describe.js';
import { simulate } from '../core/sim.js';
import type { SimResult, StrategyName } from '../core/sim.js';
import type { MachineDef } from '../core/types.js';
import { checkLayout } from '../core/validate.js';
import type { LayoutReport } from '../core/validate.js';
import { guides } from './guides.js';

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

/**
 * 遊び方ガイド + スペック表。
 * プリセットは手書きの読み物（guides.ts）を優先し、スペック表は定義から自動生成する。
 * カスタム機種は説明文も自動生成なので、作った機種にもガイドが付く。
 */
export function GuidePanel({ machine }: { machine: MachineDef }) {
  const manual = guides[machine.name];
  const auto = useMemo(() => {
    try {
      const report = checkLayout(machine);
      const measuredPullIn = Object.fromEntries(report.roleChecks.map((c) => [c.id, c.measured]));
      return describeMachine(machine, { measuredPullIn });
    } catch {
      return null;
    }
  }, [machine]);
  if (!manual && !auto) return null;
  const hasSettingColumn = auto?.specRows.some((r) => r.probMax !== null) ?? false;

  return (
    <details className="panel" open>
      <summary>この機種の遊び方とスペック</summary>
      <div className="panel-body">
        <p className="guide-summary">{manual?.summary ?? auto?.summary}</p>
        <ul className="guide-list">
          {(manual?.points ?? auto?.points ?? []).map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        {auto && (
          <>
            <table className="spec-table" data-testid="guide-spec">
              <thead>
                <tr>
                  <th>役</th>
                  <th>払い出し</th>
                  <th>{hasSettingColumn ? '確率（設定1）' : '確率'}</th>
                  {hasSettingColumn && <th>確率（最高設定）</th>}
                  <th>備考</th>
                </tr>
              </thead>
              <tbody>
                {auto.specRows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td>{row.payout}</td>
                    <td>{row.prob}</td>
                    {hasSettingColumn && <td>{row.probMax ?? '同左'}</td>}
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="panel-note">{auto.rateNote}（理論近似値）</p>
          </>
        )}
        <p className="panel-note">操作: Space = レバー / J・K・L = 左・中・右停止</p>
      </div>
    </details>
  );
}

export function SpecPanel({ machine }: { machine: MachineDef }) {
  const [games, setGames] = useState(100_000);
  const [setting, setSetting] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Partial<Record<StrategyName, SimResult>> | null>(null);
  const settings = machine.lottery.settings ?? 1;

  // ナビ層のある機種は「ナビ追従（AT の実戦値）」も測る
  const strategies: StrategyName[] = machine.nav ? ['naive', 'navFollow', 'perfect'] : ['naive', 'perfect'];

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const seed = Date.now() >>> 0;
      const results: Partial<Record<StrategyName, SimResult>> = {};
      for (const strategy of strategies) {
        results[strategy] = simulate(machine, { games, strategy, seed, setting });
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
          {settings > 1 && (
            <select value={setting} onChange={(e) => setSetting(Number(e.target.value))} disabled={busy}>
              {Array.from({ length: settings }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  設定{n}
                </option>
              ))}
            </select>
          )}
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

export function CompliancePanel({ machine }: { machine: MachineDef }) {
  const [ruleset, setRuleset] = useState<RulesetId>('yon');
  const [setting, setSetting] = useState(1);
  const [mode, setMode] = useState<'quick' | 'standard'>('quick');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ComplianceResult | null>(null);
  const settings = machine.lottery.settings ?? 1;

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      setResult(checkCompliance(machine, { ruleset, setting, mode, seed: Date.now() >>> 0 }));
      setBusy(false);
    }, 30);
  };

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const range = (min: number | undefined, max: number | undefined) =>
    `${min !== undefined ? pct(min) + ' 〜' : ''} ${max !== undefined ? pct(max) + ' 未満' : ''}`.trim();

  return (
    <details className="panel">
      <summary>適合試験チェック（試射試験風）</summary>
      <div className="panel-body">
        <p className="panel-note">
          保通協の出玉率基準の近似チェック。上限は完全打ち試行の最大値、下限は適当打ち試行の最小値で判定します
          （初期状態からの独立試行ウィンドウによる教材的な近似で、実際の試験手続きの再現ではありません）。
        </p>
        <div className="panel-controls">
          <select value={ruleset} onChange={(e) => setRuleset(e.target.value as RulesetId)} disabled={busy}>
            {Object.values(RULESETS).map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          {settings > 1 && (
            <select value={setting} onChange={(e) => setSetting(Number(e.target.value))} disabled={busy}>
              {Array.from({ length: settings }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>設定{n}</option>
              ))}
            </select>
          )}
          <select value={mode} onChange={(e) => setMode(e.target.value as 'quick' | 'standard')} disabled={busy}>
            <option value="quick">クイック</option>
            <option value="standard">じっくり</option>
          </select>
          <button onClick={run} disabled={busy} data-testid="run-compliance">
            {busy ? '試験中…' : '試験する'}
          </button>
        </div>
        {result && (
          <div data-testid="compliance-result">
            <p className={result.pass ? 'badge-ok' : 'badge-ng'}>
              {result.pass
                ? `✓ ${RULESETS[result.ruleset].label}に適合（設定${result.setting}）`
                : `✗ ${RULESETS[result.ruleset].label}に不適合（設定${result.setting}）`}
            </p>
            <table className="spec-table">
              <thead>
                <tr>
                  <th>区間</th>
                  <th>基準</th>
                  <th>適当打ち（最小〜最大）</th>
                  <th>完全打ち（最小〜最大）</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.spans.map((span) => (
                  <tr key={span.games}>
                    <td>{span.games.toLocaleString()}G × {span.naive.trials}回</td>
                    <td>{range(span.min, span.max)}</td>
                    <td>{pct(span.naive.min)} 〜 {pct(span.naive.max)}</td>
                    <td>{pct(span.perfect.min)} 〜 {pct(span.perfect.max)}</td>
                    <td className={span.pass ? 'ok' : 'ng'}>{span.pass ? '✓' : '✗'}</td>
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

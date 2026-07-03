import { useState } from 'react';
import { buildFromRecipe, isConcentrationStyle, SWEETNESS, WAVE } from '../core/recipes.js';
import type { SweetnessId, WaveId } from '../core/recipes.js';
import { estimateSpec, formatPct } from '../core/spec.js';
import type { MachineDef } from '../core/types.js';
import { checkLayout, validateMachine } from '../core/validate.js';
import { machines } from '../machines/index.js';
import { runComplianceParallel } from './compliance-runner.js';

/**
 * かんたんウィザード: 「タイプ・甘さ・波」を選ぶだけで機種を作る。
 * パラメータは一切見せず、レシピ（recipes.ts）+ 逆算ソルバーで出玉設計を自動化し、
 * 4号機基準の適合試験（軽量・Worker 並列）まで自動で回して合格を保証する。
 * 通らなかったら目標を少しずらして自動リトライ（3号機風の集中機だけは
 * 「通らないのが正しい」ので試験を掛けずに時代ラベルを出す）。
 */

interface WizardOutcome {
  machine: MachineDef;
  naive1: number;
  perfect1: number;
  naiveMax: number;
  perfectMax: number;
  settings: number;
  compliance: 'pass' | 'fail' | 'era';
  notes: string[];
}

const tick = () => new Promise((r) => setTimeout(r, 30));

export function Wizard({
  onSave,
  onEdit,
}: {
  onSave: (def: MachineDef) => void;
  onEdit: (def: MachineDef) => void;
}) {
  const [archetypeName, setArchetypeName] = useState(machines[0]!.name);
  const [sweetness, setSweetness] = useState<SweetnessId>('futsu');
  const [wave, setWave] = useState<WaveId>('nami');
  const [name, setName] = useState('マイ機種');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [outcome, setOutcome] = useState<WizardOutcome | null>(null);

  const archetype = machines.find((m) => m.name === archetypeName)!;
  const eraArchetype = isConcentrationStyle(archetype);

  const build = () => {
    setBusy(true);
    setOutcome(null);
    void (async () => {
      try {
        setProgress('配列と引き込み率を検査中…');
        await tick();
        const measuredPullIn = Object.fromEntries(
          checkLayout(archetype).roleChecks.map((c) => [c.id, c.measured]),
        );
        const notes: string[] = [];
        let compliance: WizardOutcome['compliance'] = eraArchetype ? 'era' : 'fail';
        let adjust = 0;
        let built = buildFromRecipe(archetype, {
          name: name.trim() || 'マイ機種',
          sweetness,
          wave,
          estimate: { measuredPullIn },
        });

        if (!eraArchetype) {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
              setProgress(`適合するように出玉を再調整中…（${attempt + 1} 回目）`);
              built = buildFromRecipe(archetype, {
                name: name.trim() || 'マイ機種',
                sweetness,
                wave,
                targetAdjust: adjust,
                estimate: { measuredPullIn },
              });
            }
            const settings = built.machine.lottery.settings ?? 1;
            const targets = settings > 1 ? [1, settings] : [1];
            let low = false;
            let high = false;
            let pass = true;
            for (const s of targets) {
              const r = await runComplianceParallel(
                built.machine,
                { setting: s, seed: 20260703, trialsOverride: { 400: 5, 6000: 2, 17500: 1 } },
                (done, total) => setProgress(`適合試験を実施中… 設定${s}（${done}/${total}）`),
              );
              if (!r.pass) {
                pass = false;
                for (const span of r.spans) {
                  if (span.pass) continue;
                  if (span.min !== undefined && span.naive.min < span.min) low = true;
                  if (span.max !== undefined && span.perfect.max >= span.max) high = true;
                }
              }
            }
            if (pass) {
              compliance = 'pass';
              break;
            }
            adjust += low && !high ? 0.04 : -0.04;
          }
          if (compliance !== 'pass') notes.push('自動調整でも適合しませんでした。ふつうタブでベルやボーナスを調整してみてください');
        }

        if (built.clamped) notes.push('目標の甘さには雛形の限界で届かなかったため、可能な範囲まで調整しました');
        const errors = validateMachine(built.machine).errors;
        if (errors.length > 0) notes.push(`検証エラー: ${errors[0]}`);

        const settings = built.machine.lottery.settings ?? 1;
        const est1 = estimateSpec(built.machine, 1, { measuredPullIn });
        const estMax = settings > 1 ? estimateSpec(built.machine, settings, { measuredPullIn }) : est1;
        setOutcome({
          machine: built.machine,
          naive1: est1.naive,
          perfect1: est1.perfect,
          naiveMax: estMax.naive,
          perfectMax: estMax.perfect,
          settings,
          compliance,
          notes,
        });
      } finally {
        setBusy(false);
        setProgress('');
      }
    })();
  };

  return (
    <div className="form-editor" data-testid="wizard">
      <p className="panel-note">
        3 つ選んで名前を付けるだけで、遊べる台ができます。出玉のバランス調整と型式試験（4号機基準）の確認まで自動です。
        できた台は「ふつう」タブで微調整、「上級」タブで大改造できます。
      </p>
      <div className="form-row">
        <label>
          タイプ
          <select className="form-select" value={archetypeName} onChange={(e) => setArchetypeName(e.target.value)} disabled={busy} data-testid="wizard-archetype">
            {machines.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name.replace('サンプル ', '')}
              </option>
            ))}
          </select>
        </label>
      </div>
      {eraArchetype && (
        <p className="badge-warn">⚠ 集中は 2〜3号機の仕組みです。この台は 4号機基準の適合試験に通りません（それが歴史的に正しい挙動です）</p>
      )}
      <div className="form-row">
        <label>
          甘さ
          <select className="form-select" value={sweetness} onChange={(e) => setSweetness(e.target.value as SweetnessId)} disabled={busy} data-testid="wizard-sweetness">
            {Object.entries(SWEETNESS).map(([id, s]) => (
              <option key={id} value={id}>
                {s.label} — {s.description}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          波
          <select className="form-select" value={wave} onChange={(e) => setWave(e.target.value as WaveId)} disabled={busy} data-testid="wizard-wave">
            {Object.entries(WAVE).map(([id, w]) => (
              <option key={id} value={id}>
                {w.label} — {w.description}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          機種名
          <input className="form-text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} data-testid="wizard-name" />
        </label>
      </div>
      <div className="panel-controls">
        <button onClick={build} disabled={busy} className="editor-save" data-testid="wizard-build">
          {busy ? progress || '作成中…' : 'この台を作る'}
        </button>
      </div>

      {outcome && (
        <div className="wizard-result" data-testid="wizard-result">
          <p className="guide-summary">
            「{outcome.machine.name}」ができました — 理論機械割: 設定1 適当打ち {formatPct(outcome.naive1)} / 完全打ち {formatPct(outcome.perfect1)}
            {outcome.settings > 1 && ` 〜 設定${outcome.settings} 適当打ち ${formatPct(outcome.naiveMax)} / 完全打ち ${formatPct(outcome.perfectMax)}`}
          </p>
          {outcome.compliance === 'pass' && <p className="badge-ok">✓ 4号機基準に適合（型式試験を通る見込みの出玉設計です）</p>}
          {outcome.compliance === 'fail' && <p className="badge-warn">⚠ 4号機基準に不適合のままです（保存して遊ぶことはできます）</p>}
          {outcome.compliance === 'era' && (
            <p className="badge-warn">⚠ 3号機風（集中）のため 4号機基準には通りません — 規制史ごと楽しむ台です</p>
          )}
          {outcome.notes.map((n) => (
            <p key={n} className="panel-note">
              {n}
            </p>
          ))}
          <div className="panel-controls">
            <button className="editor-save" onClick={() => onSave(outcome.machine)} data-testid="wizard-save">
              保存してプレイ
            </button>
            <button onClick={() => onEdit(outcome.machine)} data-testid="wizard-edit">
              ふつうタブで微調整する
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

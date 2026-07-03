import { useState } from 'react';
import { simulate } from '../core/sim.js';
import type { MachineDef } from '../core/types.js';
import { checkLayout, validateMachine } from '../core/validate.js';

/**
 * 機種エディタ（docs/design/05「WebUI で設定 → 保存 → 遊べる」の MVP）。
 * 機種定義 JSON を直接編集し、保存時に検証パイプラインを通す:
 * 1. JSON パース → 2. 構造検証（validateMachine） → 3. 配列総当たり検証（checkLayout）
 * → 4. スペック実測 → エラーゼロなら保存してそのままプレイ。
 * 検証を通らない機種定義はプレイヤーにロードさせない（docs/design/03 縮退規則）。
 * フォームベースの 5 軸エディタは将来拡張。
 */

interface ValidationView {
  errors: string[];
  warnings: string[];
  specNote: string | null;
}

function runPipeline(def: MachineDef): ValidationView {
  const { errors, warnings } = validateMachine(def);
  if (errors.length > 0) return { errors, warnings, specNote: null };

  try {
    const layout = checkLayout(def);
    if (layout.kickViolations > 0) {
      errors.push(`配列検証 NG: 蹴飛ばし違反 ${layout.kickViolations} 件（非成立役が入賞する配列です）`);
    }
    if (layout.replayMisses > 0) {
      errors.push(`配列検証 NG: リプレイ取りこぼし ${layout.replayMisses} 件`);
    }
    for (const check of layout.roleChecks) {
      if (!check.ok) {
        warnings.push(`役 ${check.id}: 実測引き込み率 ${(check.measured * 100).toFixed(1)}% が宣言とずれています`);
      }
    }
    if (errors.length > 0) return { errors, warnings, specNote: null };

    const spec = simulate(def, { games: 20_000, strategy: 'naive', seed: 1 });
    const bonuses = Object.entries(spec.bonusStarts)
      .map(([id, n]) => `${id} 1/${(spec.games / n).toFixed(0)}`)
      .join(' / ');
    return {
      errors,
      warnings,
      specNote: `検証 OK（${layout.casesChecked.toLocaleString()} ケース） — 適当打ち機械割 ${(spec.payoutRate * 100).toFixed(1)}%${bonuses ? ` / ${bonuses}` : ''}`,
    };
  } catch (e) {
    errors.push(`検証中に例外: ${e instanceof Error ? e.message : String(e)}`);
    return { errors, warnings, specNote: null };
  }
}

export function EditorPanel({
  machine,
  onSave,
}: {
  machine: MachineDef;
  onSave: (def: MachineDef) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(machine, null, 2));
  const [result, setResult] = useState<ValidationView | null>(null);
  const [busy, setBusy] = useState(false);

  const parse = (): MachineDef | null => {
    try {
      return JSON.parse(text) as MachineDef;
    } catch (e) {
      setResult({ errors: [`JSON パースエラー: ${e instanceof Error ? e.message : String(e)}`], warnings: [], specNote: null });
      return null;
    }
  };

  const validate = () => {
    setBusy(true);
    setTimeout(() => {
      const def = parse();
      if (def) setResult(runPipeline(def));
      setBusy(false);
    }, 30);
  };

  const save = () => {
    setBusy(true);
    setTimeout(() => {
      const def = parse();
      if (def) {
        const view = runPipeline(def);
        setResult(view);
        if (view.errors.length === 0) onSave(def);
      }
      setBusy(false);
    }, 30);
  };

  return (
    <details className="panel">
      <summary>機種エディタ（JSON を編集 → 保存で即プレイ）</summary>
      <div className="panel-body">
        <p className="panel-note">
          この機種の定義そのものです。抽選テーブルの重み・リール配列・モード・ナビなど全部いじれます。
          保存時に検証パイプライン（構造 → 配列総当たり → スペック実測）を通り、エラーがあると保存できません。
          名前を変えて保存すると新しい機種になります（ブラウザに保存・★印）。
        </p>
        <textarea
          className="editor-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          data-testid="editor-text"
        />
        <div className="panel-controls">
          <button onClick={validate} disabled={busy} data-testid="editor-validate">
            {busy ? '検証中…' : '検証のみ'}
          </button>
          <button onClick={save} disabled={busy} className="editor-save" data-testid="editor-save">
            {busy ? '…' : '保存してプレイ'}
          </button>
        </div>
        {result && (
          <div data-testid="editor-result">
            {result.errors.map((e) => (
              <p key={e} className="badge-ng">✗ {e}</p>
            ))}
            {result.warnings.map((w) => (
              <p key={w} className="badge-warn">⚠ {w}</p>
            ))}
            {result.errors.length === 0 && result.specNote && <p className="badge-ok">✓ {result.specNote}</p>}
          </div>
        )}
      </div>
    </details>
  );
}

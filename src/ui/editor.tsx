import { useRef, useState } from 'react';
import { checkCompliance, RULESETS } from '../core/compliance.js';
import { simulate } from '../core/sim.js';
import type { MachineDef } from '../core/types.js';
import { checkLayout, checkSpacing, validateMachine } from '../core/validate.js';
import { FormEditor } from './form-editor.js';
import { oneOf, usePersistentState } from './persist.js';
import { buildShareUrl, downloadMachine, readMachineFile } from './share.js';
import { Wizard } from './wizard.js';

/**
 * 機種エディタ（docs/design/05「WebUI で設定 → 保存 → 遊べる」）。
 * 4 ティア構成 — タブごとに「やることの種類」が違う:
 * - かんたん: ウィザード。タイプ・甘さ・波を選ぶだけ（出玉設計と適合確認は自動）
 * - ふつう:   調整。抽選テーブルの重み・ボーナスのゲーム数などのつまみだけ
 * - 上級:     構造。役・図柄・リール配列・RT/蓋/ナビまで全部
 * - JSON:     なんでも。定義そのものを直接編集
 * ふつう/上級/JSON は同じ下書きを共有し、タブを移動してもデータは失われない。
 *
 * 保存時に検証パイプラインを通す:
 * 1. 構造検証（validateMachine） → 2. 配列総当たり検証（checkLayout・違反例つき）
 * → 3. スペック実測 → 4. 適合試験（4号機基準の軽量チェック・バッジ表示）
 * エラーがゼロのときだけ保存できる（適合試験は参考情報でブロックしない）。
 */

export type EditorTier = 'easy' | 'normal' | 'advanced' | 'json';

const TIER_LABEL: Record<EditorTier, string> = {
  easy: 'かんたん（選ぶだけ）',
  normal: 'ふつう（つまみ調整）',
  advanced: '上級（構造から作る）',
  json: 'JSON',
};

interface ValidationView {
  errors: string[];
  warnings: string[];
  specNote: string | null;
  compliance: { pass: boolean; lines: string[] } | null;
}

/** 保存前の正規化: navGroups を役の宣言から自動同期し、空のオーバーレイを掃除する */
function normalize(def: MachineDef): MachineDef {
  const groups = [...new Set(def.roles.filter((r) => r.nav).map((r) => r.nav!.group))];
  const overrides = Object.fromEntries(
    Object.entries(def.lottery.settingOverrides ?? {}).filter(([, list]) => list.length > 0),
  );
  const { settingOverrides: _ignored, ...lotteryRest } = def.lottery;
  const base = { ...def };
  if (groups.length > 0) base.navGroups = groups.map((id) => ({ id }));
  return {
    ...base,
    lottery: Object.keys(overrides).length > 0 ? { ...lotteryRest, settingOverrides: overrides } : lotteryRest,
  };
}

function runPipeline(def: MachineDef, withCompliance: boolean): ValidationView {
  const { errors, warnings } = validateMachine(def);
  if (errors.length > 0) return { errors, warnings, specNote: null, compliance: null };

  try {
    // 総当たりの前に配置間隔のプリチェック（壊れた配列は制御エンジンが例外を投げるため先に弾く）
    const spacingBad = checkSpacing(def).filter((c) => !c.ok);
    if (spacingBad.length > 0) {
      for (const c of spacingBad) {
        errors.push(
          `配列 NG: ${['左', '中', '右'][c.reel] ?? c.reel}リールの「${c.symbol}」が ${c.count} 個・最大間隔 ${c.maxGap === Infinity ? '∞' : c.maxGap} コマです（どこでも揃う役には間隔 5 コマ以内が必要）`,
        );
      }
      errors.push('ヒント: リール配列セクションの「配列を自動生成」を使うと制約を満たす並びを探せます');
      return { errors, warnings, specNote: null, compliance: null };
    }

    const layout = checkLayout(def);
    if (layout.kickViolations > 0) {
      errors.push(
        `配列検証 NG: 蹴飛ばし違反 ${layout.kickViolations} 件 — 成立していない役が勝手に揃ってしまう並びです` +
          `（勝手に揃う役: ${Object.entries(layout.kickByRole)
            .map(([id, n]) => `${id}×${n}`)
            .join(', ')}）`,
      );
    }
    if (layout.replayMisses > 0) {
      errors.push(`配列検証 NG: リプレイ取りこぼし ${layout.replayMisses} 件 — リプレイ図柄の間隔が 5 コマを超えています`);
    }
    for (const v of layout.violationExamples.slice(0, 3)) {
      errors.push(
        v.kind === 'kick'
          ? `　例: フラグ[${v.flags.join('+') || 'ハズレ'}] の停止位置 [${v.stops.join(',')}] で ${v.wonRole} が揃ってしまう`
          : `　例: リプレイ成立時に停止位置 [${v.stops.join(',')}] で取りこぼす`,
      );
    }
    if (errors.length > 0) {
      errors.push('ヒント: リール配列セクションの「配列を自動生成」を使うと制約を満たす並びを探せます');
      return { errors, warnings, specNote: null, compliance: null };
    }
    for (const check of layout.roleChecks) {
      if (!check.ok) {
        warnings.push(
          `役 ${check.id}: 実測引き込み率 ${(check.measured * 100).toFixed(1)}% が宣言とずれています（役の「適当打ちの入賞率」を実測に合わせるか、図柄の個数を調整してください）`,
        );
      }
    }

    const spec = simulate(def, { games: 20_000, strategy: 'naive', seed: 1 });
    const bonuses = Object.entries(spec.bonusStarts)
      .map(([id, n]) => `${id} 1/${(spec.games / n).toFixed(0)}`)
      .join(' / ');
    const specNote = `検証 OK（${layout.casesChecked.toLocaleString()} ケース） — 適当打ち機械割 ${(spec.payoutRate * 100).toFixed(1)}%${bonuses ? ` / ${bonuses}` : ''}`;

    let compliance: ValidationView['compliance'] = null;
    if (withCompliance) {
      compliance = { pass: true, lines: [] };
      const settings = def.lottery.settings ?? 1;
      const targets = settings > 1 ? [1, settings] : [1];
      for (const setting of targets) {
        const result = checkCompliance(def, {
          setting,
          seed: 20260703,
          trialsOverride: { 400: 5, 6000: 2, 17500: 1 },
        });
        if (result.pass) continue;
        compliance.pass = false;
        for (const span of result.spans) {
          if (span.pass) continue;
          if (span.min !== undefined && span.naive.min < span.min) {
            compliance.lines.push(
              `設定${setting}: ${span.games.toLocaleString()}G の適当打ち ${(span.naive.min * 100).toFixed(1)}% が下限 ${span.min * 100}% 割れ → もっと甘く（ベルや払い出しを増やす・ボーナスを軽くする）`,
            );
          }
          if (span.max !== undefined && span.perfect.max >= span.max) {
            compliance.lines.push(
              `設定${setting}: ${span.games.toLocaleString()}G の完全打ち ${(span.perfect.max * 100).toFixed(1)}% が上限 ${span.max * 100}% 超え → もっと辛く（ベルやボーナスを減らす）`,
            );
          }
        }
      }
    }
    return { errors, warnings, specNote, compliance };
  } catch (e) {
    errors.push(`検証中に例外: ${e instanceof Error ? e.message : String(e)}`);
    return { errors, warnings, specNote: null, compliance: null };
  }
}

export function EditorPanel({
  machine,
  onSave,
  defaultTier = 'normal',
}: {
  machine: MachineDef;
  onSave: (def: MachineDef) => void;
  /** 初期タブ。初見ユーザーには 'easy' を渡す */
  defaultTier?: EditorTier;
}) {
  const [draft, setDraft] = useState<MachineDef>(() => structuredClone(machine));
  // ティア選択は永続化（下書き draft はサイズと壊れた JSON の復元リスクがあるので対象外）
  const [tier, setTier] = usePersistentState<EditorTier>(
    'daredemo.editorTier.v1',
    defaultTier,
    oneOf('easy', 'normal', 'advanced', 'json'),
  );
  const [text, setText] = useState('');
  const [result, setResult] = useState<ValidationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const switchTier = (next: EditorTier) => {
    if (next === tier) return;
    // JSON から離れるとき: パースできるときだけ下書きへ反映
    if (tier === 'json') {
      try {
        setDraft(JSON.parse(text) as MachineDef);
        setResult(null);
      } catch (e) {
        setResult({
          errors: [`JSON パースエラー: ${e instanceof Error ? e.message : String(e)}（直してから移動してください）`],
          warnings: [],
          specNote: null,
          compliance: null,
        });
        return;
      }
    }
    if (next === 'json') setText(JSON.stringify(draft, null, 2));
    setTier(next);
  };

  const currentDef = (): MachineDef | null => {
    if (tier !== 'json') return normalize(draft);
    try {
      return normalize(JSON.parse(text) as MachineDef);
    } catch (e) {
      setResult({
        errors: [`JSON パースエラー: ${e instanceof Error ? e.message : String(e)}`],
        warnings: [],
        specNote: null,
        compliance: null,
      });
      return null;
    }
  };

  const run = (save: boolean) => {
    setBusy(true);
    setShareNote(null);
    setTimeout(() => {
      const def = currentDef();
      if (def) {
        const view = runPipeline(def, true);
        setResult(view);
        if (save && view.errors.length === 0) onSave(def);
      }
      setBusy(false);
    }, 30);
  };

  const share = () => {
    const def = currentDef();
    if (!def) return;
    const view = runPipeline(def, false);
    setResult(view);
    if (view.errors.length > 0) return;
    void buildShareUrl(def).then((url) => {
      void navigator.clipboard?.writeText(url).catch(() => {});
      setShareNote(url.length > 90 ? `共有リンクをコピーしました（${url.slice(0, 90)}…）` : `共有リンクをコピーしました: ${url}`);
    });
  };

  const importFile = (file: File) => {
    void readMachineFile(file)
      .then((def) => {
        setDraft(def);
        setTier('normal');
        setResult(null);
        setShareNote(`「${def.name}」を読み込みました。内容を確認して保存してください`);
      })
      .catch((e) => {
        setResult({
          errors: [`ファイルを読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`],
          warnings: [],
          specNote: null,
          compliance: null,
        });
      });
  };

  return (
    <details className="panel">
      <summary>機種エディタ（この台を改造する / 新しい台を作る）</summary>
      <div className="panel-body">
        <p className="panel-note">
          「かんたん」は選ぶだけで新しい台を自動生成。「ふつう」以降はいま選んでいる機種の定義を編集できます
          （名前を変えて保存すると新しい機種・ブラウザに保存・★印）。
          保存時に検証（構造 → 配列総当たり → 実測 → 適合試験）が走り、エラーがあると保存できません。
        </p>
        <div className="panel-controls">
          {(Object.keys(TIER_LABEL) as EditorTier[]).map((t) => (
            <button key={t} className={tier === t ? 'tab-active' : 'tab'} onClick={() => switchTier(t)} data-testid={`tab-${t}`}>
              {TIER_LABEL[t]}
            </button>
          ))}
        </div>

        {tier === 'easy' && (
          <Wizard
            onSave={onSave}
            onEdit={(def) => {
              setDraft(def);
              setResult(null);
              setTier('normal');
            }}
          />
        )}
        {(tier === 'normal' || tier === 'advanced') && <FormEditor draft={draft} onChange={setDraft} tier={tier} />}
        {tier === 'json' && (
          <textarea
            className="editor-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            data-testid="editor-text"
          />
        )}

        {tier !== 'easy' && (
        <>
        <div className="panel-controls">
          <button onClick={() => run(false)} disabled={busy} data-testid="editor-validate">
            {busy ? '検証中…' : '検証のみ'}
          </button>
          <button onClick={() => run(true)} disabled={busy} className="editor-save" data-testid="editor-save">
            {busy ? '…' : '保存してプレイ'}
          </button>
          <button onClick={share} disabled={busy} data-testid="editor-share">
            共有リンク
          </button>
          <button onClick={() => currentDef() && downloadMachine(currentDef()!)} disabled={busy}>
            エクスポート
          </button>
          <button onClick={() => fileRef.current?.click()} disabled={busy}>
            インポート
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
              e.target.value = '';
            }}
          />
        </div>
        {shareNote && <p className="badge-ok">{shareNote}</p>}
        {result && (
          <div data-testid="editor-result">
            {result.errors.map((e) => (
              <p key={e} className="badge-ng">✗ {e}</p>
            ))}
            {result.warnings.map((w) => (
              <p key={w} className="badge-warn">⚠ {w}</p>
            ))}
            {result.errors.length === 0 && result.specNote && <p className="badge-ok">✓ {result.specNote}</p>}
            {result.compliance &&
              (result.compliance.pass ? (
                <p className="badge-ok" data-testid="compliance-badge">
                  ✓ {RULESETS.yon.label}に適合（型式試験を通る見込みの出玉設計です）
                </p>
              ) : (
                <div data-testid="compliance-badge">
                  <p className="badge-warn">⚠ {RULESETS.yon.label}に不適合（保存はできますが、実機ならホールに置けない台です）</p>
                  {result.compliance.lines.map((line) => (
                    <p key={line} className="badge-warn">　{line}</p>
                  ))}
                </div>
              ))}
          </div>
        )}
        </>
        )}

        <details className="form-section">
          <summary>用語ミニ辞典</summary>
          <div className="form-body panel-note">
            <p><b>重み</b>: 65536 面ルーレットの面の数。重み 8978 なら確率 8978/65536 ≒ 1/7.3。</p>
            <p><b>PB=1（どこでも揃う）</b>: どのタイミングで押しても最大 4 コマの「滑り」で必ず引き込める配置。図柄の間隔が 5 コマ以内である必要があります。</p>
            <p><b>蹴飛ばし</b>: 成立していない役を滑りで外すこと。「成立していない役は絶対に揃わない」がパチスロの大原則です。</p>
            <p><b>純ハズレ</b>: 何のフラグも成立していないゲーム。内部的にボーナスを持っているだけの「ハズレ」とは区別されます。</p>
            <p><b>機械割</b>: 払い出し ÷ 投入。100% を超えると打つほど増える設計です。</p>
            <p><b>適合試験</b>: 実機が世に出る前に受ける出玉率の試験。4号機基準は 17500G で 60%〜120% です。</p>
          </div>
        </details>
      </div>
    </details>
  );
}

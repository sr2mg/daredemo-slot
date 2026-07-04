import { useMemo, useState } from 'react';
import { countSymbols, generateStrips, minCountForPb1 } from '../core/layout-gen.js';
import { analyzeSensitivity, estimateSpec, formatOneIn, formatPct } from '../core/spec.js';
import type { SpecEstimate } from '../core/spec.js';
import { checkLayout, checkSpacing } from '../core/validate.js';
import type {
  AtTrigger,
  BonusDef,
  LidRelease,
  MachineDef,
  RoleDef,
  RoleId,
  RtTrigger,
  SymbolId,
  WeightedEntry,
} from '../core/types.js';

/**
 * フォームベースの機種エディタ（JSON を読めない人向けの本命 UI）。
 * 5 軸（役物・打ち分け・RT・持ち越し/放出・ナビ）+ 抽選テーブル + リール配列を
 * 構造化フォームで編集し、理論機械割（spec.ts）をライブ表示する。
 * ここで表現しきれない構成は「JSON（上級者）」タブで直接編集できる。
 */

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

export type MachineDraft = Mutable<MachineDef>;

const DENOM = 65536;
const REEL_NAMES = ['左', '中', '右'];

const entryKey = (roles: readonly RoleId[]) => [...roles].sort().join(',');

/** 指定設定の合成テーブル（base + オーバーレイ）。編集用に base 順を保つ */
function mergedTable(draft: MachineDef, setting: number): WeightedEntry[] {
  const overrides = setting > 1 ? (draft.lottery.settingOverrides?.[String(setting)] ?? []) : [];
  const map = new Map(overrides.map((e) => [entryKey(e.roles), e.weight]));
  return draft.lottery.base.map((e) => ({
    roles: e.roles,
    weight: map.get(entryKey(e.roles)) ?? e.weight,
  }));
}

/** 設定 s のエントリ重みを書き換える（設定 1 = base、それ以外 = 差分オーバーレイ） */
function writeWeight(draft: MachineDraft, setting: number, roles: readonly RoleId[], weight: number): void {
  const key = entryKey(roles);
  if (setting === 1) {
    const entry = draft.lottery.base.find((e) => entryKey(e.roles) === key);
    if (entry) entry.weight = weight;
    return;
  }
  const overrides = draft.lottery.settingOverrides ?? {};
  const base = draft.lottery.base.find((e) => entryKey(e.roles) === key);
  const list = (overrides[String(setting)] ?? []).filter((e) => entryKey(e.roles) !== key);
  if (base === undefined || base.weight !== weight) {
    list.push({ roles: [...roles], weight });
  }
  if (list.length > 0) overrides[String(setting)] = list;
  else delete overrides[String(setting)];
  draft.lottery.settingOverrides = overrides;
}

function symbolOptionsOf(draft: MachineDef): SymbolId[] {
  const set = new Set<SymbolId>();
  for (const strip of draft.strips) for (const s of strip) set.add(s);
  for (const role of draft.roles) for (const p of role.pattern) if (p !== 'any') set.add(p);
  return [...set];
}

/** 役がどこから参照されているか（削除可否の判定） */
function roleReferences(draft: MachineDef, id: RoleId): string[] {
  const refs: string[] = [];
  const inTable = (t: readonly WeightedEntry[]) => t.some((e) => e.roles.includes(id));
  if (inTable(draft.lottery.base)) refs.push('抽選テーブル');
  for (const [s, t] of Object.entries(draft.lottery.settingOverrides ?? {})) {
    if (inTable(t)) refs.push(`設定${s}の差分`);
  }
  for (const [name, t] of Object.entries(draft.tables)) if (inTable(t)) refs.push(`テーブル ${name}`);
  if (draft.bonuses.some((b) => b.id === id)) refs.push('ボーナス定義');
  if (draft.roles.some((r) => r.nav?.onMiss.type === 'reduced' && r.nav.onMiss.roleRef === id)) refs.push('こぼし先');
  for (const rt of draft.rtStates) if (id in rt.replayWeights) refs.push(`RT ${rt.id}`);
  for (const ctDef of draft.ct ?? []) {
    if (ctDef.freeRoles.includes(id)) refs.push(`CT ${ctDef.id}`);
    if (ctDef.end.punkRoles?.includes(id)) refs.push(`CT ${ctDef.id} パンク役`);
    if (ctDef.entry.some((t) => 'of' in t && t.of === id)) refs.push(`CT ${ctDef.id} 突入契機`);
  }
  const at = draft.nav?.at;
  if (at?.triggers.some((t) => t.on === 'roleHit' && t.of === id)) refs.push('AT 契機');
  if (at?.addOn?.some((a) => a.of === id)) refs.push('AT 上乗せ');
  for (const mode of draft.nav?.modes?.states ?? []) {
    if (
      mode.triggers?.some((t) => t.on === 'roleHit' && t.of === id) ||
      mode.transitions?.some((t) => t.on === 'roleHit' && t.of === id)
    ) {
      refs.push(`AT モード ${mode.id}`);
    }
  }
  return refs;
}

// ---------- 小物コンポーネント ----------

function Num({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  width = 90,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
}) {
  return (
    <input
      type="number"
      className="form-num"
      style={{ width }}
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(undefined);
        const v = Number(raw);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

function WeightControl({
  weight,
  onChange,
  sliderMax = 20000,
}: {
  weight: number;
  onChange: (v: number) => void;
  sliderMax?: number;
}) {
  const p = weight / DENOM;
  return (
    <span className="weight-control">
      <input
        type="range"
        min={0}
        max={sliderMax}
        step={10}
        value={Math.min(weight, sliderMax)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <Num value={weight} onChange={(v) => onChange(Math.max(0, Math.round(v ?? 0)))} width={80} />
      <span className="weight-info">
        {formatOneIn(p)}（{formatPct(p, 2)}）
      </span>
    </span>
  );
}

function SymbolSelect({
  value,
  options,
  allowAny,
  onChange,
}: {
  value: string;
  options: readonly string[];
  allowAny?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <select className="form-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowAny && <option value="any">any（なんでも）</option>}
      {options.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function RoleSelect({
  value,
  draft,
  filter,
  onChange,
  allowNone,
}: {
  value: string;
  draft: MachineDef;
  filter?: (r: RoleDef) => boolean;
  onChange: (v: string) => void;
  allowNone?: string;
}) {
  return (
    <select className="form-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {draft.roles.filter(filter ?? (() => true)).map((r) => (
        <option key={r.id} value={r.id}>
          {r.id}
        </option>
      ))}
    </select>
  );
}

// ---------- 理論スペックのライブ表示 ----------

function SpecSummary({ draft, setting, onSetting }: { draft: MachineDef; setting: number; onSetting: (s: number) => void }) {
  const settings = draft.lottery.settings ?? 1;
  // 実測引き込み率は配列と役にしか依存しない。重みスライダー操作では再計算しない
  const layoutKey = useMemo(() => JSON.stringify([draft.strips, draft.roles]), [draft.strips, draft.roles]);
  const measuredPullIn = useMemo(() => {
    try {
      const report = checkLayout(draft);
      return Object.fromEntries(report.roleChecks.map((c) => [c.id, c.measured]));
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);
  const opts = measuredPullIn ? { measuredPullIn } : {};
  const est: SpecEstimate | null = useMemo(() => {
    try {
      return estimateSpec(draft, setting, opts);
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, setting, measuredPullIn]);
  const [showSensitivity, setShowSensitivity] = useState(false);
  const sensitivity = useMemo(() => {
    if (!showSensitivity) return [];
    try {
      return analyzeSensitivity(draft, setting, opts).slice(0, 8);
    } catch {
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, setting, showSensitivity, measuredPullIn]);

  if (!est) return <p className="badge-warn">⚠ 定義が不完全なため理論値を計算できません</p>;

  const naiveClass = est.naive < 0.6 ? 'ng' : 'ok';
  const perfectClass = est.perfect >= 1.2 ? 'ng' : 'ok';
  return (
    <div className="spec-summary" data-testid="spec-summary">
      <div className="spec-summary-row">
        {settings > 1 && (
          <select className="form-select" value={setting} onChange={(e) => onSetting(Number(e.target.value))}>
            {Array.from({ length: settings }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                設定{n}
              </option>
            ))}
          </select>
        )}
        <span>
          理論機械割: 適当打ち <b className={naiveClass}>{formatPct(est.naive)}</b> / 完全打ち{' '}
          <b className={perfectClass}>{formatPct(est.perfect)}</b>
        </span>
      </div>
      <p className="panel-note">
        4号機基準の目安: 適当打ち 60% 以上・完全打ち 120% 未満（17500G）。数値は代数近似で、確定値は保存時の実測・適合試験で確認します。
        {est.naive < 0.6 && ' ⚠ 下限割れの見込み → ベル・リプレイ・ボーナスを増やして甘くしてください。'}
        {est.perfect >= 1.2 && ' ⚠ 上限超えの見込み → ベルやボーナスを減らして辛くしてください。'}
      </p>
      <button className="form-mini-btn" onClick={() => setShowSensitivity((v) => !v)}>
        {showSensitivity ? '感度分析を閉じる' : '感度分析（どこを変えると機械割が動くか）'}
      </button>
      {showSensitivity && (
        <table className="spec-table">
          <thead>
            <tr>
              <th>つまみ</th>
              <th>適当打ち</th>
              <th>完全打ち</th>
            </tr>
          </thead>
          <tbody>
            {sensitivity.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.dNaive >= 0 ? '+' : ''}{(row.dNaive * 100).toFixed(2)}pt</td>
                <td>{row.dPerfect >= 0 ? '+' : ''}{(row.dPerfect * 100).toFixed(2)}pt</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- 各セクション ----------

function BasicSection({ draft, update }: SectionProps) {
  return (
    <details className="form-section" open>
      <summary>基本</summary>
      <div className="form-body">
        <label className="form-row">
          機種名
          <input
            className="form-text"
            value={draft.name}
            onChange={(e) => update((d) => void (d.name = e.target.value))}
          />
        </label>
        <label className="form-row">
          投入枚数（BET）
          <select
            className="form-select"
            value={draft.bet}
            onChange={(e) => update((d) => void (d.bet = Number(e.target.value)))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}枚
              </option>
            ))}
          </select>
        </label>
        <label className="form-row">
          設定の段階数
          <select
            className="form-select"
            value={draft.lottery.settings ?? 1}
            onChange={(e) =>
              update((d) => {
                const n = Number(e.target.value);
                d.lottery.settings = n;
                for (const key of Object.keys(d.lottery.settingOverrides ?? {})) {
                  if (Number(key) > n) delete d.lottery.settingOverrides![key];
                }
              })
            }
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '設定なし' : `${n}段階`}
              </option>
            ))}
          </select>
        </label>
      </div>
    </details>
  );
}

function LotterySection({
  draft,
  update,
  setting,
  structural = true,
}: SectionProps & { setting: number; structural?: boolean }) {
  const [newRole, setNewRole] = useState('');
  const [newOverlap, setNewOverlap] = useState('');
  const table = mergedTable(draft, setting);
  const total = table.reduce((sum, e) => sum + e.weight, 0);
  const missP = (DENOM - total) / DENOM;
  const baseKeys = new Set(draft.lottery.base.map((e) => entryKey(e.roles)));
  const bonusIds = new Set(draft.bonuses.map((b) => b.id));

  return (
    <details className="form-section" open>
      <summary>通常時の抽選テーブル{setting > 1 ? `（設定${setting} を編集中）` : ''}</summary>
      <div className="form-body">
        <p className="panel-note">
          レバー ON のたびに 65536 面のルーレットを 1 回まわすイメージ。重み = 面の数です。
          設定 2 以上を選んで重みを変えると、その設定だけの差分（設定差）になります。
        </p>
        {table.map((entry) => {
          const key = entryKey(entry.roles);
          const baseWeight = draft.lottery.base.find((e) => entryKey(e.roles) === key)?.weight;
          const overridden = setting > 1 && baseWeight !== undefined && baseWeight !== entry.weight;
          return (
            <div className="form-row lottery-row" key={key}>
              <span className="lottery-label">
                {entry.roles.join(' + ')}
                {overridden && <span className="chip-diff">設定差</span>}
              </span>
              <WeightControl
                weight={entry.weight}
                onChange={(v) => update((d) => writeWeight(d, setting, entry.roles, v))}
              />
              {setting === 1 && structural && (
                <button
                  className="form-mini-btn"
                  title="このエントリを削除"
                  onClick={() =>
                    update((d) => {
                      d.lottery.base = d.lottery.base.filter((e) => entryKey(e.roles) !== key);
                      for (const [s, list] of Object.entries(d.lottery.settingOverrides ?? {})) {
                        d.lottery.settingOverrides![s] = list.filter((e) => entryKey(e.roles) !== key);
                        if (d.lottery.settingOverrides![s]!.length === 0) delete d.lottery.settingOverrides![s];
                      }
                    })
                  }
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        <div className="form-row">
          <span className="lottery-label">ハズレ（残り）</span>
          <span className={missP < 0 ? 'badge-ng' : 'weight-info'}>
            {missP < 0
              ? `重み合計が ${total - DENOM} 超過しています`
              : `${formatOneIn(missP)}（${formatPct(missP, 1)}）`}
          </span>
        </div>
        {setting === 1 && structural && (
          <div className="form-row">
            <RoleSelect value={newRole} draft={draft} onChange={setNewRole} allowNone="役を選ぶ…" />
            <RoleSelect
              value={newOverlap}
              draft={draft}
              filter={(r) => bonusIds.has(r.id)}
              onChange={setNewOverlap}
              allowNone="（重複なし）"
            />
            <button
              className="form-mini-btn"
              disabled={newRole === '' || baseKeys.has(entryKey(newOverlap ? [newRole, newOverlap] : [newRole]))}
              onClick={() =>
                update((d) => {
                  const roles = newOverlap && newOverlap !== newRole ? [newRole, newOverlap] : [newRole];
                  d.lottery.base.push({ roles, weight: 100 });
                })
              }
            >
              エントリを追加
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function RolesSection({ draft, update }: SectionProps) {
  const symbols = symbolOptionsOf(draft);
  const [newId, setNewId] = useState('');
  return (
    <details className="form-section">
      <summary>役と払い出し</summary>
      <div className="form-body">
        <p className="panel-note">
          payout は 1 回の払い出し枚数（上限 15 枚）。「どこでも揃う」を外すと目押し役になり、
          適当打ちでは宣言した確率でしか入賞しません（配列の個数と合っているかは検証で確認されます）。
        </p>
        {draft.roles.map((role, ri) => {
          const refs = roleReferences(draft, role.id);
          return (
            <div className="form-role" key={role.id}>
              <div className="form-row">
                <b className="role-name">{role.id}</b>
                <span className="chip">{role.kind === 'replay' ? 'リプレイ' : role.kind === 'bonus' ? 'ボーナス' : '小役'}</span>
                {role.kind !== 'replay' && (
                  <label>
                    払い出し
                    <Num
                      value={role.payout}
                      min={0}
                      max={15}
                      width={60}
                      onChange={(v) => update((d) => void (d.roles[ri]!.payout = Math.min(15, Math.max(0, v ?? 0))))}
                    />
                    枚
                  </label>
                )}
                <button
                  className="form-mini-btn"
                  disabled={refs.length > 0}
                  title={refs.length > 0 ? `使用中のため削除できません: ${refs.join(' / ')}` : 'この役を削除'}
                  onClick={() => update((d) => void d.roles.splice(ri, 1))}
                >
                  ✕
                </button>
              </div>
              <div className="form-row">
                図柄:
                {role.pattern.map((sym, reel) => (
                  <SymbolSelect
                    key={reel}
                    value={sym}
                    options={symbols}
                    allowAny
                    onChange={(v) => update((d) => void (d.roles[ri]!.pattern[reel] = v))}
                  />
                ))}
                <label>
                  <input
                    type="checkbox"
                    checked={role.pullIn === 'guaranteed'}
                    onChange={(e) =>
                      update((d) => {
                        d.roles[ri]!.pullIn = e.target.checked
                          ? 'guaranteed'
                          : { missable: { targetRate: 0.3 } };
                      })
                    }
                  />
                  どこでも揃う（PB=1）
                </label>
                {role.pullIn !== 'guaranteed' && (
                  <label>
                    適当打ちの入賞率
                    <Num
                      value={Math.round(role.pullIn.missable.targetRate * 100)}
                      min={1}
                      max={100}
                      width={60}
                      onChange={(v) =>
                        update((d) => {
                          d.roles[ri]!.pullIn = { missable: { targetRate: Math.min(100, Math.max(1, v ?? 30)) / 100 } };
                        })
                      }
                    />
                    %
                  </label>
                )}
                {role.nav && (
                  <label>
                    押し順正解:
                    <select
                      className="form-select"
                      value={role.nav.correctFirst}
                      onChange={(e) => update((d) => void (d.roles[ri]!.nav!.correctFirst = Number(e.target.value)))}
                    >
                      {REEL_NAMES.map((n, i) => (
                        <option key={n} value={i}>
                          {n}から
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
          );
        })}
        <div className="form-row">
          <input
            className="form-text"
            placeholder="新しい役の ID（例: grape）"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <button
            className="form-mini-btn"
            disabled={newId.trim() === '' || draft.roles.some((r) => r.id === newId.trim())}
            onClick={() =>
              update((d) => {
                const sym = symbols[0] ?? 'bell';
                d.roles.push({
                  id: newId.trim(),
                  kind: 'small',
                  payout: 8,
                  pattern: d.strips.map(() => sym),
                  pullIn: 'guaranteed',
                });
                setNewId('');
              })
            }
          >
            小役を追加
          </button>
        </div>
      </div>
    </details>
  );
}

function ReelSection({ draft, update }: SectionProps) {
  const symbols = symbolOptionsOf(draft);
  const [busy, setBusy] = useState(false);
  const [genNote, setGenNote] = useState<string | null>(null);
  const spacing = useMemo(() => {
    try {
      return checkSpacing(draft);
    } catch {
      return [];
    }
  }, [draft]);
  const bad = spacing.filter((c) => !c.ok);

  const generate = () => {
    setBusy(true);
    setGenNote(null);
    setTimeout(() => {
      const result = generateStrips(draft, { seed: Date.now() >>> 0 });
      if (result.ok && result.strips) {
        const strips = result.strips;
        update((d) => void (d.strips = strips));
        setGenNote(`✓ ${result.attempts} 回目の試行で全制約を満たす配列を生成しました`);
      } else {
        setGenNote(`✗ ${result.error}`);
      }
      setBusy(false);
    }, 30);
  };

  return (
    <details className="form-section">
      <summary>リール配列</summary>
      <div className="form-body">
        <p className="panel-note">
          並びを手で作るのは大変なので「自動生成」がおすすめです（図柄の個数を保ったまま、
          リプレイ・ベルがどこを押しても揃う並びを探します）。個数を変えたいときはマスを書き換えてから自動生成してください。
        </p>
        <div className="panel-controls">
          <button onClick={generate} disabled={busy} data-testid="generate-strips">
            {busy ? '生成中…' : '配列を自動生成'}
          </button>
          {genNote && <span className={genNote.startsWith('✓') ? 'badge-ok' : 'badge-ng'}>{genNote}</span>}
        </div>
        {bad.length > 0 && (
          <div>
            {bad.map((c) => (
              <p key={`${c.roleId}-${c.reel}`} className="badge-ng">
                ✗ {REEL_NAMES[c.reel]}リールの「{c.symbol}」: {c.count} 個・最大間隔 {c.maxGap === Infinity ? '∞' : c.maxGap} コマ。
                どこでも揃うには最大間隔 5 コマ以内（{minCountForPb1(draft.frames)} 個以上を分散配置）が必要です
              </p>
            ))}
          </div>
        )}
        <div className="reel-grid">
          {draft.strips.map((strip, reel) => (
            <div className="reel-grid-col" key={reel}>
              <b>{REEL_NAMES[reel]}</b>
              {strip.map((sym, i) => (
                <SymbolSelect
                  key={i}
                  value={sym}
                  options={symbols}
                  onChange={(v) => update((d) => void (d.strips[reel]![i] = v))}
                />
              ))}
              <p className="panel-note reel-counts">
                {Object.entries(countSymbols(strip))
                  .map(([s, n]) => `${s}×${n}`)
                  .join(' ')}
              </p>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function TableEditor({
  draft,
  update,
  tableName,
  structural = true,
}: SectionProps & { tableName: string; structural?: boolean }) {
  const table = draft.tables[tableName] ?? [];
  const [newRole, setNewRole] = useState('');
  return (
    <div className="bonus-table">
      {table.map((entry, i) => (
        <div className="form-row" key={entryKey(entry.roles)}>
          <span className="lottery-label">{entry.roles.join(' + ')}</span>
          <WeightControl
            weight={entry.weight}
            sliderMax={DENOM}
            onChange={(v) => update((d) => void (d.tables[tableName]![i]!.weight = v))}
          />
          {structural && (
            <button
              className="form-mini-btn"
              onClick={() => update((d) => void d.tables[tableName]!.splice(i, 1))}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {structural && (
        <div className="form-row">
          <RoleSelect value={newRole} draft={draft} onChange={setNewRole} allowNone="役を選ぶ…" />
          <button
            className="form-mini-btn"
            disabled={newRole === '' || table.some((e) => entryKey(e.roles) === newRole)}
            onClick={() =>
              update((d) => {
                d.tables[tableName] = [...(d.tables[tableName] ?? []), { roles: [newRole], weight: 10000 }];
              })
            }
          >
            行を追加
          </button>
        </div>
      )}
    </div>
  );
}

function BonusSection({
  draft,
  update,
  setting,
  structural = true,
}: SectionProps & { setting: number; structural?: boolean }) {
  const est = useMemo(() => {
    try {
      return estimateSpec(draft, setting);
    } catch {
      return null;
    }
  }, [draft, setting]);
  const [newKind, setNewKind] = useState<'bb' | 'rb' | 'sb'>('bb');
  const [newId, setNewId] = useState('');

  return (
    <details className="form-section">
      <summary>ボーナス（役物）</summary>
      <div className="form-body">
        {draft.bonuses.map((bonus, bi) => {
          const row = est?.bonuses.find((b) => b.id === bonus.id);
          return (
            <div className="form-role" key={bonus.id}>
              <div className="form-row">
                <b className="role-name">{bonus.id}</b>
                {structural ? (
                  <select
                    className="form-select"
                    value={bonus.kind}
                    onChange={(e) => update((d) => void (d.bonuses[bi]!.kind = e.target.value as BonusDef['kind']))}
                  >
                    <option value="bb">BB（ビッグ）</option>
                    <option value="rb">RB（レギュラー）</option>
                    <option value="sb">SB（1ゲームだけ）</option>
                  </select>
                ) : (
                  <span className="chip">{bonus.kind.toUpperCase()}</span>
                )}
                {row && (
                  <span className="weight-info">
                    確率 {formatOneIn(row.p)} / 期待獲得 約{Math.round(row.expectedMedalsNaive)}枚
                  </span>
                )}
                {structural && (
                <button
                  className="form-mini-btn"
                  title="このボーナスを削除（抽選エントリも一緒に消します）"
                  onClick={() =>
                    update((d) => {
                      const id = bonus.id;
                      d.bonuses.splice(bi, 1);
                      d.lottery.base = d.lottery.base.filter((e) => !e.roles.includes(id));
                      for (const [s, list] of Object.entries(d.lottery.settingOverrides ?? {})) {
                        d.lottery.settingOverrides![s] = list.filter((e) => !e.roles.includes(id));
                        if (d.lottery.settingOverrides![s]!.length === 0) delete d.lottery.settingOverrides![s];
                      }
                      const stillUsed = d.bonuses.some((b) => b.tableRef === bonus.tableRef);
                      if (!stillUsed) delete d.tables[bonus.tableRef];
                      const role = d.roles.findIndex((r) => r.id === id);
                      if (role >= 0 && roleReferences(d, id).length === 0) d.roles.splice(role, 1);
                      d.rtStates = d.rtStates
                        .map((rt) => ({
                          ...rt,
                          entry: rt.entry.filter((t) => !('of' in t) || t.of !== id),
                          exit: rt.exit.filter((t) => !('of' in t) || t.of !== id),
                        }))
                        .filter((rt) => rt.entry.length > 0 && rt.exit.length > 0);
                    })
                  }
                >
                  ✕
                </button>
                )}
              </div>
              {bonus.kind !== 'sb' && (
                <div className="form-row">
                  {(
                    [
                      ['games', '消化ゲーム数', 60],
                      ['wins', '入賞回数で終了', 60],
                      ['maxPayout', '獲得枚数で終了', 70],
                    ] as const
                  ).map(([key, label, width]) => (
                    <label key={key}>
                      {label}
                      <Num
                        value={bonus.end[key]}
                        min={1}
                        width={width}
                        onChange={(v) =>
                          update((d) => {
                            if (v === undefined) delete d.bonuses[bi]!.end[key];
                            else d.bonuses[bi]!.end[key] = v;
                          })
                        }
                      />
                    </label>
                  ))}
                  <span className="panel-note">（空欄 = その条件なし）</span>
                </div>
              )}
              <p className="panel-note">ボーナス中の抽選テーブル（{bonus.tableRef}）:</p>
              <TableEditor draft={draft} update={update} tableName={bonus.tableRef} structural={structural} />
            </div>
          );
        })}
        {structural && (
        <div className="form-row">
          <input
            className="form-text"
            placeholder="新しいボーナスの ID（例: bb_blue）"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <select className="form-select" value={newKind} onChange={(e) => setNewKind(e.target.value as 'bb' | 'rb' | 'sb')}>
            <option value="bb">BB</option>
            <option value="rb">RB</option>
            <option value="sb">SB</option>
          </select>
          <button
            className="form-mini-btn"
            disabled={newId.trim() === '' || draft.roles.some((r) => r.id === newId.trim())}
            onClick={() =>
              update((d) => {
                const id = newId.trim();
                const sym = symbolOptionsOf(d)[0] ?? 'seven_red';
                const tableRef = `in_${id}`;
                const firstSmall = d.roles.find((r) => r.kind === 'small' && !r.nav);
                d.roles.push({
                  id,
                  kind: 'bonus',
                  payout: newKind === 'sb' ? 15 : 0,
                  pattern: d.strips.map(() => sym),
                  pullIn: newKind === 'sb' ? 'guaranteed' : { missable: { targetRate: 0.05 } },
                });
                d.bonuses.push({
                  id,
                  kind: newKind,
                  end: newKind === 'sb' ? {} : { games: 20 },
                  tableRef,
                });
                d.tables[tableRef] = firstSmall ? [{ roles: [firstSmall.id], weight: 60000 }] : [];
                d.lottery.base.push({ roles: [id], weight: 250 });
                setNewId('');
              })
            }
          >
            ボーナスを追加
          </button>
        </div>
        )}
        {structural && (
          <p className="panel-note">
            追加したボーナスの図柄は「役と払い出し」で、確率は「抽選テーブル」で調整できます。
          </p>
        )}
      </div>
    </details>
  );
}

function ReleaseEditor({
  release,
  draft,
  onChange,
}: {
  release: LidRelease;
  draft: MachineDef;
  onChange: (r: LidRelease) => void;
}) {
  return (
    <div className="release-editor">
      <select
        className="form-select"
        value={release.type}
        onChange={(e) => {
          const type = e.target.value as LidRelease['type'];
          if (type === 'gameCountTable') onChange({ type, table: [{ games: 32, weight: 100 }] });
          else if (type === 'lottery') onChange({ type, weight: 6553, on: 'pureMiss' });
          else onChange({ type: 'roleHit', of: draft.roles[0]?.id ?? '' });
        }}
      >
        <option value="gameCountTable">ゲーム数テーブルで解除</option>
        <option value="lottery">解除抽選</option>
        <option value="roleHit">特定役の入賞で解除</option>
      </select>
      {release.type === 'gameCountTable' && (
        <div>
          {release.table.map((row, i) => (
            <div className="form-row" key={i}>
              <Num
                value={row.games}
                min={1}
                width={70}
                onChange={(v) => {
                  const table = release.table.map((r, j) => (j === i ? { ...r, games: v ?? 1 } : r));
                  onChange({ ...release, table });
                }}
              />
              G 後 / 重み
              <Num
                value={row.weight}
                min={1}
                width={70}
                onChange={(v) => {
                  const table = release.table.map((r, j) => (j === i ? { ...r, weight: v ?? 1 } : r));
                  onChange({ ...release, table });
                }}
              />
              <button
                className="form-mini-btn"
                disabled={release.table.length <= 1}
                onClick={() => onChange({ ...release, table: release.table.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="form-mini-btn"
            onClick={() => onChange({ ...release, table: [...release.table, { games: 32, weight: 100 }] })}
          >
            行を追加
          </button>
        </div>
      )}
      {release.type === 'lottery' && (
        <div className="form-row">
          解除確率
          <Num
            value={Math.round((release.weight / DENOM) * 1000) / 10}
            min={0.1}
            max={100}
            step={0.1}
            width={70}
            onChange={(v) => onChange({ ...release, weight: Math.round(((v ?? 10) / 100) * DENOM) })}
          />
          %
          <label>
            <input
              type="checkbox"
              checked={(release.on ?? 'any') === 'pureMiss'}
              onChange={(e) => onChange({ ...release, on: e.target.checked ? 'pureMiss' : 'any' })}
            />
            純ハズレのゲームだけ抽選
          </label>
        </div>
      )}
      {release.type === 'roleHit' && (
        <div className="form-row">
          <RoleSelect value={release.of} draft={draft} onChange={(v) => onChange({ ...release, of: v })} />
          の入賞で解除
        </div>
      )}
    </div>
  );
}

function SystemsSection({ draft, update }: SectionProps) {
  const lid = draft.carryover.lid;
  const lidMode: 'none' | 'simple' | 'modes' = lid === null ? 'none' : lid.modes ? 'modes' : 'simple';
  const at = draft.nav?.at;
  const bonusOptions = draft.bonuses.map((b) => b.id);

  return (
    <details className="form-section">
      <summary>出玉システム（ストック・RT・AT）</summary>
      <div className="form-body">
        <h4 className="form-h4">持ち越しとストック</h4>
        <div className="form-row">
          <label>
            ストック上限
            <Num
              value={draft.carryover.queueLimit}
              min={1}
              max={100}
              width={60}
              onChange={(v) => update((d) => void (d.carryover.queueLimit = Math.max(1, v ?? 1)))}
            />
            個（1 = 普通の持ち越しのみ）
          </label>
          <select
            className="form-select"
            value={lidMode}
            onChange={(e) =>
              update((d) => {
                const v = e.target.value;
                if (v === 'none') d.carryover.lid = null;
                else if (v === 'simple')
                  d.carryover.lid = {
                    engageOn: ['bonusFlag'],
                    release: { type: 'gameCountTable', table: [{ games: 32, weight: 100 }] },
                  };
                else
                  d.carryover.lid = {
                    engageOn: ['bonusFlag', 'bonusEnd'],
                    modes: {
                      initial: 'normal',
                      states: [
                        {
                          id: 'normal',
                          release: { type: 'gameCountTable', table: [{ games: 32, weight: 100 }] },
                          onBonusEnd: [
                            { to: 'normal', weight: 70 },
                            { to: 'heaven', weight: 30 },
                          ],
                        },
                        {
                          id: 'heaven',
                          release: { type: 'gameCountTable', table: [{ games: 1, weight: 100 }] },
                          onBonusEnd: [
                            { to: 'heaven', weight: 50 },
                            { to: 'normal', weight: 50 },
                          ],
                        },
                      ],
                    },
                  };
              })
            }
          >
            <option value="none">蓋なし（成立したら揃えられる）</option>
            <option value="simple">蓋あり（解除まで揃わない）</option>
            <option value="modes">蓋あり + モード管理（天国連チャン等）</option>
          </select>
        </div>
        {lid && (
          <div className="form-row">
            蓋を掛けるタイミング:
            {(['bonusFlag', 'bonusEnd'] as const).map((on) => (
              <label key={on}>
                <input
                  type="checkbox"
                  checked={lid.engageOn.includes(on)}
                  onChange={(e) =>
                    update((d) => {
                      const cur = new Set(d.carryover.lid!.engageOn);
                      if (e.target.checked) cur.add(on);
                      else cur.delete(on);
                      d.carryover.lid!.engageOn = [...cur];
                    })
                  }
                />
                {on === 'bonusFlag' ? '最初のストック時' : 'ボーナス終了時'}
              </label>
            ))}
          </div>
        )}
        {lid?.release && (
          <ReleaseEditor
            release={lid.release}
            draft={draft}
            onChange={(r) => update((d) => void (d.carryover.lid!.release = structuredClone(r) as Mutable<LidRelease>))}
          />
        )}
        {lid?.modes &&
          lid.modes.states.map((mode, mi) => (
            <div className="form-role" key={mode.id}>
              <div className="form-row">
                <b className="role-name">モード「{mode.id}」</b>
                {lid.modes!.initial === mode.id && <span className="chip">初期モード</span>}
              </div>
              <ReleaseEditor
                release={mode.release}
                draft={draft}
                onChange={(r) =>
                  update(
                    (d) =>
                      void (d.carryover.lid!.modes!.states[mi]!.release = structuredClone(r) as Mutable<LidRelease>),
                  )
                }
              />
              {(mode.onBonusEnd ?? []).map((t, ti) => (
                <div className="form-row" key={ti}>
                  ボーナス終了時 →
                  <select
                    className="form-select"
                    value={t.to}
                    onChange={(e) =>
                      update((d) => void (d.carryover.lid!.modes!.states[mi]!.onBonusEnd![ti]!.to = e.target.value))
                    }
                  >
                    {lid.modes!.states.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                  重み
                  <Num
                    value={t.weight}
                    min={1}
                    width={60}
                    onChange={(v) =>
                      update((d) => void (d.carryover.lid!.modes!.states[mi]!.onBonusEnd![ti]!.weight = v ?? 1))
                    }
                  />
                </div>
              ))}
            </div>
          ))}

        <h4 className="form-h4">RT（リプレイタイム）</h4>
        {draft.rtStates.map((rt, ri) => (
          <div className="form-role" key={rt.id}>
            <div className="form-row">
              <b className="role-name">{rt.id}</b>
              <button className="form-mini-btn" onClick={() => update((d) => void d.rtStates.splice(ri, 1))}>
                ✕
              </button>
            </div>
            <div className="form-row">
              突入:
              <select
                className="form-select"
                value={JSON.stringify(rt.entry[0] ?? null)}
                onChange={(e) =>
                  update((d) => void (d.rtStates[ri]!.entry = [JSON.parse(e.target.value) as RtTrigger]))
                }
              >
                {bonusOptions.map((id) => (
                  <option key={id} value={JSON.stringify({ on: 'bonusEnd', of: id })}>
                    {id} 終了後
                  </option>
                ))}
                <option value={JSON.stringify({ on: 'bonusEnd' })}>どのボーナス終了後でも</option>
              </select>
              終了:
              <Num
                value={rt.exit.find((t) => t.on === 'games')?.n ?? 50}
                min={1}
                width={70}
                onChange={(v) => update((d) => void (d.rtStates[ri]!.exit = [{ on: 'games', n: v ?? 50 }]))}
              />
              G 消化（ボーナス成立でもリセット）
            </div>
            {Object.entries(rt.replayWeights).map(([roleId, weight]) => (
              <div className="form-row" key={roleId}>
                RT 中の {roleId} の重み:
                <WeightControl
                  weight={weight}
                  sliderMax={40000}
                  onChange={(v) => update((d) => void (d.rtStates[ri]!.replayWeights[roleId] = v))}
                />
              </div>
            ))}
          </div>
        ))}
        <button
          className="form-mini-btn"
          disabled={draft.bonuses.length === 0}
          onClick={() =>
            update((d) => {
              const replay = d.roles.find((r) => r.kind === 'replay');
              d.rtStates.push({
                id: `rt_${d.rtStates.length + 1}`,
                replayWeights: replay ? { [replay.id]: 29127 } : {},
                entry: [{ on: 'bonusEnd', of: d.bonuses[0]!.id }],
                exit: [{ on: 'games', n: 50 }],
              });
            })
          }
        >
          RT を追加
        </button>

        <h4 className="form-h4">AT（押し順ナビ）</h4>
        {!at && (
          <p className="panel-note">
            AT を使うには押し順役（nav 付きの役）が必要です。プリセット「AT機」を元に作るのが手軽です。
            {draft.roles.some((r) => r.nav) && (
              <button
                className="form-mini-btn"
                onClick={() =>
                  update((d) => {
                    const groups = [...new Set(d.roles.filter((r) => r.nav).map((r) => r.nav!.group))];
                    d.navGroups = groups.map((id) => ({ id }));
                    d.nav = {
                      at: {
                        triggers: [{ on: 'gamesCeiling', n: 500 }],
                        management: { type: 'set', gamesPerSet: 30, continueProb: 0.7 },
                        navTargets: groups,
                      },
                    };
                  })
                }
              >
                AT を有効にする
              </button>
            )}
          </p>
        )}
        {at && (
          <div className="form-role">
            <div className="form-row">
              <b className="role-name">AT 抽選のきっかけ</b>
              <button className="form-mini-btn" onClick={() => update((d) => void delete d.nav)}>
                AT を外す
              </button>
            </div>
            {at.triggers.map((t, ti) => (
              <div className="form-row" key={ti}>
                {t.on === 'roleHit' && (
                  <>
                    <RoleSelect
                      value={t.of}
                      draft={draft}
                      onChange={(v) =>
                        update((d) => void ((d.nav!.at.triggers[ti] as { of: string }).of = v))
                      }
                    />
                    入賞で
                    <Num
                      value={Math.round(t.prob * 100)}
                      min={1}
                      max={100}
                      width={60}
                      onChange={(v) =>
                        update((d) => void ((d.nav!.at.triggers[ti] as { prob: number }).prob = (v ?? 30) / 100))
                      }
                    />
                    %
                  </>
                )}
                {t.on === 'pureMiss' && (
                  <>
                    純ハズレで
                    <Num
                      value={Math.round(t.prob * 1000) / 10}
                      min={0.1}
                      max={100}
                      step={0.1}
                      width={60}
                      onChange={(v) =>
                        update((d) => void ((d.nav!.at.triggers[ti] as { prob: number }).prob = (v ?? 0.5) / 100))
                      }
                    />
                    %
                  </>
                )}
                {t.on === 'gamesCeiling' && (
                  <>
                    天井
                    <Num
                      value={t.n}
                      min={10}
                      width={70}
                      onChange={(v) => update((d) => void ((d.nav!.at.triggers[ti] as { n: number }).n = v ?? 500))}
                    />
                    G
                  </>
                )}
                <button
                  className="form-mini-btn"
                  disabled={at.triggers.length <= 1}
                  onClick={() => update((d) => void d.nav!.at.triggers.splice(ti, 1))}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="form-row">
              <button
                className="form-mini-btn"
                onClick={() =>
                  update((d) => {
                    const small = d.roles.find((r) => r.kind === 'small' && !r.nav);
                    const trigger: Mutable<AtTrigger> = small
                      ? { on: 'roleHit', of: small.id, prob: 0.3 }
                      : { on: 'pureMiss', prob: 0.01 };
                    d.nav!.at.triggers.push(trigger);
                  })
                }
              >
                きっかけを追加
              </button>
            </div>
            <div className="form-row">
              管理方式:
              <select
                className="form-select"
                value={at.management.type}
                onChange={(e) =>
                  update((d) => {
                    d.nav!.at.management =
                      e.target.value === 'set'
                        ? { type: 'set', gamesPerSet: 30, continueProb: 0.7 }
                        : { type: 'games', games: 50 };
                  })
                }
              >
                <option value="set">セット継続型</option>
                <option value="games">固定ゲーム数</option>
              </select>
              {at.management.type === 'set' ? (
                <>
                  <Num
                    value={at.management.gamesPerSet}
                    min={5}
                    width={60}
                    onChange={(v) =>
                      update(
                        (d) =>
                          void ((d.nav!.at.management as { gamesPerSet: number }).gamesPerSet = v ?? 30),
                      )
                    }
                  />
                  G × 継続率
                  <Num
                    value={Math.round(at.management.continueProb * 100)}
                    min={1}
                    max={99}
                    width={60}
                    onChange={(v) =>
                      update(
                        (d) =>
                          void ((d.nav!.at.management as { continueProb: number }).continueProb =
                            (v ?? 70) / 100),
                      )
                    }
                  />
                  %
                </>
              ) : (
                <>
                  <Num
                    value={at.management.games}
                    min={5}
                    width={70}
                    onChange={(v) =>
                      update((d) => void ((d.nav!.at.management as { games: number }).games = v ?? 50))
                    }
                  />
                  G
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

interface SectionProps {
  draft: MachineDef;
  update: (fn: (d: MachineDraft) => void) => void;
}

export function FormEditor({
  draft,
  onChange,
  tier = 'advanced',
}: {
  draft: MachineDef;
  onChange: (d: MachineDef) => void;
  /** ふつう = 数値のつまみだけ / 上級 = 構造（役・配列・システム）も編集 */
  tier?: 'normal' | 'advanced';
}) {
  const [setting, setSetting] = useState(1);
  const settings = draft.lottery.settings ?? 1;
  const effectiveSetting = Math.min(setting, settings);
  const structural = tier === 'advanced';

  const update = (fn: (d: MachineDraft) => void) => {
    const next = structuredClone(draft) as MachineDraft;
    fn(next);
    onChange(next as MachineDef);
  };

  return (
    <div className="form-editor" data-testid="form-editor">
      <SpecSummary draft={draft} setting={effectiveSetting} onSetting={setSetting} />
      <BasicSection draft={draft} update={update} />
      <LotterySection draft={draft} update={update} setting={effectiveSetting} structural={structural} />
      {structural && <RolesSection draft={draft} update={update} />}
      {structural && <ReelSection draft={draft} update={update} />}
      <BonusSection draft={draft} update={update} setting={effectiveSetting} structural={structural} />
      {structural && <SystemsSection draft={draft} update={update} />}
      {!structural && (
        <p className="panel-note">
          役の追加・図柄・リール配列・RT / ストック / AT の構造は「上級」タブで編集できます。
        </p>
      )}
    </div>
  );
}

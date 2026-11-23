import type { ReactNode } from 'react';
import type { DeviceState } from '../core/music/devices.js';

/**
 * 作曲の設定を3層で見せるための部品(層の見出しはインスペクタ composer/inspector.tsx のグループ)。
 *
 * 1. 基本: 様式・音源・調性・キー・BPM・進行(曲の正体を決める軸)と曲型
 * 2. 様式の既定を上書き: 語法・グルーヴ・装置(様式が既定を持ち、明示したときだけ上書き)
 * 3. 音色: 音源ごとの編曲層の設定(作曲結果は変えない)
 *
 * 2層の行は「選択」と並べて「いま何が効いているか」を必ず示す: 様式既定の解決値、
 * 上書き中の実効値、または装置が使えない理由。選択肢を消して黙らせない。
 */

/** 1層・3層向け: ラベル付きの入力(横並びグリッドに収まる)。 */
export function SettingField({ label, hint, children }: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="setting-field" title={hint}>
      <span className="setting-field-label">{label}</span>
      {children}
    </label>
  );
}

/** 2層向け: ラベル / 入力 / 実効値(または無効理由)の3列。 */
export function SettingRow({ label, hint, status, children }: {
  label: string;
  hint?: string | undefined;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <span className="setting-row-label" title={hint}>{label}</span>
      <div className="setting-row-control">{children}</div>
      <div className="setting-row-status">{status}</div>
    </div>
  );
}

/** 様式既定と現在値の関係を示す短いバッジ。 */
export function SettingStatus({ kind, children }: {
  kind: 'style' | 'override' | 'unavailable';
  children: ReactNode;
}) {
  return <span className={`setting-status setting-status-${kind}`}>{children}</span>;
}

/**
 * 装置(テンション・細分・ハモリ・スライド・ベースライン・連符)の行。
 * 選択肢の「スタイル既定」には解決値を併記し、使えない装置は理由付きで無効化する。
 */
export function DeviceRow<T extends string | number>({
  label, hint, state, choice, choices, labels, onChange, testId,
}: {
  label: string;
  hint?: string | undefined;
  state: DeviceState<T>;
  choice: 'auto' | T;
  choices: readonly ('auto' | T)[];
  labels: Record<string, string>;
  onChange: (next: 'auto' | T) => void;
  testId: string;
}) {
  const labelOf = (value: 'auto' | T | 'off'): string => labels[String(value)] ?? String(value);
  const unavailable = state.unavailable !== null;
  const status = unavailable
    ? <SettingStatus kind="unavailable">無効: {state.unavailable}</SettingStatus>
    : state.source === 'explicit'
      ? <SettingStatus kind="override">上書き → {labelOf(state.value)}（既定: {labelOf(state.styleDefault)}）</SettingStatus>
      : <SettingStatus kind="style">様式既定 → {labelOf(state.value)}</SettingStatus>;
  return (
    <SettingRow label={label} hint={hint} status={status}>
      <select
        value={String(choice)}
        disabled={unavailable}
        onChange={(e) => {
          const raw = e.target.value;
          const matched = choices.find((item) => String(item) === raw);
          if (matched !== undefined) onChange(matched);
        }}
        data-testid={testId}
        title={hint}
      >
        {choices.map((value) => (
          <option key={String(value)} value={String(value)}>
            {value === 'auto' ? `スタイル既定（${labelOf(state.styleDefault)}）` : labelOf(value)}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

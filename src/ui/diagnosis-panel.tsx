/**
 * 構造チェック（診断）パネル。診断の実体は core/music/diagnostics.ts で、
 * ここは結果表示と「修正して試聴」の操作だけを持つ。
 */

import type {
  CompositionIssue,
  CompositionRepair,
  DiagnosticCategory,
  StructuralReport,
} from '../core/music/diagnostics.js';
import { noteName } from '../core/music/theory.js';

const DIAGNOSTIC_LABELS: Record<DiagnosticCategory, string> = {
  harmony: '和声',
  melody: '旋律',
  voiceLeading: '声部進行',
  rhythm: 'リズム',
  counterpoint: '副旋律',
  texture: '編成',
  form: 'フォーム',
  loop: 'ループ',
};

const STRUCTURAL_STATUS_LABELS = {
  pass: '問題なし',
  attention: '要確認',
  error: '要修正',
} as const;

export interface DiagnosisItem {
  issue: CompositionIssue;
  originalIndex: number;
  repair: CompositionRepair | null;
}

export function DiagnosisPanel({ diagnosis, items, busy, canUndo, onApplyRepair, onUndoRepair }: {
  diagnosis: StructuralReport;
  /** 表示順に整列済みの指摘（修正案ありを先頭、上限件数に切り済み）。 */
  items: readonly DiagnosisItem[];
  busy: boolean;
  canUndo: boolean;
  onApplyRepair: (repair: CompositionRepair) => void;
  onUndoRepair: () => void;
}) {
  return (
    <details className="composer-diagnosis" data-testid="st-diagnosis">
      <summary>
        構造チェック: <span className={diagnosis.status === 'pass' ? 'badge-ok' : 'badge-ng'}>
          {STRUCTURAL_STATUS_LABELS[diagnosis.status]}
        </span>
        {diagnosis.issues.length > 0 && ` ／ 指摘 ${diagnosis.issues.length}件`}
      </summary>
      <div className="diagnosis-grid">
        {(Object.entries(diagnosis.categoryStatus) as [DiagnosticCategory, keyof typeof STRUCTURAL_STATUS_LABELS][])
          .map(([category, status]) => (
          <span key={category}>
            {DIAGNOSTIC_LABELS[category]}{' '}
            <b className={status === 'pass' ? 'badge-ok' : 'badge-ng'}>
              {STRUCTURAL_STATUS_LABELS[status]}
            </b>
          </span>
          ))}
      </div>
      {diagnosis.observations.length > 0 && (
        <div className="diagnosis-observations" data-testid="st-diagnosis-observations">
          <p className="panel-note">
            意図として許容: モチーフ反復
            {diagnosis.observations.filter((item) => item.kind === 'motif').length}件・装飾進行
            {diagnosis.observations.filter((item) => item.kind === 'embellishment').length}件
          </p>
          <ul>
            {diagnosis.observations.slice(0, 4).map((observation, index) => (
              <li key={`${observation.kind}-${observation.beat}-${index}`}>
                {observation.beat.toFixed(2)}拍: {observation.description}
                {observation.relatedBeats.length > 0
                  ? `（同型 ${observation.relatedBeats.map((beat) => beat.toFixed(2)).join('・')}拍）`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {diagnosis.issues.length > 0 && (
        <ul className="diagnosis-issues">
          {items.map(({ issue, originalIndex, repair }, index) => {
            return (
              <li key={`${issue.category}-${issue.beat}-${originalIndex}`}>
                {issue.severity === 'error' ? '要修正' : '注意'}・{DIAGNOSTIC_LABELS[issue.category]}・
                {issue.beat.toFixed(2)}拍: {issue.reason}
                {repair && (
                  <button
                    className="form-mini-btn"
                    onClick={() => onApplyRepair(repair)}
                    disabled={busy}
                    data-testid={`st-repair-${index}`}
                    title={`${noteName(repair.edit.fromMidi)}から${noteName(repair.edit.toMidi)}へ最小修正し、全曲を再診断します`}
                  >
                    修正して試聴（{noteName(repair.edit.fromMidi)}→{noteName(repair.edit.toMidi)}）
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canUndo && (
        <button
          className="form-mini-btn"
          onClick={onUndoRepair}
          disabled={busy}
          data-testid="st-repair-undo"
        >
          ↶ 直前の修正を戻して試聴
        </button>
      )}
    </details>
  );
}

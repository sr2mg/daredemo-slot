import {
  SECTION_BARS_CHOICES, SECTION_ROLES, SECTION_ROLE_LABELS, SONG_ENDINGS, SONG_ENDING_LABELS,
} from '../core/music/form.js';
import type { FormIssue } from '../core/music/form.js';
import { BAR_GROUPINGS, BAR_GROUPING_LABELS, DEFAULT_GROUPING } from '../core/music/grid.js';
import { KEYS, PROGRESSIONS, progressionForTonality } from '../core/music/theory.js';
import type {
  BarGrouping, MotifTransform, SectionBars, SectionEnergy, SectionRole, SectionSpec, SongEnding, SongFormSpec,
  Tonality,
} from '../core/music/types.js';

/**
 * 曲型(区間列)の編集表。1行=1区間で、役割・小節数・拍の割り方・エネルギー・主題・変形・引用・進行・調を
 * 宣言する。音の規則はここに持たず、検証(validateForm)の結果を行ごとに添えるだけ。
 */

const TRANSFORM_LABELS: Record<MotifTransform, string> = {
  original: '提示(初出)',
  literal: 'そのまま帰還',
  transpose: '移調',
  invert: '反転',
  contrast: '別主題として',
};

/** 再登場時に選べる変形(original は初出の意味なので選択肢に出さない)。 */
const TRANSFORM_CHOICES: readonly MotifTransform[] = ['literal', 'transpose', 'invert', 'contrast'];

const ENERGY_CHOICES: readonly SectionEnergy[] = [1, 2, 3, 4, 5];

export interface FormDefaults {
  progressionId: string;
  keyRoot: number;
  tonality: Tonality;
}

export function FormSectionTable({ form, defaults, issues, onChange }: {
  form: SongFormSpec;
  defaults: FormDefaults;
  issues: readonly FormIssue[];
  onChange: (next: SongFormSpec) => void;
}) {
  /** undefined の指定は「曲既定」= キーを消す(保存 JSON を正準に保つ)。 */
  type SectionPatch = { [K in keyof SectionSpec]?: SectionSpec[K] | undefined };
  const update = (index: number, patch: SectionPatch): void => {
    const sections = form.sections.map((section, i) => {
      if (i !== index) return section;
      const next = { ...section } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next as unknown as SectionSpec;
    });
    onChange({ ...form, sections });
  };
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= form.sections.length) return;
    const sections = [...form.sections];
    [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    onChange({ ...form, sections });
  };
  const remove = (index: number): void => {
    if (form.sections.length <= 1) return;
    onChange({ ...form, sections: form.sections.filter((_, i) => i !== index) });
  };
  const add = (): void => {
    const last = form.sections.at(-1);
    const usedIds = new Set(form.sections.map((section) => section.id));
    let id = last ? `${last.id}'` : 'A';
    while (usedIds.has(id)) id = `${id}'`;
    const section: SectionSpec = last
      ? {
        id, role: last.role, bars: last.bars, energy: last.energy, theme: last.theme, transform: 'literal',
        ...(last.grouping ? { grouping: last.grouping } : {}),
      }
      : { id, role: 'hook', bars: 8, energy: 3, theme: 'A' };
    onChange({ ...form, sections: [...form.sections, section] });
  };
  const issuesFor = (sectionId: string): FormIssue[] => issues.filter((issue) => issue.section === sectionId);
  const globalIssues = issues.filter((issue) => issue.section === null);
  const themeSeen = new Set<string>();

  return (
    <div className="form-table" data-testid="st-form-table">
      <table>
        <thead>
          <tr>
            <th>区間</th>
            <th>役割</th>
            <th>小節</th>
            <th>拍</th>
            <th>BPM</th>
            <th>力</th>
            <th>主題</th>
            <th>変形</th>
            <th>引用</th>
            <th>進行</th>
            <th>キー</th>
            <th>調性</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {form.sections.map((section, index) => {
            const reappears = themeSeen.has(section.theme);
            themeSeen.add(section.theme);
            const tonality = section.tonality ?? defaults.tonality;
            const progressions = PROGRESSIONS.filter((candidate) => {
              const realized = progressionForTonality(candidate, tonality);
              return realized !== null && realized.slots.length <= section.bars;
            });
            const earlier = form.sections.slice(0, index);
            const rowIssues = issuesFor(section.id);
            return (
              <tr key={index} className={rowIssues.some((issue) => issue.level === 'error') ? 'form-row-error' : ''}>
                <td>
                  <input
                    value={section.id}
                    onChange={(e) => update(index, { id: e.target.value })}
                    size={4}
                    data-testid={`st-section-id-${index}`}
                  />
                </td>
                <td>
                  <select value={section.role} onChange={(e) => update(index, { role: e.target.value as SectionRole })}>
                    {SECTION_ROLES.map((role) => <option key={role} value={role}>{SECTION_ROLE_LABELS[role]}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={section.bars}
                    onChange={(e) => update(index, { bars: Number(e.target.value) as SectionBars })}
                    data-testid={`st-section-bars-${index}`}
                  >
                    {SECTION_BARS_CHOICES.map((bars) => <option key={bars} value={bars}>{bars}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={section.grouping ?? DEFAULT_GROUPING}
                    onChange={(e) => update(index, {
                      grouping: e.target.value === DEFAULT_GROUPING ? undefined : e.target.value as BarGrouping,
                    })}
                    title="小節長はそのまま、拍の割り方だけ変える(12/8=付点4分×3連、6/4=ヘミオラ)。主題の元区間と揃えること"
                    data-testid={`st-section-grouping-${index}`}
                  >
                    {BAR_GROUPINGS.map((grouping) => (
                      <option key={grouping} value={grouping}>{BAR_GROUPING_LABELS[grouping]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={30}
                    max={400}
                    value={section.tempo ?? ''}
                    placeholder="曲"
                    onChange={(e) => update(index, { tempo: e.target.value === '' ? undefined : Number(e.target.value) })}
                    title="区間頭で切り替えるテンポ(空欄=曲の BPM)"
                    style={{ width: '4em' }}
                    data-testid={`st-section-tempo-${index}`}
                  />
                </td>
                <td>
                  <select value={section.energy} onChange={(e) => update(index, { energy: Number(e.target.value) as SectionEnergy })}>
                    {ENERGY_CHOICES.map((energy) => <option key={energy} value={energy}>{energy}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    value={section.theme}
                    onChange={(e) => update(index, { theme: e.target.value })}
                    size={3}
                    data-testid={`st-section-theme-${index}`}
                  />
                </td>
                <td>
                  {reappears ? (
                    <select
                      value={section.transform ?? 'literal'}
                      onChange={(e) => update(index, { transform: e.target.value as MotifTransform })}
                    >
                      {TRANSFORM_CHOICES.map((transform) => (
                        <option key={transform} value={transform}>{TRANSFORM_LABELS[transform]}</option>
                      ))}
                    </select>
                  ) : <span className="form-cell-note">{TRANSFORM_LABELS.original}</span>}
                </td>
                <td>
                  {reappears || earlier.length === 0 ? (
                    <span className="form-cell-note">—</span>
                  ) : (
                    <select
                      value={section.quote?.from ?? ''}
                      onChange={(e) => update(index, {
                        quote: e.target.value === '' ? undefined : { from: e.target.value, phrases: [section.bars === 4 ? 2 : 3] },
                      })}
                      title="元区間のフックを結論フレーズで予告する(ループ直前の回収など)"
                    >
                      <option value="">なし</option>
                      {earlier.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>{candidate.id} の結論へ</option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <select
                    value={section.progressionId ?? ''}
                    onChange={(e) => update(index, { progressionId: e.target.value === '' ? undefined : e.target.value })}
                    data-testid={`st-section-prog-${index}`}
                  >
                    <option value="">曲の進行</option>
                    {progressions.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={section.keyRoot ?? ''}
                    onChange={(e) => update(index, { keyRoot: e.target.value === '' ? undefined : Number(e.target.value) })}
                    data-testid={`st-section-key-${index}`}
                  >
                    <option value="">曲のキー</option>
                    {KEYS.map((key) => <option key={key.root} value={key.root}>{key.label}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={section.tonality ?? ''}
                    onChange={(e) => update(index, { tonality: e.target.value === '' ? undefined : e.target.value as Tonality })}
                  >
                    <option value="">曲の調性</option>
                    <option value="major">長調</option>
                    <option value="minor">短調</option>
                  </select>
                </td>
                <td className="form-row-actions">
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0} title="上へ">↑</button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === form.sections.length - 1} title="下へ">↓</button>
                  <button type="button" onClick={() => remove(index)} disabled={form.sections.length <= 1} title="削除">✕</button>
                  {rowIssues.length > 0 && (
                    <span className="form-row-issue" title={rowIssues.map((issue) => issue.message).join('\n')}>
                      {rowIssues.some((issue) => issue.level === 'error') ? '⚠' : 'ℹ'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form-table-foot">
        <button type="button" onClick={add} data-testid="st-section-add">＋ 区間を足す</button>
        <label>
          終わり方
          <select
            value={form.ending}
            onChange={(e) => onChange({ ...form, ending: e.target.value as SongEnding })}
            data-testid="st-form-ending"
          >
            {SONG_ENDINGS.map((ending) => <option key={ending} value={ending}>{SONG_ENDING_LABELS[ending]}</option>)}
          </select>
        </label>
        <span className="form-cell-note">
          合計 {form.sections.reduce((sum, section) => sum + section.bars, 0)} 小節・{form.sections.length} 区間
        </span>
      </div>
      {issues.length > 0 && (
        <ul className="form-issues">
          {[...globalIssues, ...issues.filter((issue) => issue.section !== null)].map((issue, index) => (
            <li key={index} className={issue.level === 'error' ? 'badge-ng' : 'form-issue-warning'}>
              {issue.section ? `[${issue.section}] ` : ''}{issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

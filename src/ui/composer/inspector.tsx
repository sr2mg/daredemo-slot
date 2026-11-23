/**
 * インスペクタ(右パネル)。選択中の対象で内容が切り替わる:
 * 区間を選んでいればその区間の操作と宣言、選んでいなければ曲全体の設定。
 *
 * 曲全体の設定は従来の3層の考え方を保つ: 「基本」(曲の正体を決める軸。様式を選ぶと
 * テンポ・グルーヴ・語法・進行の既定が追従する) / 「様式の既定を上書き」(語法・グルーヴ・装置。
 * 各行に解決値か無効理由を出し、選択肢を消して黙らせない) / 「音色」(編曲層。音の並びは変えない)。
 */

import { useState } from 'react';
import { NES_DUTIES } from '../../audio/nes-apu.js';
import { defaultVoicesFor, OPLL_USER_PATCHES } from '../../audio/opll-arrange.js';
import { OPLL_VOICES } from '../../audio/opll-core.js';
import { PCM_PART_LABELS } from '../../audio/pcm-arrange.js';
import {
  BASS_LINE_POLICY_LABELS, DEVICE_IDS, DEVICE_LABELS, DUET_POLICY_LABELS, GLIDE_POLICY_LABELS,
} from '../../core/music/devices.js';
import { DIMINUTION_POLICY_LABELS } from '../../core/music/diminution.js';
import {
  FORM_PRESET_IDS, FORM_PRESET_LABELS, isFormPresetId, SECTION_BARS_CHOICES, SECTION_ENERGY_CHOICES, SECTION_ROLES,
  SECTION_ROLE_LABELS, SONG_ENDING_LABELS,
} from '../../core/music/form.js';
import { GROOVE_FEELS, GROOVE_FEEL_LABELS } from '../../core/music/groove.js';
import { idiomFor, MELODIC_LANGUAGES } from '../../core/music/melodic-idiom.js';
import { TENSION_POLICY_LABELS } from '../../core/music/tension.js';
import { KEYS, PROGRESSIONS, STYLES, progressionForTonality } from '../../core/music/theory.js';
import {
  ARRANGEMENT_ARC_LABELS, COUNTER_ROLE_LABELS, JAPANESE_SCALE_LABELS, ORNAMENT_LABELS, PHRASE_FUNCTION_LABELS,
  TEXTURE_STRATEGY_LABELS, TUPLET_OVERLAY_LABELS,
} from '../../core/music/types.js';
import type {
  FormPresetId, JapaneseScaleChoice, MelodicLanguage, SectionBars, SectionEnergy, SectionRole, Tonality,
} from '../../core/music/types.js';
import type { GrooveFeel } from '../../core/music/groove.js';
import type { SoundBackendId } from '../../core/music/sound-capabilities.js';
import {
  BASS_LINE_CHOICES, DIMINUTION_CHOICES, DUET_CHOICES, effectiveDevices, GLIDE_CHOICES, songSummary, TENSION_CHOICES,
  TUPLET_CHOICES, VOICE_PARTS, voiceLabel,
} from '../composer-form.js';
import { DeviceRow, SettingField, SettingRow, SettingStatus } from '../composer-settings.js';
import { DiagnosisPanel } from '../diagnosis-panel.js';
import { PROGRESSION_USAGE } from '../progression-usage.js';
import { themeMemberIds, themeOriginId } from './piece-view.js';
import { clampGenerateBars, GENERATE_BARS } from './use-composer.js';
import type { Composer } from './use-composer.js';
import { encodePresetRef, LEAD_SLOTS, PCM_FIXED_PARTS, SOURCE_OPTIONS } from './use-soundfont.js';
import type { SoundFontControls } from './use-soundfont.js';
import type { SoundFontSource } from '../soundfont-store.js';

const keyLabel = (root: number): string => KEYS.find((key) => key.root === ((root % 12) + 12) % 12)?.label ?? '?';

function Group({ title, summary, defaultOpen = false, testId, children }: {
  title: string;
  /** 閉じていても分かるよう、見出しの右に出す現在値の要約。 */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="ws-group" open={defaultOpen} data-testid={testId}>
      <summary>
        <span className="ws-group-title">{title}</span>
        {summary !== undefined && <span className="ws-group-summary">{summary}</span>}
      </summary>
      <div className="ws-group-body">{children}</div>
    </details>
  );
}

/** 区間を選んでいるとき: その区間の操作(再生・ループ・作り直し)と宣言(役割・小節・力・進行・キー)。 */
function SectionInspector({ composer }: { composer: Composer }) {
  const { formSpec, form, selectedSection, selectedBlock, readOnly } = composer;
  const index = formSpec.sections.findIndex((section) => section.id === selectedSection);
  const section = formSpec.sections[index];
  if (!section || !selectedBlock) return null;
  const origin = themeOriginId(formSpec, section.id);
  const members = themeMemberIds(formSpec, section.id);
  const tonality = section.tonality ?? form.tonality;
  const sectionProgs = PROGRESSIONS.filter((candidate) => {
    const realized = progressionForTonality(candidate, tonality);
    return realized !== null && realized.slots.length <= section.bars;
  });
  const issues = composer.formIssues.filter((issue) => issue.section === section.id);

  return (
    <section className="ws-section-inspector" data-testid="ws-section-inspector">
      <header className="ws-inspector-title">
        <h3>区間 {section.id}</h3>
        <span>
          {selectedBlock.roleLabel}・{section.bars}小節・力 {section.energy}・キー {keyLabel(selectedBlock.keyRoot)}
        </span>
        <button type="button" className="ws-quiet-btn" onClick={() => composer.setSelectedSection(null)} title="曲全体の設定へ戻る">
          ✕
        </button>
      </header>
      <div className="ws-actions">
        <button type="button" onClick={() => composer.play(selectedBlock.startBeat)} data-testid="ws-section-play">
          ▶ ここから再生
        </button>
        <button
          type="button"
          className={composer.sectionLoop ? 'on' : ''}
          aria-pressed={composer.sectionLoop}
          onClick={() => composer.setSectionLoop(!composer.sectionLoop)}
          data-testid="ws-section-loop"
        >
          ⟲ この区間をループ
        </button>
        <button
          type="button"
          onClick={() => composer.regenerateSection(section.id)}
          disabled={readOnly || composer.progress !== null}
          data-testid="ws-section-regenerate"
        >
          🎲 旋律を作り直す
        </button>
      </div>
      <p className="panel-note">
        作り直すのは{origin === section.id ? 'この区間の主題' : `主題の初出である区間 ${origin}`}です。
        {members.length > 1 ? `同じ主題の ${members.join('・')} も一緒に変わります。` : ''}
        他の区間と、ベース・ドラムなどの声部はそのままです。
      </p>

      {!readOnly && (
        <>
          <div className="setting-grid">
            <SettingField label="役割" hint="編成・音色・エネルギー順位の機能">
              <select
                value={section.role}
                onChange={(e) => composer.updateSection(index, { role: e.target.value as SectionRole })}
                data-testid="ws-section-role"
              >
                {SECTION_ROLES.map((role) => <option key={role} value={role}>{SECTION_ROLE_LABELS[role]}</option>)}
              </select>
            </SettingField>
            <SettingField label="小節数">
              <select
                value={section.bars}
                onChange={(e) => composer.updateSection(index, { bars: Number(e.target.value) as SectionBars })}
                data-testid="ws-section-bars"
              >
                {SECTION_BARS_CHOICES.map((bars) => <option key={bars} value={bars}>{bars}</option>)}
              </select>
            </SettingField>
            <SettingField label="力（エネルギー）" hint="1..5。編成の密度ではなく、曲として目指す相対エネルギー">
              <select
                value={section.energy}
                onChange={(e) => composer.updateSection(index, { energy: Number(e.target.value) as SectionEnergy })}
                data-testid="ws-section-energy"
              >
                {SECTION_ENERGY_CHOICES.map((energy) => <option key={energy} value={energy}>{energy}</option>)}
              </select>
            </SettingField>
            <SettingField label="キー" hint="区間ごとの転調。曲のキーと同じなら「曲のキー」">
              <select
                value={section.keyRoot ?? ''}
                onChange={(e) => composer.updateSection(index, {
                  keyRoot: e.target.value === '' ? undefined : Number(e.target.value),
                })}
                data-testid="ws-section-key"
              >
                <option value="">曲のキー（{keyLabel(form.keyRoot)}）</option>
                {KEYS.map((key) => <option key={key.root} value={key.root}>{key.label}</option>)}
              </select>
            </SettingField>
            <SettingField label="進行" hint="この区間だけ別のコード進行にする">
              <select
                value={section.progressionId ?? ''}
                onChange={(e) => composer.updateSection(index, { progressionId: e.target.value || undefined })}
                data-testid="ws-section-prog"
              >
                <option value="">曲の進行（{composer.prog.name}）</option>
                {sectionProgs.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </SettingField>
          </div>
          {issues.map((issue, i) => (
            <p key={i} className={issue.level === 'error' ? 'badge-ng' : 'panel-note'}>{issue.message}</p>
          ))}
          <p className="panel-note">
            {composer.formPresetId !== null
              ? `曲型はプリセット「${FORM_PRESET_LABELS[composer.formPresetId]}」です。値を変えると区間列へ展開され、コードの選択は定番形へ戻ります。`
              : '区間の値を変えると、コードの選択は定番形へ戻ります。'}
            {' '}主題・変形・引用・拍の割り方・質感・伴奏型は、タイムライン下の「区間の表」で編集できます。
          </p>
        </>
      )}
    </section>
  );
}

/** 表示中の曲の設計情報(展開・編成・効いた装置・シード)。 */
function PieceFacts({ composer }: { composer: Composer }) {
  const { piece, viewOptions } = composer;
  if (!piece || !viewOptions) return null;
  const effective = effectiveDevices(viewOptions);
  const labelsOf: Record<string, Record<string, string>> = {
    tension: TENSION_POLICY_LABELS, diminution: DIMINUTION_POLICY_LABELS, duet: DUET_POLICY_LABELS,
    glide: GLIDE_POLICY_LABELS, bassLine: BASS_LINE_POLICY_LABELS, tupletOverlay: TUPLET_OVERLAY_LABELS,
  };
  return (
    <div data-testid="st-result">
      <p className="panel-note">
        展開: {ARRANGEMENT_ARC_LABELS[piece.arrangementPlan.arc]} ／
        編成: {TEXTURE_STRATEGY_LABELS[piece.arrangementPlan.textureStrategy]} ／
        副旋律: {COUNTER_ROLE_LABELS[piece.arrangementPlan.counterRole]} ／
        グルーヴ: {GROOVE_FEEL_LABELS[piece.grooveFeel]}
        {piece.japanesePlan && (
          <> ／ 和風音組織: {JAPANESE_SCALE_LABELS[piece.japanesePlan.id]}
            {' ／ '}装飾: {[...new Set(piece.phrasePlan.bars.flatMap((plan) => (plan.ornamentType ? [plan.ornamentType] : [])))]
              .map((type) => ORNAMENT_LABELS[type]).join('・') || 'なし'}
          </>
        )}
        {' ／ '}モチーフ: {[...new Set(piece.phrasePlan.bars.map((plan) => plan.phraseFunction))]
          .map((phraseFunction) => PHRASE_FUNCTION_LABELS[phraseFunction]).join('→')}
      </p>
      {effective && (
        <p className="panel-note" data-testid="st-effective-devices">
          この曲で効いた装置: {DEVICE_IDS.map((id) => {
            const state = effective[id];
            const value = labelsOf[id]![String(state.value)] ?? String(state.value);
            return `${DEVICE_LABELS[id]}=${value}${state.source === 'explicit' ? '(上書き)' : ''}`;
          }).join(' ／ ')}
        </p>
      )}
      <p className="panel-note">
        シード {viewOptions.seed}（同じシード + 同じ設定なら同じ曲になります）
        {viewOptions.sectionSeeds ? ` ／ 作り直した区間: ${Object.keys(viewOptions.sectionSeeds).join('・')}` : ''}
        {viewOptions.melodyEdits?.length ? ` ／ 局所修正 ${viewOptions.melodyEdits.length}` : ''}
      </p>
    </div>
  );
}

function TimbreGroup({ composer, soundfont }: { composer: Composer; soundfont: SoundFontControls }) {
  const { form, patch } = composer;
  if (form.soundChip === 'opll') {
    return (
      <div className="setting-grid">
        {VOICE_PARTS.map(({ part, label }) => (
          <SettingField key={part} label={label}>
            <select
              value={form.voices[part] ?? -1}
              onChange={(e) => {
                const voice = Number(e.target.value);
                const next = { ...form.voices };
                if (voice === -1) delete next[part];
                else next[part] = voice;
                patch({ voices: next });
              }}
              data-testid={`st-voice-${part}`}
            >
              <option value={-1}>スタイル既定（{voiceLabel(defaultVoicesFor(form.styleId)[part])}）</option>
              <option value={0}>ユーザー音色（曲ごとに1種）</option>
              {OPLL_VOICES.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
            </select>
          </SettingField>
        ))}
        {Object.values(form.voices).includes(0) && (
          <SettingField label="ユーザー音色" hint="OPLLの音色0番は、1曲につき1種類だけレジスタ定義できます">
            <select
              value={form.opllUserPatch}
              onChange={(e) => patch({ opllUserPatch: e.target.value as typeof form.opllUserPatch })}
              data-testid="st-opll-user-patch"
            >
              {OPLL_USER_PATCHES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </SettingField>
        )}
      </div>
    );
  }
  if (form.soundChip === 'nes2a03') {
    return (
      <>
        <div className="setting-grid" data-testid="st-nes-controls">
          {([['pulse1Duty', 'パルス1・主旋律'], ['pulse2Duty', 'パルス2・伴奏']] as const).map(([part, label]) => (
            <SettingField key={part} label={label}>
              <select
                value={form.nes[part] ?? (part === 'pulse1Duty' ? 1 : 2)}
                onChange={(e) => patch({ nes: { ...form.nes, [part]: Number(e.target.value) as 0 | 1 | 2 | 3 } })}
                data-testid={`st-nes-${part}`}
              >
                {NES_DUTIES.map((duty) => <option key={duty.id} value={duty.id}>{duty.label}</option>)}
              </select>
            </SettingField>
          ))}
        </div>
        <p className="panel-note nes-budget" data-testid="st-nes-budget">
          2A03配線: パルス1=主旋律 / パルス2=伴奏 / 三角波=ベース（音量変更不可） / ノイズ=ドラム / DPCM=未使用。
          1チャンネル1音、整数タイマー音程、15段階音量です。
        </p>
      </>
    );
  }
  return (
    <div data-testid="st-pcm-voices">
      <div className="setting-grid">
        <SettingField label="SoundFont">
          <select
            value={soundfont.fontSource}
            onChange={(e) => soundfont.selectSource(e.target.value as SoundFontSource)}
            data-testid="studio-font-source"
          >
            {SOURCE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </SettingField>
        <label className="setting-field">
          <span className="setting-field-label">SF2 ファイルを選ぶ</span>
          <input type="file" accept=".sf2" onChange={(e) => void soundfont.pickFile(e)} />
        </label>
      </div>
      <p className="panel-note">
        {soundfont.fontStatus}
        {soundfont.fontReady ? '' : ' — フォント読み込み完了までチップ音源で鳴ります'}
      </p>
      {soundfont.fontReady && (
        <div className="setting-grid">
          {LEAD_SLOTS.map(({ slot, label, title }) => (
            <SettingField key={`lead-${slot}`} label={label} hint={title}>
              <select
                value={encodePresetRef(soundfont.pcmVoices.leadColorVoices?.[slot])}
                onChange={(e) => soundfont.updateLeadColorVoice(slot, e.target.value)}
                data-testid={`studio-pcm-voice-lead-${slot}`}
              >
                <option value="auto">スタイル既定（受け渡し）</option>
                {soundfont.presetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </SettingField>
          ))}
          {PCM_FIXED_PARTS.map((part) => (
            <SettingField
              key={part}
              label={PCM_PART_LABELS[part]}
              hint="フォントの実プリセット一覧。GSバリエーションバンクの音色(中華系など)もここから選べます"
            >
              <select
                value={encodePresetRef(soundfont.pcmVoices[part])}
                onChange={(e) => soundfont.updatePcmVoice(part, e.target.value)}
                data-testid={`studio-pcm-voice-${part}`}
              >
                <option value="auto">スタイル既定</option>
                {soundfont.presetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </SettingField>
          ))}
        </div>
      )}
      <p className="panel-note">
        主旋律はセクション役割（A=看板 / B=展開 / 緩急）ごとに指定でき、未指定なら様式既定の受け渡しで自動的に切り替わります。
      </p>
    </div>
  );
}

function SongInspector({ composer, soundfont }: { composer: Composer; soundfont: SoundFontControls }) {
  const {
    form, patch, formSpec, formPresetId, formBars, prog, progs, styleDef, styleGroove, styleMelodicLanguage, devices,
    overrideCount,
  } = composer;
  const [generateBars, setGenerateBars] = useState<number>(GENERATE_BARS.fallback);
  const melodicIdiom = idiomFor(form.melodicLanguage);
  const formErrors = composer.formIssues.filter((issue) => issue.level === 'error');

  return (
    <>
      <Group title="基本" defaultOpen testId="st-layer-identity" summary={`${styleDef.name}・${keyLabel(form.keyRoot)}・BPM ${form.bpm}`}>
        <div className="setting-grid">
          <SettingField label="様式" hint="パターン×テンポ×グルーヴ×語法×進行の束。切り替えるとテンポ・グルーヴ・語法・推奨進行が追従します">
            <select value={form.styleId} onChange={(e) => composer.setStyle(e.target.value)} data-testid="st-style">
              {STYLES.map((style) => <option key={style.id} value={style.id}>{style.name}（{style.feel}）</option>)}
            </select>
          </SettingField>
          <SettingField label="音源" hint="曲ごとに保存され、BB/RB中の再生にもそのまま使われます">
            <select
              value={form.soundChip}
              onChange={(e) => patch({ soundChip: e.target.value as SoundBackendId })}
              data-testid="st-sound-chip"
            >
              <option value="opll">OPLL（YM2413・FM音源）</option>
              <option value="nes2a03">ファミコン 2A03（標準5ch制約）</option>
              <option value="pcm">PCM（SoundFont・制約最小）</option>
            </select>
          </SettingField>
          <SettingField label="調性" hint="コード進行と基礎音階の調性。旋律語法とは独立です">
            <select value={form.tonality} onChange={(e) => composer.setTonality(e.target.value as Tonality)} data-testid="st-tonality">
              <option value="major">長調</option>
              <option value="minor">短調</option>
            </select>
          </SettingField>
          <SettingField label="キー">
            <select value={form.keyRoot} onChange={(e) => patch({ keyRoot: Number(e.target.value) })} data-testid="st-key">
              {KEYS.map((key) => <option key={key.root} value={key.root}>{key.label}</option>)}
            </select>
          </SettingField>
          <SettingField
            label={`BPM${form.bpm !== styleDef.defaults.bpm ? `（様式既定 ${styleDef.defaults.bpm}）` : ''}`}
            hint="再生速度。音符やコードの並びは変えません"
          >
            <input
              type="number"
              min={80}
              max={220}
              value={form.bpm}
              onChange={(e) => {
                const bpm = Number(e.target.value);
                if (Number.isFinite(bpm) && bpm >= 80 && bpm <= 220) patch({ bpm });
              }}
              data-testid="st-bpm"
            />
          </SettingField>
        </div>
        <SettingField
          label={`コード進行${styleDef.defaults.progressionIds ? '（様式が推奨進行を持つ）' : ''}`}
          hint="小節スロット＋選択肢の方式。選ぶだけで破綻しない進行が組めます。小節ごとの選択はタイムラインのコード行で"
        >
          <select value={prog.id} onChange={(e) => composer.setProgression(e.target.value)} data-testid="st-prog">
            {progs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} — {candidate.feel}
                {PROGRESSION_USAGE[candidate.id] ? ` / ${PROGRESSION_USAGE[candidate.id]}` : ''}
              </option>
            ))}
          </select>
        </SettingField>
        <label className="ws-check">
          <input type="checkbox" checked={form.autoVary} onChange={(e) => patch({ autoVary: e.target.checked })} />
          {formSpec.sections.length > 1
            ? '「新しく作る」で、各区間へ異なるコード変化レシピを展開する'
            : formBars >= 8
              ? '「新しく作る」で、異なる2つのコード変化レシピを組み合わせる'
              : '「新しく作る」で、25%の確率でコード変化レシピを選ぶ'}
        </label>
      </Group>

      <Group
        title="曲型"
        testId="st-layer-form"
        summary={`${formPresetId ? FORM_PRESET_LABELS[formPresetId] : `カスタム ${formSpec.sections.length}区間`}・${formBars}小節`}
      >
        <div className="setting-grid">
          <SettingField label="プリセット" hint="ループはBGM向け。歌ものは96小節・12区間で終止して閉じる">
            <select
              value={formPresetId ?? 'custom'}
              onChange={(e) => {
                if (isFormPresetId(e.target.value)) composer.setForm(e.target.value as FormPresetId);
              }}
              data-testid="st-form"
            >
              {FORM_PRESET_IDS.map((id) => <option key={id} value={id}>{FORM_PRESET_LABELS[id]}</option>)}
              {formPresetId === null && <option value="custom">カスタム（{formBars}小節・{formSpec.sections.length}区間）</option>}
            </select>
          </SettingField>
          <SettingField label="生成の目標小節数" hint="様式の文法から区間列を作ります(4小節刻み)">
            <input
              type="number"
              min={GENERATE_BARS.min}
              max={GENERATE_BARS.max}
              step={4}
              value={generateBars}
              onChange={(e) => setGenerateBars(Number(e.target.value))}
              data-testid="st-form-generate-bars"
            />
          </SettingField>
        </div>
        <div className="ws-actions">
          <button type="button" onClick={() => composer.generateNewForm(generateBars)} data-testid="st-form-generate">
            🎲 曲型を生成（{styleDef.name}・{clampGenerateBars(generateBars)} 小節前後）
          </button>
        </div>
        <label className="ws-check">
          <input type="checkbox" checked={form.intro} onChange={(e) => patch({ intro: e.target.checked })} data-testid="st-intro" />
          2小節イントロを付ける（初回のみ）
        </label>
        <p className="panel-note">終わり方: {SONG_ENDING_LABELS[formSpec.ending]}</p>
        {formErrors.map((issue, index) => (
          <p key={index} className="badge-ng">{issue.section ? `[${issue.section}] ` : ''}{issue.message}</p>
        ))}
        <p className="panel-note">
          区間ごとの宣言（主題・変形・引用・拍の割り方・質感・伴奏型など）は、タイムライン下の「区間の表」で編集できます。
        </p>
      </Group>

      <Group
        title="様式の既定を上書き"
        testId="st-layer-overrides"
        summary={<span data-testid="st-override-count">{overrideCount === 0 ? 'すべて様式既定' : `${overrideCount}件を上書き中`}</span>}
      >
        <div className="ws-actions">
          <button type="button" onClick={composer.resetOverrides} disabled={overrideCount === 0} data-testid="st-reset-overrides">
            様式の既定に戻す
          </button>
        </div>
        <div className="setting-rows">
          <SettingRow
            label="旋律語法"
            hint="調性とは独立して、旋律の音使い・間・装飾を選びます"
            status={form.melodicLanguage === styleMelodicLanguage
              ? <SettingStatus kind="style">様式既定 → {idiomFor(styleMelodicLanguage).label}</SettingStatus>
              : <SettingStatus kind="override">上書き → {melodicIdiom.label}（既定: {idiomFor(styleMelodicLanguage).label}）</SettingStatus>}
          >
            <select
              value={form.melodicLanguage}
              onChange={(e) => patch({ melodicLanguage: e.target.value as MelodicLanguage })}
              data-testid="st-melodic-language"
            >
              {MELODIC_LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {idiomFor(language).label}{language === styleMelodicLanguage ? '（様式既定）' : ''}
                </option>
              ))}
            </select>
            {melodicIdiom.hasScaleChoice && (
              <div className="setting-sub">
                <select
                  value={form.japaneseScale}
                  onChange={(e) => patch({ japaneseScale: e.target.value as JapaneseScaleChoice })}
                  data-testid="st-japanese-scale"
                  title="自動ではシードごとに律・民謡・都節の音組織を選びます"
                >
                  {(['auto', 'ritsu', 'minyo', 'miyakobushi'] as const).map((id) => (
                    <option key={id} value={id}>和風音組織: {JAPANESE_SCALE_LABELS[id]}</option>
                  ))}
                </select>
              </div>
            )}
          </SettingRow>
          <SettingRow
            label="グルーヴ"
            hint="旋律語法とは独立。三連は元のハイハット譜を三連位置へ写し、跳ねる8分は裏拍の位置を変えます"
            status={form.grooveFeel === styleGroove
              ? <SettingStatus kind="style">様式既定 → {GROOVE_FEEL_LABELS[styleGroove]}</SettingStatus>
              : <SettingStatus kind="override">上書き → {GROOVE_FEEL_LABELS[form.grooveFeel]}（既定: {GROOVE_FEEL_LABELS[styleGroove]}）</SettingStatus>}
          >
            <select
              value={form.grooveFeel}
              onChange={(e) => patch({ grooveFeel: e.target.value as GrooveFeel })}
              data-testid="st-groove-feel"
            >
              {GROOVE_FEELS.map((feel) => (
                <option key={feel} value={feel}>{GROOVE_FEEL_LABELS[feel]}{feel === styleGroove ? '（様式既定）' : ''}</option>
              ))}
            </select>
          </SettingRow>
          <DeviceRow
            label={DEVICE_LABELS.tension}
            hint="伴奏ボイシングへ足すカラートーン。アヴェイラブル・テンション理論で自動導出します（和声機能は不変。7th系和音は声部上限により1音まで）"
            state={devices.tension}
            choice={form.tensionPolicy}
            choices={TENSION_CHOICES}
            labels={TENSION_POLICY_LABELS}
            onChange={(next) => patch({ tensionPolicy: next })}
            testId="st-tension-policy"
          />
          <DeviceRow
            label={DEVICE_LABELS.diminution}
            hint="8分骨格の間へ16分の経過音を挿入します（骨格は不変・縮小変奏）"
            state={devices.diminution}
            choice={form.diminution}
            choices={DIMINUTION_CHOICES}
            labels={DIMINUTION_POLICY_LABELS}
            onChange={(next) => patch({ diminution: next })}
            testId="st-diminution"
          />
          <DeviceRow
            label={DEVICE_LABELS.duet}
            hint="主旋律に下3度で並走するハモリ声部。声部が混雑するチップでは自動的に譲ります"
            state={devices.duet}
            choice={form.duet}
            choices={DUET_CHOICES}
            labels={DUET_POLICY_LABELS}
            onChange={(next) => patch({ duet: next })}
            testId="st-duet"
          />
          <DeviceRow
            label={DEVICE_LABELS.glide}
            hint="近接した跳躍へポルタメント（前音からのスライド）を付けます"
            state={devices.glide}
            choice={form.glide}
            choices={GLIDE_CHOICES}
            labels={GLIDE_POLICY_LABELS}
            onChange={(next) => patch({ glide: next })}
            testId="st-glide"
          />
          <DeviceRow
            label={DEVICE_LABELS.bassLine}
            hint="和声計画へ分数コードを書き、ベースを転回・半音経過込みの順次ラインにします"
            state={devices.bassLine}
            choice={form.bassLine}
            choices={BASS_LINE_CHOICES}
            labels={BASS_LINE_POLICY_LABELS}
            onChange={(next) => patch({ bassLine: next })}
            testId="st-bass-line"
          />
          <DeviceRow
            label={DEVICE_LABELS.tupletOverlay}
            hint="分散和音だけを1小節div等分の連符へ乗せ、他声部は動かさずに暗示テンポ（BPM×div/4）の錯覚を作ります"
            state={devices.tupletOverlay}
            choice={form.tupletOverlay}
            choices={TUPLET_CHOICES}
            labels={TUPLET_OVERLAY_LABELS}
            onChange={(next) => patch({ tupletOverlay: next })}
            testId="st-tuplet-overlay"
          />
        </div>
      </Group>

      <Group title="音色" testId="st-layer-timbre" summary="音の並びは変えません">
        <TimbreGroup composer={composer} soundfont={soundfont} />
      </Group>
    </>
  );
}

export function Inspector({ composer, soundfont }: { composer: Composer; soundfont: SoundFontControls }) {
  const { diagnosis, readOnly, viewOptions } = composer;
  const issueCount = diagnosis?.issues.length ?? 0;
  return (
    <aside className="ws-inspector" data-testid="ws-inspector">
      {composer.selectedBlock && <SectionInspector composer={composer} />}
      {!composer.selectedBlock && (
        <header className="ws-inspector-title">
          <h3>{readOnly ? '試聴中の曲' : '曲全体'}</h3>
          <span>{readOnly ? '' : '区間ブロックをクリックすると、その区間の内容に切り替わります'}</span>
        </header>
      )}
      {readOnly
        ? viewOptions && <p className="panel-note">{songSummary(viewOptions)}</p>
        : !composer.selectedBlock && <SongInspector composer={composer} soundfont={soundfont} />}
      <Group
        title="診断と設計"
        testId="ws-diagnosis"
        defaultOpen={readOnly}
        summary={diagnosis ? (issueCount === 0 ? '指摘なし' : `指摘 ${issueCount}件`) : ''}
      >
        <PieceFacts composer={composer} />
        {diagnosis && (
          <DiagnosisPanel
            diagnosis={diagnosis}
            items={composer.diagnosisItems}
            busy={composer.progress !== null || readOnly}
            canUndo={!readOnly && composer.form.melodyEdits.length > 0}
            onApplyRepair={composer.applyRepair}
            onUndoRepair={composer.undoRepair}
          />
        )}
      </Group>
    </aside>
  );
}

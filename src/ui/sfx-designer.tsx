import { useState } from 'react';
import { SFX_RECIPES } from '../core/music/sfx-design.js';
import type { SfxDesign } from '../core/music/sfx-design.js';
import { NOTE_NAMES } from '../core/music/theory.js';
import { OPLL_VOICES } from './opll-core.js';
import type { SfxName } from './opll-core.js';
import type { SfxPlayer } from './sfx-player.js';
import {
  ASSIGNABLE_SFX,
  DEFAULT_CHOICE,
  loadSfxAssign,
  loadSfxDesigns,
  PRESET_SFX,
  saveSfxAssign,
  saveSfxDesigns,
} from './sfx-library.js';
import type { SavedSfx, SfxAssign } from './sfx-library.js';

/**
 * 効果音作成（レシピから）パネル。
 * レシピ = 効果音理論のテンプレ（確定 = V→I 上行 / 操作ビープ = 6度ハモリ /
 * 警告 = トライトーンへのベンド など）。レシピを選び、基準音・速さ・OPLL 音色だけ
 * 調整して作る。試聴・ゲーム内再生とも OPLL（emu2413）でレンダリングされる。
 * ゲームの既定効果音も同じレシピのプリセット（PRESET_SFX）なので、
 * ベット音等を差し替えたいときはここで作って契機に割り当てる。
 */

const newId = (): string => `x${Date.now().toString(36)}${((Math.random() * 0xffff_ffff) >>> 0).toString(36)}`;

/** 基準音の選択肢（低域 = 停止音系 〜 高域 = 告知系） */
const ROOT_CHOICES = [48, 53, 60, 67, 72, 74, 76, 77, 79, 81, 84, 96];

const SPEED_CHOICES = [
  { value: 0.75, label: 'ゆっくり' },
  { value: 1, label: '標準' },
  { value: 1.4, label: '速い' },
  { value: 1.8, label: '最速' },
];

const noteLabel = (midi: number): string => `${NOTE_NAMES[midi % 12]!}${Math.floor(midi / 12) - 1}`;

function designSummary(design: SfxDesign): string {
  const recipe = SFX_RECIPES.find((r) => r.id === design.recipeId)?.name ?? design.recipeId;
  const speed = SPEED_CHOICES.find((s) => s.value === design.speed)?.label ?? design.speed;
  const voice = OPLL_VOICES.find((v) => v.id === design.voice)?.label.split('（')[0] ?? design.voice;
  return `${recipe} / ${noteLabel(design.rootMidi)} / ${speed} / ${voice}`;
}

export function SfxDesignerPanel({ player }: { player: SfxPlayer }) {
  const [recipeId, setRecipeId] = useState(SFX_RECIPES[0]!.id);
  const [rootMidi, setRootMidi] = useState(SFX_RECIPES[0]!.defaultRoot);
  const [speed, setSpeed] = useState(1);
  const [voice, setVoice] = useState(SFX_RECIPES[0]!.defaultVoice);
  const [designs, setDesigns] = useState<SavedSfx[]>(loadSfxDesigns);
  const [assign, setAssign] = useState<SfxAssign>(loadSfxAssign);
  const [sfxName, setSfxName] = useState('');
  const [error, setError] = useState('');

  const recipe = SFX_RECIPES.find((r) => r.id === recipeId)!;
  const current: SfxDesign = { recipeId, rootMidi, speed, voice };

  const selectRecipe = (id: string) => {
    setRecipeId(id);
    // レシピごとに効果的な音域・音色が違うので推奨値に合わせる
    const next = SFX_RECIPES.find((r) => r.id === id)!;
    setRootMidi(next.defaultRoot);
    setVoice(next.defaultVoice);
  };

  const preview = (design: SfxDesign) => {
    void player.previewDesign(design).then((ok) => {
      setError(ok ? '' : '再生できませんでした（レシピか保存データが不正かも）');
    });
  };

  const saveCurrent = () => {
    const name = sfxName.trim() || designSummary(current);
    const next = [...designs, { id: newId(), name, design: current }];
    setDesigns(next);
    saveSfxDesigns(next);
    setSfxName('');
  };

  const deleteDesign = (id: string) => {
    const next = designs.filter((d) => d.id !== id);
    setDesigns(next);
    saveSfxDesigns(next);
    // 割り当て中の音を消したらプリセットに戻し、ゲーム用の波形を作り直す
    const fixed: SfxAssign = { ...assign };
    let changed = false;
    for (const key of Object.keys(fixed) as SfxName[]) {
      if (fixed[key] === `custom:${id}`) {
        delete fixed[key];
        changed = true;
        player.refreshSfx(key);
      }
    }
    if (changed) {
      setAssign(fixed);
      saveSfxAssign(fixed);
    }
  };

  const updateAssign = (name: SfxName, value: string) => {
    // 'preset' も明示的に保存する（bet のように既定が 'none' の契機を preset に戻せるように）
    const next: SfxAssign = { ...assign, [name]: value };
    setAssign(next);
    saveSfxAssign(next);
    player.refreshSfx(name); // ゲーム用の波形を新しい割り当てで作り直す
  };

  return (
    <details className="panel">
      <summary>効果音作成（レシピから）</summary>
      <div className="panel-body">
        <div className="panel-controls">
          <select value={recipeId} onChange={(e) => selectRecipe(e.target.value)} data-testid="fx-recipe">
            {SFX_RECIPES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select value={rootMidi} onChange={(e) => setRootMidi(Number(e.target.value))} data-testid="fx-root">
            {ROOT_CHOICES.map((m) => (
              <option key={m} value={m}>
                基準音: {noteLabel(m)}
              </option>
            ))}
          </select>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} data-testid="fx-speed">
            {SPEED_CHOICES.map((s) => (
              <option key={s.value} value={s.value}>
                速さ: {s.label}
              </option>
            ))}
          </select>
          <select value={voice} onChange={(e) => setVoice(Number(e.target.value))} data-testid="fx-voice">
            {OPLL_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                音色: {v.label}
              </option>
            ))}
          </select>
        </div>
        <p className="panel-note">理論: {recipe.theory}</p>

        <div className="panel-controls">
          <button onClick={() => preview(current)} data-testid="fx-preview">
            ♪ 試聴
          </button>
          <input
            type="text"
            className="song-name-input"
            placeholder={designSummary(current)}
            value={sfxName}
            onChange={(e) => setSfxName(e.target.value)}
            data-testid="fx-name"
          />
          <button onClick={saveCurrent} data-testid="fx-save">
            💾 リストに保存
          </button>
        </div>
        {error && <p className="badge-ng">{error}</p>}

        {designs.length > 0 && (
          <div className="song-list" data-testid="fx-list">
            {designs.map((d) => (
              <div key={d.id} className="song-row">
                <span className="song-name">★ {d.name}</span>
                <span className="song-summary">{designSummary(d.design)}</span>
                <button className="form-mini-btn" onClick={() => preview(d.design)} data-testid={`fx-play-${d.id}`}>
                  ♪ 試聴
                </button>
                <button
                  className="form-mini-btn song-delete"
                  onClick={() => deleteDesign(d.id)}
                  data-testid={`fx-delete-${d.id}`}
                >
                  🗑 削除
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="assign-grid">
          {ASSIGNABLE_SFX.map((item) => (
            <label key={item.name} className="assign-item">
              <span className="slot-label">{item.label}</span>
              <select
                value={assign[item.name] ?? DEFAULT_CHOICE[item.name] ?? 'preset'}
                onChange={(e) => updateAssign(item.name, e.target.value)}
                data-testid={`fx-assign-${item.name}`}
              >
                <option value="preset">既定（{designSummary(PRESET_SFX[item.name])}）</option>
                <option value="none">なし（鳴らさない）</option>
                {designs.map((d) => (
                  <option key={d.id} value={`custom:${d.id}`}>
                    ★ {d.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="panel-note">
          ゲームの既定効果音もすべてこのレシピのプリセットで、再生は OPLL（emu2413）。
          差し替えたい契機に自作の音を、消したい契機に「なし」を割り当ててください。
          ベットは MAX BET 前提で既定「なし」（投入音はレバーオンに集約）。
        </p>
      </div>
    </details>
  );
}

import { useEffect, useRef, useState } from 'react';
import { buildSfxEvents, SFX_RECIPES } from '../core/music/sfx-design.js';
import type { SfxDesign } from '../core/music/sfx-design.js';
import { SfxDesignPlayer } from '../core/music/sfx-play.js';
import { NOTE_NAMES } from '../core/music/theory.js';
import {
  ASSIGNABLE_SFX,
  loadSfxAssign,
  loadSfxDesigns,
  saveSfxAssign,
  saveSfxDesigns,
} from './sfx-library.js';
import type { SavedSfx, SfxAssign } from './sfx-library.js';

/**
 * 効果音作成（レシピから）パネル。
 * レシピ = 効果音理論のテンプレ（確定 = V→I 上行 / 煽り = 解決しない半音上昇 /
 * 操作確認 = 4度上行 / キャンセル = 下行 / 警告 = トライトーンへのベンド）。
 * レシピを選び、基準音・速さ・音色だけ調整して作る。保存した音はゲーム内の
 * 各契機（ファンファーレ・キュイン等）に割り当てられる（App.tsx が再生時に読む）。
 */

const newId = (): string => `x${Date.now().toString(36)}${((Math.random() * 0xffff_ffff) >>> 0).toString(36)}`;

/** 基準音の選択肢（C5〜C6。警告系は高めが貫通する） */
const ROOT_CHOICES = [72, 74, 76, 77, 79, 81, 83, 84];

const SPEED_CHOICES = [
  { value: 0.75, label: 'ゆっくり' },
  { value: 1, label: '標準' },
  { value: 1.4, label: '速い' },
  { value: 1.8, label: '最速' },
];

const WAVE_CHOICES: readonly { value: SfxDesign['wave']; label: string }[] = [
  { value: 'square', label: '矩形波（ピコピコ）' },
  { value: 'triangle', label: '三角波（まるい）' },
  { value: 'sawtooth', label: 'ノコギリ波（ブラス風）' },
  { value: 'sine', label: 'サイン波（ポー）' },
];

const noteLabel = (midi: number): string => `${NOTE_NAMES[midi % 12]!}${Math.floor(midi / 12) - 1}`;

function designSummary(design: SfxDesign): string {
  const recipe = SFX_RECIPES.find((r) => r.id === design.recipeId)?.name ?? design.recipeId;
  const speed = SPEED_CHOICES.find((s) => s.value === design.speed)?.label ?? design.speed;
  const wave = WAVE_CHOICES.find((w) => w.value === design.wave)?.label.split('（')[0] ?? design.wave;
  return `${recipe} / ${noteLabel(design.rootMidi)} / ${speed} / ${wave}`;
}

export function SfxDesignerPanel() {
  const [recipeId, setRecipeId] = useState(SFX_RECIPES[0]!.id);
  const [rootMidi, setRootMidi] = useState(SFX_RECIPES[0]!.defaultRoot);
  const [speed, setSpeed] = useState(1);
  const [wave, setWave] = useState<SfxDesign['wave']>('square');
  const [designs, setDesigns] = useState<SavedSfx[]>(loadSfxDesigns);
  const [assign, setAssign] = useState<SfxAssign>(loadSfxAssign);
  const [sfxName, setSfxName] = useState('');
  const [error, setError] = useState('');

  const playerRef = useRef<SfxDesignPlayer | null>(null);
  useEffect(() => {
    playerRef.current = new SfxDesignPlayer();
    return () => playerRef.current?.dispose();
  }, []);

  const recipe = SFX_RECIPES.find((r) => r.id === recipeId)!;
  const current: SfxDesign = { recipeId, rootMidi, speed, wave };

  const selectRecipe = (id: string) => {
    setRecipeId(id);
    // レシピごとに効果的な音域が違うので推奨値に合わせる（警告系は高め）
    setRootMidi(SFX_RECIPES.find((r) => r.id === id)!.defaultRoot);
  };

  const preview = (design: SfxDesign) => {
    try {
      playerRef.current?.play(buildSfxEvents(design), design.wave);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
    // 割り当て中の音を消したら内蔵（OPLL）に戻す
    const fixed: SfxAssign = { ...assign };
    let changed = false;
    for (const key of Object.keys(fixed) as (keyof SfxAssign)[]) {
      if (fixed[key] === `custom:${id}`) {
        delete fixed[key];
        changed = true;
      }
    }
    if (changed) {
      setAssign(fixed);
      saveSfxAssign(fixed);
    }
  };

  const updateAssign = (name: string, value: string) => {
    const next: SfxAssign = { ...assign };
    if (value === 'builtin') delete next[name as keyof SfxAssign];
    else next[name as keyof SfxAssign] = value;
    setAssign(next);
    saveSfxAssign(next);
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
          <select
            value={wave}
            onChange={(e) => setWave(e.target.value as SfxDesign['wave'])}
            data-testid="fx-wave"
          >
            {WAVE_CHOICES.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
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
                value={assign[item.name] ?? 'builtin'}
                onChange={(e) => updateAssign(item.name, e.target.value)}
                data-testid={`fx-assign-${item.name}`}
              >
                <option value="builtin">内蔵（OPLL）</option>
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
          保存した音はゲーム内の各契機に割り当てられます。割り当てない契機は内蔵の OPLL 音のまま。
          レシピは効果音理論のテンプレなので、どのパラメータでも「意味」は保たれます。
        </p>
      </div>
    </details>
  );
}

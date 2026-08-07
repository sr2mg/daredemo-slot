import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { BgmComposerPanel } from './bgm-composer.js';
import type { BgmPcmRenderer } from './bgm-audio.js';
import { PCM_PART_LABELS } from './pcm-arrange.js';
import type { PcmPart, PcmVoiceOverride } from './pcm-arrange.js';
import { loadStored, saveStored } from './persist.js';
import { SfxPlayer } from './sfx-player.js';
import type { ActiveSoundFont, SoundFontSource } from './soundfont-store.js';

/**
 * 作曲特化の単独エントリ（bgm.html）。
 *
 * スロット本体（index.html）と分離することで、
 * - ゲーム側バンドルへ作曲専用機能の重量を乗せない
 * - PCM(SoundFont)レンダラなど「作曲ページ限定の重い足し算」の置き場を作る
 * 保存曲・音色設定はlocalStorage経由で本体のサウンドテストと共有される。
 * SF2関連のコードとフォント本体は、PCMを選んだ瞬間にだけ動的ロードされる。
 */

const SOURCE_OPTIONS: readonly { id: SoundFontSource; label: string }[] = [
  { id: 'bundled', label: '同梱 GeneralUser GS（GS準拠・再配布可）' },
  { id: 'local', label: 'local/user.sf2（git管理外の私物フォント）' },
  { id: 'picked', label: '保存済みの選択ファイル' },
];

const PCM_PARTS: readonly PcmPart[] = ['lead', 'duet', 'counter', 'ostinato', 'backing', 'bass', 'drums'];
const PCM_VOICES_KEY = 'daredemo.pcmVoices.v1';

function loadPcmVoices(): PcmVoiceOverride {
  return loadStored<PcmVoiceOverride>(
    PCM_VOICES_KEY,
    {},
    (value): value is PcmVoiceOverride => value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.entries(value as Record<string, unknown>).every(([part, ref]) => (
        (PCM_PARTS as readonly string[]).includes(part)
        && ref !== null && typeof ref === 'object'
        && Number.isInteger((ref as { bank?: unknown }).bank)
        && Number.isInteger((ref as { program?: unknown }).program)
      )),
  );
}

export function BgmStudio() {
  const playerRef = useRef<SfxPlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new SfxPlayer();
  const [soundOn, setSoundOn] = useState(() => playerRef.current!.enabled);
  const [rendererMode, setRendererMode] = useState<'chip' | 'pcm'>('chip');
  const [fontSource, setFontSource] = useState<SoundFontSource>('bundled');
  const [activeFont, setActiveFont] = useState<ActiveSoundFont | null>(null);
  const [fontStatus, setFontStatus] = useState('');
  const [pcmVoices, setPcmVoices] = useState<PcmVoiceOverride>(loadPcmVoices);

  const updatePcmVoice = (part: PcmPart, encoded: string) => {
    const next: PcmVoiceOverride = { ...pcmVoices };
    if (encoded === 'auto') {
      delete next[part];
    } else {
      const [bank, program] = encoded.split(':').map(Number);
      next[part] = { bank: bank!, program: program! };
    }
    setPcmVoices(next);
    saveStored(PCM_VOICES_KEY, next);
  };

  const loadFont = async (source: SoundFontSource) => {
    setFontStatus('SoundFont読み込み中…（同梱フォントは約31MB、初回のみ）');
    try {
      const store = await import('./soundfont-store.js');
      const font = await store.loadSoundFont(source);
      setActiveFont(font);
      setFontStatus(`使用中: ${font.label}`);
    } catch (e) {
      setActiveFont(null);
      setFontStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const selectSource = (source: SoundFontSource) => {
    setFontSource(source);
    setActiveFont(null);
    void loadFont(source);
  };

  const selectMode = (mode: 'chip' | 'pcm') => {
    setRendererMode(mode);
    if (mode === 'pcm' && !activeFont) void loadFont(fontSource);
  };

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFontStatus(`${file.name} を読み込み中…`);
    try {
      const store = await import('./soundfont-store.js');
      const font = await store.savePickedSoundFont(file);
      setFontSource('picked');
      setActiveFont(font);
      setFontStatus(`使用中: ${font.label}（IndexedDBへ保存済み。次回から「保存済みの選択ファイル」で再利用可）`);
    } catch (e) {
      setFontStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const pcmRenderer = useMemo<BgmPcmRenderer | null>(() => {
    if (rendererMode !== 'pcm' || !activeFont) return null;
    // 音色上書きは波形を変えるので、キャッシュキー(id)へ必ず含める。
    return {
      id: `sf2:${activeFont.id}:${JSON.stringify(pcmVoices)}`,
      render: async (piece) => {
        const { renderSf2Bgm } = await import('./pcm-arrange.js');
        return renderSf2Bgm(piece, activeFont.font, pcmVoices);
      },
    };
  }, [rendererMode, activeFont, pcmVoices]);

  // 読み込んだフォントの実プリセット一覧(バンク・番号順)。GSバリエーション音色もここに出る。
  const presetOptions = useMemo(() => {
    if (!activeFont) return [];
    return [...activeFont.font.presets]
      .sort((a, b) => a.bank - b.bank || a.program - b.program)
      .map((preset) => ({
        value: `${preset.bank}:${preset.program}`,
        label: `${preset.bank}:${String(preset.program).padStart(3, '0')} ${preset.name}`,
      }));
  }, [activeFont]);

  return (
    <div className="app bgm-studio">
      <header className="studio-header">
        <h1>作曲スタジオ</h1>
        <label>
          <input
            type="checkbox"
            checked={soundOn}
            onChange={(e) => {
              setSoundOn(e.target.checked);
              playerRef.current?.setEnabled(e.target.checked);
            }}
            data-testid="studio-sound-toggle"
          />
          音
        </label>
        <select
          value={rendererMode}
          onChange={(e) => selectMode(e.target.value as 'chip' | 'pcm')}
          data-testid="studio-renderer"
          title="チップ=OPLL/2A03(保存曲の設定どおり)。PCM=SoundFontで00年代GM/GS音源風に鳴らす"
        >
          <option value="chip">音源: チップ（OPLL / 2A03）</option>
          <option value="pcm">音源: PCM（SoundFont）</option>
        </select>
        {rendererMode === 'pcm' && (
          <>
            <select
              value={fontSource}
              onChange={(e) => selectSource(e.target.value as SoundFontSource)}
              data-testid="studio-font-source"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <label className="panel-note">
              SF2を選ぶ… <input type="file" accept=".sf2" onChange={(e) => void pickFile(e)} />
            </label>
          </>
        )}
        <a className="panel-note" href="./">← スロット本体へ</a>
      </header>
      {rendererMode === 'pcm' && (
        <p className="panel-note">
          {fontStatus}
          {pcmRenderer === null && activeFont === null
            ? ' — フォント読み込み完了までチップ音源で鳴ります'
            : ''}
        </p>
      )}
      {rendererMode === 'pcm' && activeFont && (
        <div className="panel-controls studio-voices">
          {PCM_PARTS.map((part) => {
            const current = pcmVoices[part];
            return (
              <select
                key={part}
                value={current ? `${current.bank}:${current.program}` : 'auto'}
                onChange={(e) => updatePcmVoice(part, e.target.value)}
                data-testid={`studio-pcm-voice-${part}`}
                title="フォントの実プリセット一覧。GSバリエーションバンクの音色(中華系など)もここから選べます"
              >
                <option value="auto">{PCM_PART_LABELS[part]}: スタイル既定</option>
                {presetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {PCM_PART_LABELS[part]}: {option.label}
                  </option>
                ))}
              </select>
            );
          })}
        </div>
      )}
      <BgmComposerPanel player={playerRef.current!} pcmRenderer={pcmRenderer} />
      <p className="panel-note credit-note">
        音源コア:{' '}
        <a href="https://github.com/digital-sound-antiques/emu2413" target="_blank" rel="noreferrer">
          emu2413
        </a>{' '}
        © Mitsutaka Okazaki（MIT License）— YM2413（OPLL）互換実装。2A03 BGM は NES APU 公開仕様に基づく内蔵実装、
        PCM は SoundFont2 の内蔵サブセット実装です。同梱の{' '}
        <a href="https://github.com/mrbumpy409/GeneralUser-GS" target="_blank" rel="noreferrer">
          GeneralUser GS
        </a>{' '}
        © S. Christian Collins は同梱ライセンス（soundfonts/LICENSE.txt）に基づき再配布しています
      </p>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { BgmComposerPanel } from './bgm-composer.js';
import type { BgmPcmRenderer } from './bgm-audio.js';
import { PCM_PART_LABELS } from '../audio/pcm-arrange.js';
import type { LeadColorSlot, PcmPart, PcmPresetRef, PcmVoiceOverride } from '../audio/pcm-arrange.js';
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
 *
 * 再生音源の決定権は曲側の音源設定(soundChip)が単独で持つ。ここはSoundFontの
 * 調達(選択・遅延ロード)とPCM音色上書きだけを担い、曲がpcmのときだけレンダラを
 * 注入する。SF2関連のコードとフォント本体は、pcmの曲が現れた瞬間にだけロードされる。
 */

const SOURCE_OPTIONS: readonly { id: SoundFontSource; label: string }[] = [
  { id: 'bundled', label: '同梱 GeneralUser GS（GS準拠・再配布可）' },
  { id: 'local', label: 'local/user.sf2（git管理外の私物フォント）' },
  { id: 'picked', label: '保存済みの選択ファイル' },
];

const PCM_PARTS: readonly PcmPart[] = ['lead', 'duet', 'counter', 'ostinato', 'backing', 'bass', 'drums'];
/** 主旋律以外のパート(主旋律は受け渡し色別の3スロットで別枠表示する)。 */
const PCM_FIXED_PARTS: readonly PcmPart[] = PCM_PARTS.filter((part) => part !== 'lead');
const PCM_VOICES_KEY = 'daredemo.pcmVoices.v1';

/** 受け渡し色(leadColor)→UI表示。色の意味はarrangement.tsのLEAD_COLOR_BY_ROLE。 */
const LEAD_SLOTS: readonly { slot: LeadColorSlot; label: string; title: string }[] = [
  { slot: 0, label: '主旋律A・看板', title: 'hook/return/finaleセクションの音色。4・8小節の曲は全区間この色' },
  { slot: 1, label: '主旋律B・展開', title: 'developmentセクションの音色（16小節の後半、40小節のB）' },
  { slot: 2, label: '主旋律C・緩急', title: 'reliefセクションの音色（40小節のCのみ）' },
];

const isPresetRef = (ref: unknown): ref is PcmPresetRef => ref !== null
  && typeof ref === 'object'
  && Number.isInteger((ref as { bank?: unknown }).bank)
  && Number.isInteger((ref as { program?: unknown }).program);

function loadPcmVoices(): PcmVoiceOverride {
  const stored = loadStored<PcmVoiceOverride>(
    PCM_VOICES_KEY,
    {},
    (value): value is PcmVoiceOverride => value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.entries(value as Record<string, unknown>).every(([part, ref]) => (
        part === 'leadColorVoices'
          ? ref !== null && typeof ref === 'object' && !Array.isArray(ref)
            && Object.entries(ref as Record<string, unknown>).every(([slot, item]) => (
              ['0', '1', '2'].includes(slot) && isPresetRef(item)
            ))
          : (PCM_PARTS as readonly string[]).includes(part) && isPresetRef(ref)
      )),
  );
  // 旧形式の「主旋律を全区間1音色で固定」は、色別スロット3つへ展開して引き継ぐ
  // (見える場所に出すことで、受け渡しを殺していた固定を1スロットずつ解除できる)。
  if (stored.lead) {
    const { lead, ...rest } = stored;
    return {
      ...rest,
      leadColorVoices: { 0: lead, 1: lead, 2: lead, ...(stored.leadColorVoices ?? {}) },
    };
  }
  return stored;
}

export function BgmStudio() {
  const playerRef = useRef<SfxPlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new SfxPlayer();
  const [soundOn, setSoundOn] = useState(() => playerRef.current!.enabled);
  /** 曲側の音源設定がpcmかどうか(BgmComposerPanelからの通知)。フォントの遅延ロード条件。 */
  const [pcmNeeded, setPcmNeeded] = useState(false);
  const [fontSource, setFontSource] = useState<SoundFontSource>('bundled');
  const [activeFont, setActiveFont] = useState<ActiveSoundFont | null>(null);
  const [fontStatus, setFontStatus] = useState('');
  const [pcmVoices, setPcmVoices] = useState<PcmVoiceOverride>(loadPcmVoices);

  const savePcmVoices = (next: PcmVoiceOverride) => {
    setPcmVoices(next);
    saveStored(PCM_VOICES_KEY, next);
  };

  const parsePresetRef = (encoded: string): PcmPresetRef => {
    const [bank, program] = encoded.split(':').map(Number);
    return { bank: bank!, program: program! };
  };

  const updatePcmVoice = (part: PcmPart, encoded: string) => {
    const next: PcmVoiceOverride = { ...pcmVoices };
    if (encoded === 'auto') delete next[part];
    else next[part] = parsePresetRef(encoded);
    savePcmVoices(next);
  };

  /** 主旋律の受け渡し色別上書き。「スタイル既定」へ戻すとその色は自動の受け渡しに復帰する。 */
  const updateLeadColorVoice = (slot: LeadColorSlot, encoded: string) => {
    const next: PcmVoiceOverride = { ...pcmVoices };
    const colors = { ...(next.leadColorVoices ?? {}) };
    if (encoded === 'auto') delete colors[slot];
    else colors[slot] = parsePresetRef(encoded);
    if (Object.keys(colors).length === 0) delete next.leadColorVoices;
    else next.leadColorVoices = colors;
    savePcmVoices(next);
  };

  const loadFont = async (source: SoundFontSource) => {
    setFontStatus('SoundFont読み込み中…（同梱フォントは約31MB、初回のみ）');
    try {
      const store = await import('./soundfont-store.js');
      const font = await store.loadSoundFont(source);
      setActiveFont(font);
      setFontStatus(`使用中: ${font.label}${source !== 'bundled' ? '（無い音色は同梱GMで補完）' : ''}`);
    } catch (e) {
      setActiveFont(null);
      setFontStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const selectSource = (source: SoundFontSource) => {
    setFontSource(source);
    setActiveFont(null); // 下のeffectがpcmNeededの間だけ新ソースを読み直す
  };

  const handlePcmNeededChange = useCallback((needed: boolean) => setPcmNeeded(needed), []);

  // 曲側がpcmの間だけフォントを遅延ロードする。失敗時はstateが変わらないので
  // 再試行はソース選択かファイル選択の操作に委ねる(無限リトライしない)。
  useEffect(() => {
    if (pcmNeeded && activeFont === null) void loadFont(fontSource);
    // loadFontはstateセッタのみに依存する安定した処理なので依存配列から除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcmNeeded, fontSource, activeFont]);

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
    if (!activeFont) return null;
    // 選択フォントが同梱GM以外なら、無いプリセットを同梱GeneralUser GSで補完する
    // (ワークステーション時代の「足りない音は隣のモジュール」のWeb版)。
    const complement = fontSource !== 'bundled';
    // キャッシュキー要因はフォント・補完・実効音色。実効音色(曲の焼き込み優先、
    // 無ければグローバル設定)で組むことで、render の音色解決と正確に一致させ、
    // 焼き込み済みの曲のキャッシュをグローバル設定の変更で無駄に割らない。
    return {
      idFor: (options) => `sf2:${activeFont.id}${complement ? '+gu-gs' : ''}:${JSON.stringify(options.pcmVoices ?? pcmVoices)}`,
      render: async (piece, options) => {
        // 曲に焼かれた音色上書き(保存曲の完全再現)が最優先。無い曲はスタジオの
        // グローバル設定で鳴らす(音色を焼く前の旧保存曲の従来挙動)。
        const voices = options.pcmVoices ?? pcmVoices;
        const { renderSf2Bgm } = await import('../audio/pcm-arrange.js');
        if (!complement) return renderSf2Bgm(piece, activeFont.font, voices);
        try {
          const store = await import('./soundfont-store.js');
          const bundled = await store.loadSoundFont('bundled');
          return renderSf2Bgm(piece, [activeFont.font, bundled.font], voices);
        } catch {
          // 補完フォントが取れない(オフライン等)場合は選択フォント単独で劣化継続。
          return renderSf2Bgm(piece, activeFont.font, voices);
        }
      },
    };
  }, [activeFont, fontSource, pcmVoices]);

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
        {pcmNeeded && (
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
      {pcmNeeded && (
        <p className="panel-note">
          {fontStatus}
          {activeFont === null
            ? ' — フォント読み込み完了までチップ音源で鳴ります'
            : ''}
        </p>
      )}
      {pcmNeeded && activeFont && (
        <div className="panel-controls studio-voices">
          {LEAD_SLOTS.map(({ slot, label, title }) => {
            const current = pcmVoices.leadColorVoices?.[slot];
            return (
              <select
                key={`lead-${slot}`}
                value={current ? `${current.bank}:${current.program}` : 'auto'}
                onChange={(e) => updateLeadColorVoice(slot, e.target.value)}
                data-testid={`studio-pcm-voice-lead-${slot}`}
                title={title}
              >
                <option value="auto">{label}: スタイル既定（受け渡し）</option>
                {presetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {label}: {option.label}
                  </option>
                ))}
              </select>
            );
          })}
          {PCM_FIXED_PARTS.map((part) => {
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
      <BgmComposerPanel
        player={playerRef.current!}
        pcmRenderer={pcmRenderer}
        onPcmNeededChange={handlePcmNeededChange}
        pcmVoices={pcmVoices}
      />
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

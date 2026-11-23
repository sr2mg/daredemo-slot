/**
 * SoundFont(PCM 音源)の調達と PCM 音色上書き。
 *
 * 再生音源の決定権は曲側の音源設定(soundChip)が単独で持つ。ここは SoundFont の選択・
 * 遅延ロードと音色上書きだけを担い、曲が pcm のときだけレンダラを注入する。SF2 関連の
 * コードとフォント本体は、pcm の曲が現れた瞬間にだけロードされる。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { BgmPcmRenderer } from '../../audio/render.js';
import type { LeadColorSlot, PcmPart, PcmPresetRef, PcmVoiceOverride } from '../../audio/pcm-arrange.js';
import type { ComposeOptions } from '../../core/music/types.js';
import { loadStored, saveStored } from '../persist.js';
import type { ActiveSoundFont, SoundFontSource } from '../soundfont-store.js';

export const SOURCE_OPTIONS: readonly { id: SoundFontSource; label: string }[] = [
  { id: 'bundled', label: '同梱 GeneralUser GS（GS準拠・再配布可）' },
  { id: 'local', label: 'local/user.sf2（git管理外の私物フォント）' },
  { id: 'picked', label: '保存済みの選択ファイル' },
];

const PCM_PARTS: readonly PcmPart[] = ['lead', 'duet', 'counter', 'ostinato', 'backing', 'bass', 'drums'];
/** 主旋律以外のパート(主旋律は受け渡し色別の3スロットで別枠表示する)。 */
export const PCM_FIXED_PARTS: readonly PcmPart[] = PCM_PARTS.filter((part) => part !== 'lead');
const PCM_VOICES_KEY = 'daredemo.pcmVoices.v1';

/** 受け渡し色(leadColor)→UI表示。色の意味はarrangement.tsのLEAD_COLOR_BY_ROLE。 */
export const LEAD_SLOTS: readonly { slot: LeadColorSlot; label: string; title: string }[] = [
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
    return { ...rest, leadColorVoices: { 0: lead, 1: lead, 2: lead, ...(stored.leadColorVoices ?? {}) } };
  }
  return stored;
}

const parsePresetRef = (encoded: string): PcmPresetRef => {
  const [bank, program] = encoded.split(':').map(Number);
  return { bank: bank!, program: program! };
};

export const encodePresetRef = (ref: PcmPresetRef | undefined): string => (ref ? `${ref.bank}:${ref.program}` : 'auto');

export function useSoundFont() {
  /** 表示中の曲の音源設定が pcm かどうか(ワークスペースからの通知)。フォントの遅延ロード条件。 */
  const [pcmNeeded, setPcmNeeded] = useState(false);
  const [fontSource, setFontSource] = useState<SoundFontSource>('bundled');
  const [activeFont, setActiveFont] = useState<ActiveSoundFont | null>(null);
  const [fontStatus, setFontStatus] = useState('');
  const [pcmVoices, setPcmVoices] = useState<PcmVoiceOverride>(loadPcmVoices);

  const savePcmVoices = (next: PcmVoiceOverride): void => {
    setPcmVoices(next);
    saveStored(PCM_VOICES_KEY, next);
  };

  const updatePcmVoice = (part: PcmPart, encoded: string): void => {
    const next: PcmVoiceOverride = { ...pcmVoices };
    if (encoded === 'auto') delete next[part];
    else next[part] = parsePresetRef(encoded);
    savePcmVoices(next);
  };

  /** 主旋律の受け渡し色別上書き。「スタイル既定」へ戻すとその色は自動の受け渡しに復帰する。 */
  const updateLeadColorVoice = (slot: LeadColorSlot, encoded: string): void => {
    const next: PcmVoiceOverride = { ...pcmVoices };
    const colors = { ...(next.leadColorVoices ?? {}) };
    if (encoded === 'auto') delete colors[slot];
    else colors[slot] = parsePresetRef(encoded);
    if (Object.keys(colors).length === 0) delete next.leadColorVoices;
    else next.leadColorVoices = colors;
    savePcmVoices(next);
  };

  const loadFont = async (source: SoundFontSource): Promise<void> => {
    setFontStatus('SoundFont読み込み中…（同梱フォントは約31MB、初回のみ）');
    try {
      const store = await import('../soundfont-store.js');
      const font = await store.loadSoundFont(source);
      setActiveFont(font);
      setFontStatus(`使用中: ${font.label}${source !== 'bundled' ? '（無い音色は同梱GMで補完）' : ''}`);
    } catch (e) {
      setActiveFont(null);
      setFontStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const selectSource = (source: SoundFontSource): void => {
    setFontSource(source);
    setActiveFont(null); // 下のeffectがpcmNeededの間だけ新ソースを読み直す
  };

  const onPcmNeededChange = useCallback((needed: boolean) => setPcmNeeded(needed), []);

  // 曲側がpcmの間だけフォントを遅延ロードする。失敗時はstateが変わらないので
  // 再試行はソース選択かファイル選択の操作に委ねる(無限リトライしない)。
  useEffect(() => {
    if (pcmNeeded && activeFont === null) void loadFont(fontSource);
    // loadFontはstateセッタのみに依存する安定した処理なので依存配列から除外する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcmNeeded, fontSource, activeFont]);

  const pickFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFontStatus(`${file.name} を読み込み中…`);
    try {
      const store = await import('../soundfont-store.js');
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
    // 実効音色 = 曲に焼かれた上書き(保存曲の完全再現)が最優先、無い曲はスタジオの
    // グローバル設定(音色を焼く前の旧保存曲の従来挙動)。idForとrenderの両方が
    // この唯一の定義を通ることで「キーが同じ⇒波形が同じ」を担保する。
    const voicesFor = (options: ComposeOptions): PcmVoiceOverride => options.pcmVoices ?? pcmVoices;
    // キャッシュキー要因はフォント・補完・実効音色。実効音色で組むことで、焼き込み
    // 済みの曲のキャッシュをグローバル設定の変更で無駄に割らない。試聴用のミュートは
    // 呼び出し側(bgmCacheKey)がキーへ足す。
    return {
      idFor: (options) => `sf2:${activeFont.id}${complement ? '+gu-gs' : ''}:${JSON.stringify(voicesFor(options))}`,
      render: async (piece, options, mix) => {
        const voices = voicesFor(options);
        const { renderSf2Bgm } = await import('../../audio/pcm-arrange.js');
        if (!complement) return renderSf2Bgm(piece, activeFont.font, voices, undefined, mix);
        try {
          const store = await import('../soundfont-store.js');
          const bundled = await store.loadSoundFont('bundled');
          return renderSf2Bgm(piece, [activeFont.font, bundled.font], voices, undefined, mix);
        } catch {
          // 補完フォントが取れない(オフライン等)場合は選択フォント単独で劣化継続。
          // キー(+gu-gs)が表す構成と波形が一致しないため、キャッシュには残させない。
          return { ...await renderSf2Bgm(piece, activeFont.font, voices, undefined, mix), transient: true };
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

  return {
    pcmNeeded, onPcmNeededChange, fontSource, selectSource, pickFile, fontStatus, fontReady: activeFont !== null,
    pcmVoices, updatePcmVoice, updateLeadColorVoice, pcmRenderer, presetOptions,
  };
}

export type SoundFontControls = ReturnType<typeof useSoundFont>;

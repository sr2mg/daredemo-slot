import { describe, expect, it } from 'vitest';
import { compose } from '../src/core/music/compose.js';
import { DEVICE_IDS, resolveDevices } from '../src/core/music/devices.js';
import { normalizeComposeOptions } from '../src/core/music/options.js';
import type { ComposeDraft } from '../src/core/music/options.js';
import { STYLES } from '../src/core/music/theory.js';
import type { StyleDef } from '../src/core/music/theory.js';
import { CURRENT_ENGINE_REV } from '../src/core/music/types.js';

/**
 * 装置の解決規則(devices.ts)が、全装置に同じ一本の規則で効くことを固定する。
 * 連符レイヤーも例外ではなく、様式が既定を宣言でき、UI と compose が同じ解決値を読む。
 */

const styleOf = (id: string): StyleDef => STYLES.find((s) => s.id === id)!;

const ctx = (over: Partial<Parameters<typeof resolveDevices>[0]> = {}) => resolveDevices({
  style: styleOf('eurobeat'),
  melodicLanguage: 'standard',
  grooveFeel: 'straight',
  soundChip: 'opll',
  ...over,
});

describe('装置の解決規則', () => {
  it('明示指定 > 様式既定 > off の順で決まり、出所が分かる', () => {
    const kmmo = ctx({ style: styleOf('kmmo') });
    expect(kmmo.tension).toMatchObject({ value: 'lush', styleDefault: 'lush', source: 'style' });
    const explicit = ctx({ style: styleOf('kmmo'), tensionPolicy: 'soft' });
    expect(explicit.tension).toMatchObject({ value: 'soft', styleDefault: 'lush', source: 'explicit' });
    expect(ctx().tension).toMatchObject({ value: 'off', styleDefault: 'off', source: 'style' });
  });

  it('語法の抑制は全装置へ同時に効き、理由が付く', () => {
    const japanese = ctx({
      melodicLanguage: 'japanese', tensionPolicy: 'lush', tupletOverlay: 7, bassLine: 'on',
    });
    for (const id of DEVICE_IDS) {
      expect(japanese[id].value, id).toBe('off');
      expect(japanese[id].source, id).toBe('unavailable');
      expect(japanese[id].unavailable, id).toContain('和風五音');
    }
  });

  it('音源の能力で畳まれる装置は理由付きで off になる', () => {
    const nes = ctx({
      soundChip: 'nes2a03', tensionPolicy: 'lush', duet: 'on', glide: 'on', tupletOverlay: 5,
    });
    expect(nes.tension.unavailable).toContain('2A03');
    expect(nes.duet.unavailable).toContain('2A03');
    expect(nes.glide.unavailable).toContain('2A03');
    expect(nes.tupletOverlay.unavailable).toContain('2A03');
    // 全音源で鳴る声部の装置は能力ゲートを持たない。
    expect(nes.diminution.unavailable).toBeNull();
    expect(nes.bassLine.unavailable).toBeNull();
  });

  it('連符レイヤーは三連オーバーレイと併用せず、様式既定を宣言できる', () => {
    expect(ctx({ grooveFeel: 'tripletOverlay', tupletOverlay: 7 }).tupletOverlay.unavailable).toContain('三連');
    const declared: StyleDef = { ...styleOf('eurobeat'), devices: { tuplet: 'bySection' } };
    expect(ctx({ style: declared }).tupletOverlay).toMatchObject({ value: 'bySection', source: 'style' });
    expect(ctx({ style: declared, tupletOverlay: 'off' }).tupletOverlay)
      .toMatchObject({ value: 'off', source: 'explicit' });
  });
});

describe('保存JSONの正規化は装置の可用性を同じ規則で判定する', () => {
  const draft: ComposeDraft = {
    progressionId: 'royal-pop', styleId: 'eurobeat', keyRoot: 0, bpm: 170, form: 'loop16' as const, seed: 11,
    choice: [0, 0, 0, 0], soundChip: 'opll', intro: true, tonality: 'major',
    melodicLanguage: 'standard', japaneseScale: 'auto', grooveFeel: 'straight', tupletOverlay: 'auto',
    tensionPolicy: 'auto', diminution: 'auto', duet: 'auto', glide: 'auto', bassLine: 'auto',
    voices: {}, opllUserPatch: 'brightLead', nes: {},
  };

  it('autoは焼かず、明示指定は効く装置だけ焼く', () => {
    const plain = normalizeComposeOptions(draft);
    for (const key of ['tupletOverlay', 'tensionPolicy', 'diminution', 'duet', 'glide', 'bassLine'] as const) {
      expect(plain, key).not.toHaveProperty(key);
    }
    const explicit = normalizeComposeOptions({ ...draft, tupletOverlay: 'off', bassLine: 'on', duet: 'on' });
    expect(explicit).toMatchObject({ tupletOverlay: 'off', bassLine: 'on', duet: 'on' });
    const nes = normalizeComposeOptions({
      ...draft, soundChip: 'nes2a03', tupletOverlay: 7, duet: 'on', bassLine: 'on',
    });
    expect(nes).not.toHaveProperty('tupletOverlay');
    expect(nes).not.toHaveProperty('duet');
    expect(nes).toMatchObject({ bassLine: 'on' });
  });

  it('compose は正規化後の options から同じ実効値で鳴る', () => {
    const hasLine = (bars: readonly { bassDegrees?: readonly (number | null)[] }[]): boolean =>
      bars.some((bar) => bar.bassDegrees !== undefined);
    expect(hasLine(compose(normalizeComposeOptions({ ...draft, bassLine: 'on' })).songPlan.harmony)).toBe(true);
    expect(hasLine(compose(normalizeComposeOptions(draft)).songPlan.harmony)).toBe(false);
  });
});

describe('UIの選択肢はラベル表と一致する', () => {
  it('連符の選択肢はラベル表を網羅し、様式既定を先頭に置く', async () => {
    const { TUPLET_CHOICES } = await import('../src/ui/composer-form.js');
    const { TUPLET_OVERLAY_LABELS } = await import('../src/core/music/types.js');
    expect(TUPLET_CHOICES[0]).toBe('auto');
    expect([...TUPLET_CHOICES].map(String).sort()).toEqual(Object.keys(TUPLET_OVERLAY_LABELS).sort());
  });
});

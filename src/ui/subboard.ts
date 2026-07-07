import { Xoshiro128 } from '../core/rng.js';
import type { Rng } from '../core/rng.js';
import type { EngineState, GameEvent, MachineDef, RoleId } from '../core/types.js';
import type { SfxName } from './opll-core.js';

/**
 * サブ基板演出層（示唆・煽り）。NavLayer（軸 5）と同じ作法で、専用の独立乱数を持ち、
 * GameEvent とエンジン状態の「読み取り」だけで演出を選ぶ。抽選・制御には一切干渉しない。
 * 実機のサブ基板はメインから一方向の信号を受けて演出テーブルを引くだけの存在で、
 * ここもメインの隠し状態（ストック・蓋・モード）を確率的に翻訳して見せる語り部に徹する。
 *
 * サブ基板のタイプは機構（MachineDef）から自動判別する（カスタム機種にもそのまま効く）:
 * - atype:  完全告知 + 第四リール（沖スロの告知 + 演出専用 4th リール搭載機の様式）
 * - at:     ステージ示唆 + カットイン（獣王型 AT 機。高確モードはステージの空気で匂わせる）
 * - battle: 対決連続演出 + 高確率ゾーン表示（吉宗の対決 + SHAKE の「高確率」文字の様式）
 * - sbzone: SB 放出ゾーンの祭り演出（サラ金型 KC）
 */

export type SubboardKind = 'atype' | 'at' | 'battle' | 'sbzone';

export function subboardKind(machine: MachineDef): SubboardKind {
  if (machine.nav) return 'at';
  const lid = machine.carryover.lid;
  if (lid?.modes) return 'battle';
  if (lid && machine.bonuses.some((b) => b.kind === 'sb')) return 'sbzone';
  return 'atype';
}

export interface SubboardView {
  kind: SubboardKind;
  /** 第四リール（atype のみ搭載）。symbol null = 回転中、flash = 点滅（チャンス・告知） */
  fourth: { symbol: string | null; flash: boolean } | null;
  /** ステージ表示（at のみ）。滞在モードの示唆 */
  stage: { id: string; label: string } | null;
  /** ゾーン表示。level 0〜3 = 青→黄→緑→赤（SHAKE の期待度色）、rainbow = 祭り */
  zone: { label: string; level: 0 | 1 | 2 | 3; rainbow?: boolean } | null;
  /** 対決連続演出（battle のみ） */
  battle: { label: string } | null;
  /** 1 回きりのカットイン。key の変化でアニメーションを再生する */
  cutin: { text: string; key: number } | null;
  /** サブ基板都合のランプ点灯（完全告知・放出ゾーン） */
  lamp: boolean;
}

export interface SubboardFx {
  view: SubboardView;
  sfx: readonly SfxName[];
  notes: readonly string[];
}

/** ナビ層の当該ゲームの要約（App が NavLayer から作って渡す。at タイプのみ参照） */
export interface NavInfo {
  atActive: boolean;
  atMode: string | null;
  atStarted: boolean;
  atContinued: boolean;
}

/** AT 機のステージ。並び順 = 高確寄り度（後ろほど高確っぽい） */
const AT_STAGES = [
  { id: 'plain', label: '🌾 草原ステージ' },
  { id: 'dusk', label: '🌇 夕暮れステージ' },
  { id: 'night', label: '🌙 夜ステージ' },
] as const;
const AT_RUSH_STAGE = { id: 'rush', label: '🦁 BEAST RUSH 中' } as const;
/** ステージ振り分け（% 単位）。高確ほど夜寄りだが、どのステージも否定はしない */
const STAGE_WEIGHTS: Record<'low' | 'high', readonly number[]> = {
  low: [70, 25, 5],
  high: [30, 45, 25],
};

const BATTLE_LABEL = '🐒 サル vs 🐉 ドラ 対決中！';

export class Subboard {
  private readonly machine: MachineDef;
  readonly kind: SubboardKind;
  private readonly rng: Rng;
  private cutinSeq = 0;

  private fourthSymbol: string | null = 'blank';
  private fourthFlash = false;
  /** atype の告知管理。notice = 潜伏中（残り announceIn G で告知）、announced = 告知済み */
  private atypeNotice: { announceIn: number } | null = null;
  private atypeAnnounced = false;
  private lamp = false;
  private stageIndex = 0;
  private atRush = false;
  private zone: SubboardView['zone'] = null;
  private battle: { roundsLeft: number } | null = null;
  /** ガセ高確率表示の残りゲーム数（battle タイプ） */
  private fakeZoneLeft = 0;
  private sbZoneActive = false;
  private cutin: SubboardView['cutin'] = null;

  constructor(machine: MachineDef, seed: number) {
    this.machine = machine;
    this.kind = subboardKind(machine);
    this.rng = new Xoshiro128(seed);
    if (this.kind === 'at') this.stageIndex = this.pickStage(false);
  }

  snapshot(): SubboardView {
    return {
      kind: this.kind,
      fourth: this.kind === 'atype' ? { symbol: this.fourthSymbol, flash: this.fourthFlash } : null,
      stage: this.kind === 'at' ? (this.atRush ? AT_RUSH_STAGE : AT_STAGES[this.stageIndex]!) : null,
      zone: this.zone,
      battle: this.battle === null ? null : { label: BATTLE_LABEL },
      cutin: this.cutin,
      lamp: this.lamp,
    };
  }

  /** レバー ON。第四リールの始動と、成立フラグを受けたカットイン抽選 */
  onLever(flags: readonly RoleId[]): SubboardFx {
    this.cutin = null;
    if (this.kind === 'atype') {
      this.fourthSymbol = null;
      this.fourthFlash = false;
    }
    if (this.kind === 'at') this.rollAtCutin(flags);
    return { view: this.snapshot(), sfx: [], notes: [] };
  }

  /** 教材モードの強制 AT 突入をサブ基板にも見せる（RUSH ステージ + 突入カットイン） */
  onForcedAt(): SubboardFx {
    if (this.kind === 'at') {
      this.atRush = true;
      this.setCutin('🦁 BEAST RUSH 突入！！');
    }
    return { view: this.snapshot(), sfx: [], notes: [] };
  }

  /** 全リール停止後。GameEvent と更新後のエンジン状態から演出を確定させる */
  onSettle(event: GameEvent, engine: EngineState, nav: NavInfo | null): SubboardFx {
    this.cutin = null; // レバー時のカットインは全停止で役目を終える
    const sfx: SfxName[] = [];
    const notes: string[] = [];
    switch (this.kind) {
      case 'atype':
        this.settleAtype(event, engine, sfx, notes);
        break;
      case 'at':
        this.settleAt(nav);
        break;
      case 'battle':
        this.settleBattle(event, engine, notes);
        break;
      case 'sbzone':
        this.settleSbZone(event, engine, notes);
        break;
    }
    return { view: this.snapshot(), sfx, notes };
  }

  // ===== atype: 完全告知 + 第四リール =====

  /**
   * 第四リールの文法（読み解くゲーム性）:
   * - 図柄は嘘をつかない: 通常時は必ず成立役の対応図柄（ハズレはブランク）で止まる
   * - 点滅 = チャンス: レア役やボーナス潜伏で点滅しやすいが、ガセもある
   * - 矛盾 = 確定: 成立役と違う図柄が止まったらボーナス潜伏が確定（通常時は絶対に出ない）
   * - ボーナス図柄（7/BAR）= 告知: 成立ゲームで告知タイミングを抽選し（即〜4G 潜伏）、
   *   告知でキュイン + ランプ。潜伏中に矛盾や点滅から察知して先に揃えるのは自由（実機の楽しみ方）
   */
  private settleAtype(event: GameEvent, engine: EngineState, sfx: SfxName[], notes: string[]): void {
    const pending = engine.queue.find((id) => this.bonusKind(id) !== 'sb');
    if (pending === undefined) {
      // 通常時。告知状態をリセットし、図柄は正直に。点滅だけが夢（ガセ）を見せる
      this.atypeNotice = null;
      this.atypeAnnounced = false;
      this.lamp = false;
      const honest = this.symbolForFlags(event.flags);
      const rare = this.hasRareSmall(event.flags);
      this.fourthSymbol = honest;
      this.fourthFlash = this.chance(rare ? 0.25 : honest === 'blank' ? 1 / 64 : 1 / 48);
      return;
    }

    // 成立ゲーム: 告知タイミング抽選（即 40% / 1G 25% / 2G 20% / 3G 10% / 4G 5%）
    if (event.queuedBonus !== null && this.bonusKind(event.queuedBonus) !== 'sb') {
      const roll = this.rng.draw16() % 100;
      const delay = roll < 40 ? 0 : roll < 65 ? 1 : roll < 85 ? 2 : roll < 95 ? 3 : 4;
      this.atypeNotice = { announceIn: delay };
      this.atypeAnnounced = false;
    }
    // 成立ゲームを観測できなかった場合（機種切替直後など）は即告知にフォールバック
    if (this.atypeNotice === null) this.atypeNotice = { announceIn: 0 };

    if (!this.atypeAnnounced) {
      if (this.atypeNotice.announceIn <= 0) {
        this.atypeAnnounced = true;
        sfx.push('kyuin');
        notes.push('⚡ 完全告知！');
      } else {
        this.atypeNotice.announceIn -= 1;
      }
    }

    if (this.atypeAnnounced) {
      // 告知済み: 揃えるまでボーナス図柄が点滅し続ける
      this.fourthSymbol = this.symbolOfRole(pending);
      this.fourthFlash = true;
      this.lamp = true;
    } else {
      // 潜伏中: 正直 50% / 点滅チャンス 30% / 矛盾（確定パターン）20%。ランプはまだ点けない
      const honest = this.symbolForFlags(event.flags);
      const roll = this.rng.draw16() % 100;
      this.fourthSymbol = roll < 80 ? honest : this.contradictionOf(honest);
      this.fourthFlash = roll >= 50 && roll < 80;
      this.lamp = false;
    }
  }

  /** 成立フラグにレア役（目押し必須の小役）が含まれるか */
  private hasRareSmall(flags: readonly RoleId[]): boolean {
    return flags.some((id) => {
      const role = this.machine.roles.find((r) => r.id === id);
      return role !== undefined && role.kind === 'small' && role.pullIn !== 'guaranteed';
    });
  }

  /** 矛盾図柄: 成立役対応と違う小役/リプレイ図柄（ボーナス図柄は告知専用なので使わない） */
  private contradictionOf(honest: string): string {
    const candidates = [
      ...new Set(
        this.machine.roles
          .filter((r) => r.kind === 'small' || r.kind === 'replay')
          .map((r) => this.symbolOfRole(r.id)),
      ),
    ].filter((s) => s !== honest && s !== 'blank');
    if (candidates.length === 0) return honest;
    return candidates[this.rng.draw16() % candidates.length]!;
  }

  /** 成立フラグの対応図柄（レア役 > 通常小役 > リプレイ > ブランク） */
  private symbolForFlags(flags: readonly RoleId[]): string {
    const roles = flags
      .map((id) => this.machine.roles.find((r) => r.id === id))
      .filter((r) => r !== undefined);
    const rare = roles
      .filter((r) => r.kind === 'small' && r.pullIn !== 'guaranteed')
      .sort((a, b) => b.payout - a.payout)[0];
    const pick = rare ?? roles.find((r) => r.kind === 'small') ?? roles.find((r) => r.kind === 'replay');
    return pick ? this.symbolOfRole(pick.id) : 'blank';
  }

  // ===== at: ステージ示唆 + カットイン =====

  private rollAtCutin(flags: readonly RoleId[]): void {
    const hasBonus = flags.some((id) => {
      const kind = this.bonusKind(id);
      return kind !== undefined && kind !== 'sb';
    });
    const rare = flags
      .map((id) => this.machine.roles.find((r) => r.id === id))
      .filter((r) => r !== undefined)
      .filter((r) => r.kind === 'small' && r.pullIn !== 'guaranteed');
    const strong = rare.some((r) => r.payout >= 10);
    if (hasBonus && this.chance(0.6)) this.setCutin('🦁 ガオオオッ！！');
    else if (strong && this.chance(0.5)) this.setCutin('🦁 ガオオオッ！！');
    else if (rare.length > 0 && this.chance(0.3)) this.setCutin('🐾 茂みが揺れている…');
    else if (this.chance(1 / 64)) this.setCutin('🌿 風が吹いた'); // ガセ（弱）
  }

  private settleAt(nav: NavInfo | null): void {
    this.atRush = nav?.atActive ?? false;
    if (nav?.atStarted) this.setCutin('🦁 BEAST RUSH 突入！！');
    else if (nav?.atContinued) this.setCutin('🐘 群れが来た！継続！！');
    if (!this.atRush && this.chance(0.2)) {
      // ステージは慣性を持って揺れる。高確モードほど夜寄り（体感でしか分からない示唆）
      const initial = this.machine.nav?.modes?.initial ?? null;
      const high = nav !== null && nav.atMode !== null && nav.atMode !== initial;
      this.stageIndex = this.pickStage(high);
    }
  }

  private pickStage(high: boolean): number {
    const weights = STAGE_WEIGHTS[high ? 'high' : 'low'];
    let roll = this.rng.draw16() % 100;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return 0;
  }

  // ===== battle: 対決連続演出 + 高確率ゾーン =====

  /**
   * 「高確率」の実体は残り放出 G 数（SHAKE 式）。放出 3G 前から対決連続演出が始まり、
   * 蓋が開いたら勝利。ストックが無い・深いときも低確率でガセ高確率とガセ対決を出す。
   */
  private settleBattle(event: GameEvent, engine: EngineState, notes: string[]): void {
    if (engine.base.type === 'bonus') {
      // ボーナス消化中は通常時演出をすべて畳む
      this.zone = null;
      this.battle = null;
      this.fakeZoneLeft = 0;
      return;
    }
    const releaseIn = engine.lid ? engine.lidReleaseIn : null;
    const pending = engine.queue.some((id) => this.bonusKind(id) !== 'sb');

    // 高確率ゾーン表示（青→黄→緑→赤）
    if (releaseIn !== null && releaseIn <= 30) {
      const level = releaseIn <= 5 ? 3 : releaseIn <= 12 ? 2 : releaseIn <= 20 ? 1 : 0;
      this.zone = { label: '高確率', level };
      this.fakeZoneLeft = 0;
    } else if (!engine.lid && pending) {
      this.zone = { label: '🔥 放出中！ボーナスを狙え！', level: 3 };
    } else if (this.fakeZoneLeft > 0) {
      this.fakeZoneLeft -= 1;
      this.zone = { label: '高確率', level: 0 };
    } else if (this.chance(1 / 64)) {
      this.fakeZoneLeft = 2 + (this.rng.draw16() % 3); // ガセ高確率 2〜4G
      this.zone = { label: '高確率', level: 0 };
    } else {
      this.zone = null;
    }

    // 対決連続演出
    if (this.battle !== null) {
      if (event.lidReleased || event.bonusStarted !== null) {
        this.battle = null;
        this.setCutin('⚔ 撃破！！');
        notes.push('⚔ 対決勝利！');
      } else {
        this.battle.roundsLeft -= 1;
        if (this.battle.roundsLeft <= 0) {
          this.battle = null;
          this.setCutin('💥 敗北…');
        }
      }
    } else if (releaseIn === 3) {
      this.battle = { roundsLeft: 3 }; // 本物: 放出にぴったり重なる
    } else if ((releaseIn === null || releaseIn > 30) && !pending && this.chance(1 / 48)) {
      this.battle = { roundsLeft: 2 }; // ガセ
    }

    // 天国示唆（モードが初期値以外のときだけ稀に漏れる）
    const initial = this.machine.carryover.lid?.modes?.initial ?? null;
    if (engine.mode !== null && engine.mode !== initial && this.chance(1 / 16)) {
      notes.push('🌈 …何かが変わった気がする');
    }
  }

  // ===== sbzone: SB 放出ゾーンの祭り =====

  private settleSbZone(event: GameEvent, engine: EngineState, notes: string[]): void {
    // 「このゲームで SB が放出された」も祭りに含める（最後の 1 個を放出したゲームで
    // キューが空になっていても、そのゲーム自体はゾーンの一部）
    const sbNow =
      (event.bonusStarted !== null && this.bonusKind(event.bonusStarted) === 'sb') ||
      event.wins.some((id) => this.bonusKind(id) === 'sb');
    const active = !engine.lid && (engine.queue.some((id) => this.bonusKind(id) === 'sb') || sbNow);
    this.zone = active ? { label: '💰 SB 放出ゾーン', level: 3, rainbow: true } : null;
    this.lamp = active;
    if (active && !this.sbZoneActive) this.setCutin('💰 放出ゾーン突入！！');
    if (!active && this.sbZoneActive) notes.push('💤 放出ゾーン終了');
    // ストックが溜まっているときの前兆（サブ基板だけが知っている唸り）
    if (!active && engine.lid && engine.queue.length >= 10 && this.chance(1 / 32)) {
      this.setCutin('⚡ 台の奥で何かが唸っている…');
    }
    this.sbZoneActive = active;
  }

  // ===== 共通ヘルパ =====

  private bonusKind(id: RoleId): 'bb' | 'rb' | 'sb' | undefined {
    return this.machine.bonuses.find((b) => b.id === id)?.kind;
  }

  /** 役の代表図柄（pattern の最初の非 any） */
  private symbolOfRole(id: RoleId): string {
    const role = this.machine.roles.find((r) => r.id === id);
    return role?.pattern.find((s) => s !== 'any') ?? 'blank';
  }

  private setCutin(text: string): void {
    this.cutinSeq += 1;
    this.cutin = { text, key: this.cutinSeq };
  }

  private chance(prob: number): boolean {
    return this.rng.draw16() < Math.floor(prob * 65536);
  }
}

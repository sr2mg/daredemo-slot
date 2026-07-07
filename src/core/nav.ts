import type { Rng, RngState } from './rng.js';
import { Xoshiro128 } from './rng.js';
import type { AtTrigger, GameEvent, MachineDef, RoleId } from './types.js';

/**
 * ナビ層（サブ基板相当。docs/design/01 軸 5）。
 * - コアの GameEvent を購読して AT 状態機械を回す（抽選はナビ層専用の独立乱数）
 * - できることは「成立フラグの購読」と「正解の開示」だけで、メインの抽選・制御には一切干渉しない
 * - AT の抽選契機・継続管理・上乗せは machine.nav.at の定義に従う
 * - 高確/低確モード（machine.nav.modes）はサブ基板の内部状態で、モードごとに
 *   AT 抽選契機を差し替える（メイン基板の規制外だった 4号機 AT 機の高確モードの再現）
 */

export interface NavState {
  at: { remainingGames: number } | null;
  /** AT 非当選が続いたゲーム数（gamesCeiling 用） */
  sinceAt: number;
  /** 現在のサブ基板モード（modes 未定義なら null） */
  mode: string | null;
  rng: RngState;
}

export interface NavDisplay {
  roleId: RoleId;
  group: string;
  /** 正解の第 1 停止リール */
  correctFirst: number;
}

export class NavLayer {
  private readonly machine: MachineDef;
  private readonly rng: Rng;
  private at: { remainingGames: number } | null;
  private sinceAt: number;
  private mode: string | null;

  constructor(machine: MachineDef, seed: number | NavState) {
    this.machine = machine;
    if (typeof seed === 'number') {
      this.rng = new Xoshiro128(seed);
      this.at = null;
      this.sinceAt = 0;
      this.mode = machine.nav?.modes?.initial ?? null;
    } else {
      this.rng = new Xoshiro128(seed.rng);
      this.at = seed.at === null ? null : { ...seed.at };
      this.sinceAt = seed.sinceAt;
      this.mode = seed.mode;
    }
  }

  get atActive(): boolean {
    return this.at !== null;
  }

  get atRemainingGames(): number | null {
    return this.at?.remainingGames ?? null;
  }

  /** 現在のサブ基板モード（教材モードの覗き見用。実機ではプレイヤーに見えない） */
  get atMode(): string | null {
    return this.mode;
  }

  getState(): NavState {
    return {
      at: this.at === null ? null : { ...this.at },
      sinceAt: this.sinceAt,
      mode: this.mode,
      rng: this.rng.getState(),
    };
  }

  /**
   * 教材モード: AT を抽選を経ずに強制作動させる。
   * nav 未定義・作動中は false（通常の抽選経路には一切影響しない）
   */
  forceAt(): boolean {
    const at = this.machine.nav?.at;
    if (!at || this.at !== null) return false;
    const games = at.management.type === 'set' ? at.management.gamesPerSet : at.management.games;
    this.at = { remainingGames: games };
    this.sinceAt = 0;
    return true;
  }

  /** 現在のモードで有効な AT 抽選契機（モードが triggers を持たなければ既定を使う） */
  private currentTriggers(): readonly AtTrigger[] {
    const at = this.machine.nav!.at;
    const modeDef = this.machine.nav?.modes?.states.find((m) => m.id === this.mode);
    return modeDef?.triggers ?? at.triggers;
  }

  /** モード移行抽選（roleHit / pureMiss / atEnd 契機） */
  private applyTransitions(event: Pick<GameEvent, 'flags'>, atEnded: boolean): void {
    const modes = this.machine.nav?.modes;
    if (!modes || this.mode === null) return;
    const modeDef = modes.states.find((m) => m.id === this.mode);
    for (const t of modeDef?.transitions ?? []) {
      const applicable =
        (t.on === 'roleHit' && event.flags.includes(t.of)) ||
        (t.on === 'pureMiss' && event.flags.length === 0) ||
        (t.on === 'atEnd' && atEnded);
      if (applicable && this.draw(t.prob)) {
        this.mode = t.to;
        return; // 1 ゲームに 1 回まで
      }
    }
  }

  /**
   * レバー ON 後、当該ゲームの成立フラグからナビ表示を決める（AT 中のみ）。
   * メインから受け取った情報の開示であり、抽選には関与しない。
   */
  navFor(flags: readonly RoleId[]): NavDisplay | null {
    const at = this.machine.nav?.at;
    if (!at || this.at === null) return null;
    for (const id of flags) {
      const nav = this.machine.roles.find((r) => r.id === id)?.nav;
      if (nav && at.navTargets.includes(nav.group)) {
        return { roleId: id, group: nav.group, correctFirst: nav.correctFirst };
      }
    }
    return null;
  }

  /** ゲーム終了時に GameEvent を購読して AT 状態を更新する。表示用のメッセージ列を返す */
  onEvent(event: GameEvent): string[] {
    const at = this.machine.nav?.at;
    if (!at) return [];
    const notes: string[] = [];
    let atEnded = false;

    if (this.at !== null) {
      for (const addOn of at.addOn ?? []) {
        if (event.flags.includes(addOn.of)) {
          this.at.remainingGames += addOn.addGames;
          notes.push(`⏫ AT +${addOn.addGames}G`);
        }
      }
      this.at.remainingGames -= 1;
      if (this.at.remainingGames <= 0) {
        if (at.management.type === 'set' && this.draw(at.management.continueProb)) {
          this.at.remainingGames = at.management.gamesPerSet;
          notes.push('🔥 AT 継続！');
        } else {
          this.at = null;
          atEnded = true;
          notes.push('AT 終了');
        }
      }
    } else {
      this.sinceAt += 1;
      let won = false;
      for (const trigger of this.currentTriggers()) {
        if (trigger.on === 'roleHit' && event.flags.includes(trigger.of) && this.draw(trigger.prob)) won = true;
        else if (trigger.on === 'pureMiss' && event.flags.length === 0 && this.draw(trigger.prob)) won = true;
        else if (trigger.on === 'gamesCeiling' && this.sinceAt >= trigger.n) won = true;
      }
      if (won) {
        const games = at.management.type === 'set' ? at.management.gamesPerSet : at.management.games;
        this.at = { remainingGames: games };
        this.sinceAt = 0;
        notes.push('🎉 AT 突入！');
      }
    }

    // モード移行はゲームの最後に評価（当該ゲームの AT 抽選は移行前のモードで行われる）
    this.applyTransitions(event, atEnded);
    return notes;
  }

  private draw(prob: number): boolean {
    return this.rng.draw16() < Math.floor(prob * 65536);
  }
}

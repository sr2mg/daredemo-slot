import { ControlContext } from './control.js';
import { winsAt } from './judge.js';
import type { MachineDef, PullIn, RoleId, StopEvent } from './types.js';

/**
 * リール配列の総当たり検証（docs/design/04-reel-layout.md「検証」/ 05 の保存時パイプライン 3）。
 * リール制御エンジンをオラクルとして、順押し・全押下位置で:
 * - 蹴飛ばし違反（非成立役の入賞）がゼロであること
 * - 成立リプレイの取りこぼしがゼロであること
 * - 各役の実測引き込み率が宣言（PB=1 / 目標率）に合っていること
 * を確認する。
 */

export interface RoleCheck {
  id: RoleId;
  declared: PullIn;
  /** 単独成立時・順押し全押下位置での入賞率 */
  measured: number;
  ok: boolean;
}

export interface LayoutReport {
  /** 非成立役が入賞したケース数（0 以外は配列不正） */
  kickViolations: number;
  /** 成立リプレイを取りこぼしたケース数（0 以外は配列不正） */
  replayMisses: number;
  roleChecks: RoleCheck[];
  casesChecked: number;
  ok: boolean;
}

/** missable の実測が目標から外れてよい許容誤差（表示上の警告閾値） */
const MISSABLE_TOLERANCE = 0.15;

export function checkLayout(machine: MachineDef): LayoutReport {
  if (machine.strips.length !== 3) throw new Error('checkLayout supports 3-reel machines only');
  const frames = machine.frames;
  const replayIds = new Set(machine.roles.filter((r) => r.kind === 'replay').map((r) => r.id));

  // 検査するフラグ状態: ハズレ + 各役単独 + 抽選テーブル上の複合エントリ
  const flagSets = new Map<string, readonly RoleId[]>();
  flagSets.set('', []);
  for (const role of machine.roles) flagSets.set(role.id, [role.id]);
  for (const entry of machine.lottery.base) {
    flagSets.set([...entry.roles].sort().join(','), entry.roles);
  }

  let kickViolations = 0;
  let replayMisses = 0;
  let casesChecked = 0;
  const singleWinCount = new Map<RoleId, number>();

  for (const active of flagSets.values()) {
    const activeSet = new Set(active);
    const ctx = new ControlContext(machine, activeSet);
    const single = active.length === 1 ? active[0]! : null;
    const hasReplay = active.some((id) => replayIds.has(id));

    for (let p0 = 0; p0 < frames; p0++) {
      for (let p1 = 0; p1 < frames; p1++) {
        for (let p2 = 0; p2 < frames; p2++) {
          const history: StopEvent[] = [];
          for (const [reel, push] of [[0, p0], [1, p1], [2, p2]] as const) {
            const slip = ctx.resolveStop(history, reel, push);
            history.push({ reel, pushPosition: push, stopPosition: (push + slip) % frames });
          }
          const stops = [history[0]!.stopPosition, history[1]!.stopPosition, history[2]!.stopPosition];
          const wins = winsAt(machine, stops);
          casesChecked++;
          for (const win of wins) if (!activeSet.has(win)) kickViolations++;
          if (hasReplay && !wins.some((w) => replayIds.has(w))) replayMisses++;
          if (single !== null && wins.includes(single)) {
            singleWinCount.set(single, (singleWinCount.get(single) ?? 0) + 1);
          }
        }
      }
    }
  }

  const totalPerSet = frames ** 3;
  const roleChecks: RoleCheck[] = machine.roles.map((role) => {
    const measured = (singleWinCount.get(role.id) ?? 0) / totalPerSet;
    const ok =
      role.pullIn === 'guaranteed'
        ? measured === 1
        : Math.abs(measured - role.pullIn.missable.targetRate) <= MISSABLE_TOLERANCE;
    return { id: role.id, declared: role.pullIn, measured, ok };
  });

  return {
    kickViolations,
    replayMisses,
    roleChecks,
    casesChecked,
    ok: kickViolations === 0 && replayMisses === 0 && roleChecks.every((c) => c.ok),
  };
}

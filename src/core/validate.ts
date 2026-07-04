import { ControlContext } from './control.js';
import { patternKey, winsAt } from './judge.js';
import type { MachineDef, PullIn, RoleId, StopEvent, SymbolId } from './types.js';

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

/** 違反の具体例（どのフラグ状態のどの停止位置で何が壊れたか） */
export interface LayoutViolation {
  kind: 'kick' | 'replayMiss';
  /** 検査時の成立フラグ（空 = ハズレ） */
  flags: readonly RoleId[];
  /** 各リールの停止位置（上段コマ番号） */
  stops: readonly number[];
  /** kick のとき: 勝手に入賞してしまった役 */
  wonRole?: RoleId;
}

export interface LayoutReport {
  /** 非成立役が入賞したケース数（0 以外は配列不正） */
  kickViolations: number;
  /** 成立リプレイを取りこぼしたケース数（0 以外は配列不正） */
  replayMisses: number;
  roleChecks: RoleCheck[];
  casesChecked: number;
  ok: boolean;
  /** 違反の具体例（先頭数件。修正の手がかり用） */
  violationExamples: LayoutViolation[];
  /** 蹴飛ばし違反の役別件数（どの役が勝手に揃うか） */
  kickByRole: Record<RoleId, number>;
}

/** PB=1（引き込み保証）に必要な最大間隔。滑りは押下位置 +0〜4 コマの 5 コマ窓 */
export const PB1_MAX_GAP = 5;

export interface SpacingCheck {
  roleId: RoleId;
  reel: number;
  symbol: SymbolId;
  /** リール上の個数 */
  count: number;
  /** 循環間隔の最大値（この値が PB1_MAX_GAP 以下なら常に引き込める） */
  maxGap: number;
  ok: boolean;
}

/**
 * PB=1 役の配置間隔プリチェック（総当たりの前の軽量診断）。
 * guaranteed 宣言の役について、各リールの要求図柄が「どこを押しても 5 コマ以内」
 * に必ずあるか（= 最大循環間隔 ≤ 5）を検査し、どのリールのどの図柄が
 * 足りないかを具体的に返す。
 */
export function checkSpacing(machine: MachineDef): SpacingCheck[] {
  const results: SpacingCheck[] = [];
  const frames = machine.frames;
  for (const role of machine.roles) {
    if (role.pullIn !== 'guaranteed') continue;
    for (let reel = 0; reel < machine.strips.length; reel++) {
      const symbol = role.pattern[reel];
      if (symbol === undefined || symbol === 'any') continue;
      const positions: number[] = [];
      machine.strips[reel]!.forEach((s, i) => {
        if (s === symbol) positions.push(i);
      });
      let maxGap = Infinity;
      if (positions.length > 0) {
        maxGap = 0;
        for (let i = 0; i < positions.length; i++) {
          const next = positions[(i + 1) % positions.length]!;
          const gap = (next - positions[i]! + frames) % frames || frames;
          if (gap > maxGap) maxGap = gap;
        }
      }
      results.push({
        roleId: role.id,
        reel,
        symbol,
        count: positions.length,
        maxGap,
        ok: maxGap <= PB1_MAX_GAP,
      });
    }
  }
  return results;
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
  for (const overrides of Object.values(machine.lottery.settingOverrides ?? {})) {
    for (const entry of overrides) {
      flagSets.set([...entry.roles].sort().join(','), entry.roles);
    }
  }

  let kickViolations = 0;
  let replayMisses = 0;
  let casesChecked = 0;
  const singleWinCount = new Map<RoleId, number>();
  const violationExamples: LayoutViolation[] = [];
  const kickByRole: Record<RoleId, number> = {};
  const MAX_EXAMPLES = 8;

  const rolesById = new Map(machine.roles.map((r) => [r.id, r]));

  for (const active of flagSets.values()) {
    const activeSet = new Set(active);
    // 蹴飛ばし判定は図柄組み合わせ単位（同一 pattern の別フラグは合法。docs/design/03）
    const activePatterns = new Set(active.map((id) => patternKey(rolesById.get(id)!)));
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
          for (const win of wins) {
            if (!activePatterns.has(patternKey(rolesById.get(win)!))) {
              kickViolations++;
              kickByRole[win] = (kickByRole[win] ?? 0) + 1;
              if (violationExamples.length < MAX_EXAMPLES) {
                violationExamples.push({ kind: 'kick', flags: active, stops, wonRole: win });
              }
            }
          }
          if (hasReplay && !wins.some((w) => replayIds.has(w))) {
            replayMisses++;
            if (violationExamples.length < MAX_EXAMPLES) {
              violationExamples.push({ kind: 'replayMiss', flags: active, stops });
            }
          }
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
    violationExamples,
    kickByRole,
  };
}

/**
 * 機種定義の構造バリデーション（docs/design/05 保存時パイプライン 1・2）。
 * errors = 保存不可、warnings = 動くが意図を確認すべき構成。
 * 型は unknown 入力（エディタの JSON パース結果）を想定し、防御的にチェックする。
 */
export function validateMachine(def: MachineDef): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (msg: string) => errors.push(msg);
  const warn = (msg: string) => warnings.push(msg);

  if (!def.name) err('name がありません');
  if (!Number.isInteger(def.frames) || def.frames < 5) err('frames は 5 以上の整数が必要です');
  if (Number.isInteger(def.frames) && def.frames > 30) warn('frames が 30 を超えています（実機は 20〜21 コマです）');
  if (!Array.isArray(def.strips) || def.strips.length !== 3) err('strips は 3 リール分の配列が必要です');
  if (!Number.isInteger(def.bet) || def.bet < 1 || def.bet > 3) {
    err('bet は 1〜3 が必要です（パチスロの最大投入枚数は 3 枚です）');
  }
  for (const [li, line] of (def.lines ?? []).entries()) {
    if (line.length !== (def.strips?.length ?? 3)) err(`有効ライン${li} の長さがリール数と一致しません`);
    if (line.some((row) => !Number.isInteger(row) || row < 0 || row > 2)) {
      err(`有効ライン${li} の行番号が範囲外です（0=上段, 1=中段, 2=下段）`);
    }
  }

  const symbolSet = new Set((def.strips ?? []).flat());
  for (const [i, strip] of (def.strips ?? []).entries()) {
    if (strip.length !== def.frames) err(`リール${i} のコマ数が frames と一致しません`);
  }

  const roleIds = new Set<string>();
  const navGroupIds = new Set((def.navGroups ?? []).map((g) => g.id));
  for (const role of def.roles ?? []) {
    if (roleIds.has(role.id)) err(`役 ID が重複: ${role.id}`);
    roleIds.add(role.id);
    if (role.pattern.length !== def.strips.length) err(`役 ${role.id} の pattern 長がリール数と不一致`);
    for (const sym of role.pattern) {
      if (sym !== 'any' && !symbolSet.has(sym)) warn(`役 ${role.id} の図柄 ${sym} はどのリールにも無く、揃うことがありません`);
    }
    if (role.payout < 0) err(`役 ${role.id} の payout が負`);
    if (role.payout > 15) {
      err(`役 ${role.id} の payout が ${role.payout} 枚です（パチスロの 1 回の払い出し上限は 15 枚。15 以下にしてください）`);
    }
    if (role.kind === 'replay' && role.payout !== 0) err(`リプレイ役 ${role.id} の payout は 0 にしてください（再遊技は払い出しなし）`);
    const nav = role.nav;
    if (nav) {
      if (!navGroupIds.has(nav.group)) err(`役 ${role.id} の navGroup が未定義: ${nav.group}`);
      if (nav.correctFirst < 0 || nav.correctFirst >= def.strips.length) {
        err(`役 ${role.id} の correctFirst がリール範囲外`);
      }
      if (nav.onMiss.type === 'reduced') {
        const ref = nav.onMiss.roleRef;
        if (!(def.roles ?? []).some((r) => r.id === ref)) err(`役 ${role.id} の onMiss.roleRef が未定義: ${ref}`);
        if (role.kind === 'replay') {
          const refRole = (def.roles ?? []).find((r) => r.id === ref);
          if (refRole && refRole.kind !== 'replay') err(`リプレイ役 ${role.id} の onMiss 参照先はリプレイである必要があります`);
        }
      } else if (role.kind === 'replay') {
        err(`リプレイ役 ${role.id} の onMiss に lose は使えません（docs/design/03 優先度 2）`);
      }
    }
  }

  const bonusIds = new Set<string>();
  for (const bonus of def.bonuses ?? []) {
    bonusIds.add(bonus.id);
    if (!roleIds.has(bonus.id)) err(`ボーナス ${bonus.id} に対応する役がありません`);
    if (!def.tables?.[bonus.tableRef]) err(`ボーナス ${bonus.id} の tableRef が未定義: ${bonus.tableRef}`);
  }

  // CT（チャレンジタイム）
  const ctIds = new Set<string>();
  for (const ct of def.ct ?? []) {
    if (ctIds.has(ct.id)) err(`CT の id が重複: ${ct.id}`);
    ctIds.add(ct.id);
    if (ct.freeRoles.length === 0) err(`CT ${ct.id}: freeRoles が空です（CT 中に取れる役を指定してください）`);
    for (const id of ct.freeRoles) {
      if (!roleIds.has(id)) err(`CT ${ct.id} の freeRoles に未定義の役: ${id}`);
      if (bonusIds.has(id)) err(`CT ${ct.id} の freeRoles にボーナス役 ${id} は指定できません`);
    }
    for (const id of ct.end.punkRoles ?? []) {
      if (!roleIds.has(id)) err(`CT ${ct.id} の punkRoles に未定義の役: ${id}`);
    }
    for (const t of ct.entry) {
      if ((t.on === 'roleHit' || t.on === 'bonusEnd' || t.on === 'bonusFlag') && t.of !== undefined && !roleIds.has(t.of)) {
        err(`CT ${ct.id} の entry に未定義の役: ${t.of}`);
      }
    }
    if (ct.end.games === undefined && ct.end.maxPayout === undefined && (ct.end.punkRoles?.length ?? 0) === 0) {
      err(`CT ${ct.id}: 終了条件がありません（games / maxPayout / punkRoles のいずれかが必要）`);
    }
  }

  const checkTable = (label: string, table: readonly { roles: readonly string[]; weight: number }[]) => {
    let total = 0;
    for (const entry of table) {
      total += entry.weight;
      if (entry.weight < 0) err(`${label}: 負の重みがあります`);
      for (const id of entry.roles) if (!roleIds.has(id)) err(`${label}: 未定義の役 ${id}`);
      if (entry.roles.filter((id) => bonusIds.has(id)).length > 1) err(`${label}: 1 エントリに複数ボーナス`);
    }
    if (total > 65536) {
      err(`${label}: 重み合計が 65536 を超えています (${total}) → 合計で ${total - 65536} ぶん重みを減らしてください`);
    }
  };
  checkTable('lottery.base', def.lottery?.base ?? []);
  for (const [key, table] of Object.entries(def.tables ?? {})) checkTable(`tables.${key}`, table);

  const settings = def.lottery?.settings ?? 1;
  if (!Number.isInteger(settings) || settings < 1 || settings > 6) err('lottery.settings は 1〜6 が必要です');
  for (const [settingKey, overrides] of Object.entries(def.lottery?.settingOverrides ?? {})) {
    const n = Number(settingKey);
    if (!Number.isInteger(n) || n < 2 || n > settings) {
      err(`settingOverrides のキー ${settingKey} が不正です（2〜${settings}）`);
    }
    // 上書き後の合計はエンジンでは検査されないため、ここで実際に合成して検証する
    const key = (roles: readonly string[]) => [...roles].sort().join(',');
    const merged = new Map((def.lottery?.base ?? []).map((e) => [key(e.roles), e.weight]));
    for (const entry of overrides) {
      merged.set(key(entry.roles), entry.weight);
      for (const id of entry.roles) if (!roleIds.has(id)) err(`settingOverrides[${settingKey}]: 未定義の役 ${id}`);
    }
    const total = [...merged.values()].reduce((a, b) => a + b, 0);
    if (total > 65536) {
      err(`設定${settingKey}: 重み合計が 65536 を超えています (${total}) → 合計で ${total - 65536} ぶん重みを減らしてください`);
    }
  }

  for (const rt of def.rtStates ?? []) {
    for (const id of Object.keys(rt.replayWeights)) {
      if (!roleIds.has(id)) err(`RT ${rt.id} の replayWeights に未定義の役: ${id}`);
      if (bonusIds.has(id)) {
        warn(
          `RT ${rt.id} はボーナス役 ${id} の確率を状態で変えています = 集中（2〜3号機の仕組み）。` +
            '4号機以降は禁止された表現なので、4号機基準の適合試験には通らないのが正常です',
        );
      }
    }
  }

  // サブ基板モード（AT 高確/低確）
  const navModes = def.nav?.modes;
  if (navModes) {
    if (!def.nav?.at) err('nav.modes には nav.at が必要です');
    const modeIds = new Set(navModes.states.map((m) => m.id));
    if (!modeIds.has(navModes.initial)) err(`nav.modes.initial が未定義: ${navModes.initial}`);
    for (const mode of navModes.states) {
      for (const t of mode.triggers ?? []) {
        if (t.on === 'roleHit' && !roleIds.has(t.of)) err(`AT モード ${mode.id} の trigger に未定義の役: ${t.of}`);
      }
      for (const t of mode.transitions ?? []) {
        if (!modeIds.has(t.to)) err(`AT モード ${mode.id} の移行先が未定義: ${t.to}`);
        if (t.on === 'roleHit' && !roleIds.has(t.of)) err(`AT モード ${mode.id} の transition に未定義の役: ${t.of}`);
      }
    }
  }

  const carryover = def.carryover;
  if (!carryover || !Number.isInteger(carryover.queueLimit) || carryover.queueLimit < 1) {
    err('carryover.queueLimit は 1 以上が必要です');
  }
  const lid = carryover?.lid;
  if (lid) {
    if (lid.release && lid.modes) err('lid.release と lid.modes は排他です');
    if (!lid.release && !lid.modes) err('lid には release か modes のどちらかが必要です');
    if (lid.modes) {
      const modeIds = new Set(lid.modes.states.map((m) => m.id));
      if (!modeIds.has(lid.modes.initial)) err(`lid.modes.initial が未定義: ${lid.modes.initial}`);
      for (const mode of lid.modes.states) {
        for (const t of mode.onBonusEnd ?? []) {
          if (!modeIds.has(t.to)) err(`モード ${mode.id} の移行先が未定義: ${t.to}`);
        }
      }
    }
  }

  const at = def.nav?.at;
  if (at) {
    for (const target of at.navTargets) {
      if (!navGroupIds.has(target)) err(`nav.at.navTargets に未定義の navGroup: ${target}`);
    }
    const hasNavRole = (def.roles ?? []).some((r) => r.nav && at.navTargets.includes(r.nav.group));
    if (!hasNavRole) warn('ナビ対象の打ち分け役が存在しないため、AT は出玉に影響しません（docs/design/01 軸 2）');
  }

  if ((def.bonuses ?? []).length === 0 && !at) warn('役物もナビもない構成です（出玉の波が作れません）');

  return { errors, warnings };
}

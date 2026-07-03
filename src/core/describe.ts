import { estimateSpec, formatOneIn, formatPct } from './spec.js';
import type { EstimateOptions } from './spec.js';
import type { LidRelease, MachineDef, RoleDef, RoleId } from './types.js';

/**
 * 機種定義から遊び方ガイドとスペック表を自動生成する。
 * 手書きガイド（プリセットの読み物）と違い、定義を変えれば数値も文章も追随するので、
 * カスタム機種にもそのまま使える。数値は理論近似（spec.ts）に基づく。
 */

export interface SpecTableRow {
  label: string;
  payout: string;
  /** 設定 1 の確率 */
  prob: string;
  /** 設定差がある場合の最高設定の確率 */
  probMax: string | null;
  note: string;
}

export interface AutoGuide {
  summary: string;
  points: string[];
  specRows: SpecTableRow[];
  /** 理論機械割（設定 1 と最高設定の適当打ち/完全打ち） */
  rateNote: string;
}

const BONUS_KIND_LABEL: Record<'bb' | 'rb' | 'sb', string> = {
  bb: 'BIG BONUS',
  rb: 'REGULAR BONUS',
  sb: 'シングル',
};

function releaseText(release: LidRelease): string {
  switch (release.type) {
    case 'gameCountTable': {
      const games = release.table.map((r) => r.games);
      const min = Math.min(...games);
      const max = Math.max(...games);
      return min === max ? `${min}G 消化で解除` : `${min}〜${max}G 消化で解除（ゲーム数テーブル抽選）`;
    }
    case 'lottery': {
      const trigger = (release.on ?? 'any') === 'pureMiss' ? '純ハズレを引いたゲームの' : '毎ゲーム';
      return `${trigger}約 ${formatPct(release.weight / 65536, 0)} で解除抽選`;
    }
    case 'roleHit':
      return `${release.of} の入賞で解除`;
  }
}

function pullInText(role: RoleDef): string {
  if (role.pullIn === 'guaranteed') return 'どこを押しても揃う';
  return `目押し要素（適当打ちだと約 ${formatPct(role.pullIn.missable.targetRate, 0)} で入賞）`;
}

/** 打ち分けグループ（押し順ベル等）をまとめた表示用の役リスト */
function displayRoles(machine: MachineDef): { label: string; roles: RoleDef[]; navGroup: string | null }[] {
  const grouped = new Map<string, RoleDef[]>();
  const singles: RoleDef[] = [];
  for (const role of machine.roles) {
    if (role.nav) {
      const list = grouped.get(role.nav.group) ?? [];
      list.push(role);
      grouped.set(role.nav.group, list);
    } else {
      singles.push(role);
    }
  }
  return [
    ...singles.map((r) => ({ label: r.id, roles: [r], navGroup: null })),
    ...[...grouped.entries()].map(([group, roles]) => ({
      label: `${group}（押し順 ${roles.length} 択）`,
      roles,
      navGroup: group,
    })),
  ];
}

export function describeMachine(machine: MachineDef, opts: EstimateOptions = {}): AutoGuide {
  const settings = machine.lottery.settings ?? 1;
  const s1 = estimateSpec(machine, 1, opts);
  const sMax = settings > 1 ? estimateSpec(machine, settings, opts) : null;
  const bonusIds = new Set(machine.bonuses.map((b) => b.id));

  // ---- summary ----
  const features: string[] = [];
  const hasBB = machine.bonuses.some((b) => b.kind === 'bb');
  const hasStock = machine.carryover.queueLimit > 1;
  if (hasStock) features.push('ボーナスを貯めて放出するストック機');
  else if (hasBB) features.push('出玉の主役はボーナスのノーマルタイプ');
  if (machine.carryover.lid?.modes) features.push('解除モード管理あり');
  if (machine.nav?.at) features.push('押し順ナビの AT 搭載');
  if (machine.rtStates.length > 0) features.push('RT あり');
  const summary = `${features.join('・') || 'シンプルな構成'}。設定は ${settings} 段階。`;

  // ---- スペック表 ----
  const specRows: SpecTableRow[] = [];
  const probOf = (est: typeof s1, ids: readonly RoleId[]): number =>
    est.table.reduce((sum, row) => (row.roles.some((r) => ids.includes(r)) ? sum + row.p : sum), 0);

  for (const view of displayRoles(machine)) {
    const ids = view.roles.map((r) => r.id);
    const role = view.roles[0]!;
    if (bonusIds.has(role.id)) continue; // ボーナスは下で別枠
    const p1 = probOf(s1, ids);
    if (p1 <= 0) continue;
    const pMax = sMax ? probOf(sMax, ids) : null;
    specRows.push({
      label: view.label,
      payout: role.kind === 'replay' ? '再遊技' : `${role.payout}枚`,
      prob: formatOneIn(p1),
      probMax: pMax !== null && Math.abs(pMax - p1) > 1e-9 ? formatOneIn(pMax) : null,
      note: view.navGroup ? '正解の第 1 停止でのみ満額' : pullInText(role),
    });
  }
  for (const bonus of s1.bonuses) {
    const bMax = sMax?.bonuses.find((b) => b.id === bonus.id);
    const medals = Math.round(bonus.expectedMedalsNaive);
    specRows.push({
      label: `${BONUS_KIND_LABEL[bonus.kind]}（${bonus.id}）`,
      payout: medals > 0 ? `期待 約${medals}枚` : '—',
      prob: formatOneIn(bonus.p),
      probMax: bMax && Math.abs(bMax.p - bonus.p) > 1e-9 ? formatOneIn(bMax.p) : null,
      note: bonus.kind === 'sb' ? '1 ゲームで終了' : `約 ${Math.round(bonus.expectedGames)}G 消化`,
    });
  }
  specRows.push({
    label: 'ハズレ',
    payout: '—',
    prob: formatOneIn(s1.missP),
    probMax: sMax && Math.abs(sMax.missP - s1.missP) > 1e-9 ? formatOneIn(sMax.missP) : null,
    note: '',
  });

  // ---- points ----
  const points: string[] = [];
  const missableRoles = machine.roles.filter((r) => r.pullIn !== 'guaranteed' && !bonusIds.has(r.id));
  if (missableRoles.length > 0) {
    points.push(`目押しで差がつく役: ${missableRoles.map((r) => r.id).join('・')}。狙えば完全打ちの機械割に近づく`);
  }
  if (machine.carryover.queueLimit === 1) {
    points.push('成立したボーナスは揃えるまで持ち越される（内部中）。ハズレのはずなのに出目がおかしい……がリーチ目');
  }
  if (hasStock) {
    const lid = machine.carryover.lid;
    points.push(`ボーナスは最大 ${machine.carryover.queueLimit} 個までストックされ、蓋が解除されたときに放出される`);
    if (lid?.release) points.push(`蓋の解除条件: ${releaseText(lid.release)}`);
    if (lid?.modes) {
      for (const mode of lid.modes.states) {
        points.push(`モード「${mode.id}」: ${releaseText(mode.release)}`);
      }
      points.push('ボーナス終了のたびにモード移行抽選が行われる（どのモードにいるかは見えない）');
    }
  }
  const at = machine.nav?.at;
  if (at) {
    const triggerTexts = at.triggers.map((t) => {
      if (t.on === 'roleHit') return `${t.of} で ${formatPct(t.prob, 0)}`;
      if (t.on === 'pureMiss') return `純ハズレで ${formatPct(t.prob, 1)}`;
      return `${t.n}G の天井`;
    });
    points.push(`AT 突入のきっかけ: ${triggerTexts.join(' / ')}`);
    if (at.management.type === 'set') {
      points.push(`AT は ${at.management.gamesPerSet}G × 継続率 ${formatPct(at.management.continueProb, 0)} のセット管理。ナビに従うだけで機械割が上がる`);
    } else {
      points.push(`AT は ${at.management.games}G 継続。ナビに従うだけで機械割が上がる`);
    }
  }
  for (const rt of machine.rtStates) {
    const entry = rt.entry[0];
    const exit = rt.exit.find((t) => t.on === 'games');
    const entryText = entry?.on === 'bonusEnd' ? `${entry.of ?? 'ボーナス'} 終了後` : '条件成立で';
    points.push(`${entryText} RT「${rt.id}」に突入${exit && exit.on === 'games' ? `（${exit.n}G で終了）` : ''}。リプレイ確率が変わる`);
  }
  const gap = s1.perfect - s1.naive;
  points.push(
    `技術介入度: 理論値で適当打ち ${formatPct(s1.naive)} → 完全打ち ${formatPct(s1.perfect)}（差 ${(gap * 100).toFixed(1)}pt）`,
  );

  const rateNote = sMax
    ? `理論機械割: 設定1 適当打ち ${formatPct(s1.naive)} / 完全打ち ${formatPct(s1.perfect)} 〜 設定${settings} 適当打ち ${formatPct(sMax.naive)} / 完全打ち ${formatPct(sMax.perfect)}`
    : `理論機械割: 適当打ち ${formatPct(s1.naive)} / 完全打ち ${formatPct(s1.perfect)}`;

  return { summary, points, specRows, rateNote };
}

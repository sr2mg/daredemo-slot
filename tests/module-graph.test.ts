// モジュールグラフの構造ルールを固定するテスト。
//
// 依存の「方向」と「循環の不在」は型システムでは強制されないため、
// ここで静的 import を走査して規約をテストに落とす。
// - レイヤ方向: core は audio/ui を知らない。audio は ui を知らない。
// - 値 import の循環はランタイムで undefined バインディングとして静かに壊れるので常に禁止。
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const SRC_ROOT = resolve(__dirname, '../src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

interface Edge {
  from: string; // src からの相対パス（/ 区切り）
  to: string;
  typeOnly: boolean;
}

function normalize(file: string): string {
  return relative(SRC_ROOT, file).split(sep).join('/');
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // パッケージは対象外
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* 存在しない候補 */
    }
  }
  return null;
}

function collectEdges(): Edge[] {
  const edges: Edge[] = [];
  const importRe =
    /^(?:import|export)\s+(type\s+)?(?:[\w${}*,\s]+\s+from\s+)?['"]([^'"]+)['"];?/gm;
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const target = resolveImport(file, m[2]!);
      if (!target || !target.startsWith(SRC_ROOT)) continue;
      edges.push({ from: normalize(file), to: normalize(target), typeOnly: Boolean(m[1]) });
    }
  }
  return edges;
}

function findCycle(edges: Edge[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const e of edges) {
    const list = graph.get(e.from) ?? [];
    list.push(e.to);
    graph.set(e.from, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    if (done.has(node)) return null;
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    done.add(node);
    return null;
  };
  for (const node of graph.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

const layerOf = (file: string): 'core' | 'audio' | 'ui' | 'other' => {
  if (file.startsWith('core/')) return 'core';
  if (file.startsWith('audio/')) return 'audio';
  if (file.startsWith('ui/')) return 'ui';
  return 'other';
};

describe('モジュールグラフの規約', () => {
  const edges = collectEdges();

  it('レイヤ方向: core→audio/ui、audio→ui の import が無い', () => {
    const violations = edges.filter((e) => {
      const from = layerOf(e.from);
      const to = layerOf(e.to);
      if (from === 'core') return to === 'audio' || to === 'ui';
      if (from === 'audio') return to === 'ui';
      return false;
    });
    expect(violations.map((v) => `${v.from} -> ${v.to}`)).toEqual([]);
  });

  it('値 import に循環が無い（ESM の実行時循環は静かに壊れる）', () => {
    const cycle = findCycle(edges.filter((e) => !e.typeOnly));
    expect(cycle).toBeNull();
  });

  it('core は type import を含めても循環が無い（型の置き場所が正しい証明）', () => {
    const coreEdges = edges.filter(
      (e) => e.from.startsWith('core/') && e.to.startsWith('core/'),
    );
    const cycle = findCycle(coreEdges);
    expect(cycle).toBeNull();
  });
});

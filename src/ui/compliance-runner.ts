import type { ComplianceOptions, ComplianceResult, ComplianceTask } from '../core/compliance.js';
import { assembleCompliance, checkCompliance, planCompliance } from '../core/compliance.js';
import type { MachineDef } from '../core/types.js';

/**
 * 適合試験の Worker プール実行。
 * モンテカルロ試行は互いに独立なので、CPU コア数ぶんの Worker にばら撒いて並列化する
 * （シードはタスクに焼き込み済みのため、結果は逐次実行の checkCompliance と完全一致）。
 * メインスレッドを塞がないので、試験中も UI は操作できる。
 */

let pool: Worker[] | null = null;
/** 同時に 2 つの試験が走らないよう直列化するチェーン */
let chain: Promise<unknown> = Promise.resolve();

function getPool(): Worker[] {
  if (pool) return pool;
  const size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1));
  pool = Array.from(
    { length: size },
    () => new Worker(new URL('./compliance.worker.ts', import.meta.url), { type: 'module' }),
  );
  return pool;
}

function runTasks(
  machine: MachineDef,
  tasks: readonly ComplianceTask[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[]> {
  const workers = getPool();
  return new Promise((resolve, reject) => {
    const rates = new Array<number>(tasks.length);
    let next = 0;
    let done = 0;
    const feed = (worker: Worker) => {
      if (next >= tasks.length) return;
      const id = next++;
      worker.postMessage({ id, machine, task: tasks[id] });
    };
    for (const worker of workers) {
      worker.onmessage = (e: MessageEvent<{ id: number; rate: number }>) => {
        rates[e.data.id] = e.data.rate;
        done++;
        onProgress?.(done, tasks.length);
        if (done === tasks.length) resolve(rates);
        else feed(worker);
      };
      worker.onerror = (e) => reject(new Error(e.message));
      feed(worker);
    }
  });
}

/**
 * checkCompliance の並列版。Worker が使えない環境では逐次実行にフォールバックする。
 * onProgress は完了試行数 / 総試行数で呼ばれる。
 */
export function runComplianceParallel(
  machine: MachineDef,
  opts: ComplianceOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<ComplianceResult> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(checkCompliance(machine, opts));
  }
  const run = chain.then(async () => {
    const plan = planCompliance(opts);
    const rates = await runTasks(machine, plan.tasks, onProgress);
    return assembleCompliance(plan, rates);
  });
  chain = run.catch(() => {});
  return run;
}

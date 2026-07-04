import type { ComplianceTask } from '../core/compliance.js';
import { runComplianceTask } from '../core/compliance.js';
import type { MachineDef } from '../core/types.js';

/**
 * 適合試験の試行 1 個を実行するモジュール Worker。
 * 試行は独立（シードはタスクに焼き込み済み）なので、何並列で回しても結果は逐次と一致する。
 */

interface WorkerRequest {
  id: number;
  machine: MachineDef;
  task: ComplianceTask;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: { id: number; rate: number }) => void;
};

ctx.onmessage = (e) => {
  const { id, machine, task } = e.data;
  ctx.postMessage({ id, rate: runComplianceTask(machine, task) });
};

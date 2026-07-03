import type { MachineDef } from '../core/types.js';
import { atBeast } from './at-beast.js';
import { ctMachine } from './ct-machine.js';
import { sampleAType } from './sample-a.js';
import { shuchuMachine } from './shuchu.js';
import { stockBB } from './stock-bb.js';
import { stockSB } from './stock-sb.js';

/** WebUI で切り替えられるプリセット機種（docs/design/01 プリセット表の実装分） */
export const machines: readonly MachineDef[] = [sampleAType, atBeast, stockBB, stockSB, ctMachine, shuchuMachine];

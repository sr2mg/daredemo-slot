#!/usr/bin/env bash
# emu2413 を LLVM clang で直接 WASM 化する（emscripten 不要。LLVM 15+ / wasm-ld が必要）。
# 出力: src/ui/emu2413.wasm（ビルド済みバイナリはリポジトリにコミットする）
set -euo pipefail
cd "$(dirname "$0")/../.."

clang --target=wasm32 -O2 -ffreestanding -nostdlib -fno-builtin \
  -I tools/wasm/include -I vendor/emu2413 \
  -Wl,--no-entry \
  -Wl,--allow-undefined \
  -Wl,--export=OPLL_new \
  -Wl,--export=OPLL_reset \
  -Wl,--export=OPLL_writeReg \
  -Wl,--export=OPLL_calc \
  -o src/ui/emu2413.wasm \
  vendor/emu2413/emu2413.c tools/wasm/wasm_shim.c

ls -la src/ui/emu2413.wasm

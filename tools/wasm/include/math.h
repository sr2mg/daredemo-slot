/* emu2413 を -nostdlib で WASM 化するための最小スタブ（tools/wasm/wasm_shim.c が実装） */
#pragma once
double sin(double x);
double cos(double x);
double floor(double x);

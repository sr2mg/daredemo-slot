/* 最小スタブ（tools/wasm/wasm_shim.c が実装） */
#pragma once
#ifndef _SHIM_SIZE_T
#define _SHIM_SIZE_T
typedef __SIZE_TYPE__ size_t;
#endif
void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);

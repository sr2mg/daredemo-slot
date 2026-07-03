/* bump アロケータで実装する最小スタブ（tools/wasm/wasm_shim.c） */
#pragma once
#ifndef _SHIM_SIZE_T
#define _SHIM_SIZE_T
typedef __SIZE_TYPE__ size_t;
#endif
#ifndef NULL
#define NULL ((void *)0)
#endif
void *malloc(size_t size);
void *calloc(size_t n, size_t size);
void free(void *ptr);

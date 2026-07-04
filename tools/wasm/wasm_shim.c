/*
 * emu2413 を LLVM clang 単体（emscripten なし）で WASM 化するためのフリースタンディング shim。
 * - malloc/calloc: bump アロケータ（free は no-op）。
 *   OPLL_new(3579545, 49716) とレート 49716 を使うと内部リサンプラが無効になり
 *   OPLL_reset 時の再確保が発生しないため、リークせずインスタンスを使い回せる
 * - sin/cos: WASM に命令が無いので JS から import（env.js_sin / env.js_cos）
 * - floor: WASM ネイティブ命令（__builtin_floor）
 * - printf: emu2413 のデバッグ dump 専用なので no-op
 */
typedef __SIZE_TYPE__ size_t;

extern double js_sin(double x);
extern double js_cos(double x);

double sin(double x) { return js_sin(x); }
double cos(double x) { return js_cos(x); }
double floor(double x) { return __builtin_floor(x); }

static unsigned char heap[1 << 20]; /* 1MB。OPLL 本体 + テーブルで十分 */
static size_t heap_top = 0;

void *malloc(size_t size) {
  size = (size + 7u) & ~7u;
  if (heap_top + size > sizeof(heap)) return 0;
  void *p = &heap[heap_top];
  heap_top += size;
  return p;
}

void *memset(void *dst, int c, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  for (size_t i = 0; i < n; i++) d[i] = (unsigned char)c;
  return dst;
}

void *calloc(size_t n, size_t size) {
  void *p = malloc(n * size);
  if (p) memset(p, 0, n * size);
  return p;
}

void free(void *ptr) { (void)ptr; }

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

int printf(const char *fmt, ...) {
  (void)fmt;
  return 0;
}

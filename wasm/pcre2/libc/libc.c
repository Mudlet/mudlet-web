/* The libc PCRE2 needs, for a freestanding wasm32 build with no imports.
 *
 * PCRE2 calls malloc/free through its default memory context, and the
 * mem* functions directly. Built with -mbulk-memory, memcpy/memmove/memset
 * are single memory.copy/memory.fill instructions. */

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

void *memcpy(void *restrict dst, const void *restrict src, size_t n) {
  __builtin_memmove(dst, src, n);
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  __builtin_memmove(dst, src, n);
  return dst;
}

void *memset(void *dst, int c, size_t n) {
  __builtin_memset(dst, c, n);
  return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *p = a, *q = b;
  for (size_t i = 0; i < n; i++) {
    if (p[i] != q[i]) return p[i] - q[i];
  }
  return 0;
}

size_t strlen(const char *s) {
  const char *p = s;
  while (*p) p++;
  return (size_t)(p - s);
}

char *strchr(const char *s, int c) {
  for (;; s++) {
    if (*s == (char)c) return (char *)s;
    if (!*s) return NULL;
  }
}

/* ── Allocator ──────────────────────────────────────────────────────────────
 *
 * Power-of-two size classes, one free list per class, blocks never split or
 * merged and never handed back to the host. The workload is a handful of
 * long-lived compiled patterns and match data blocks, one subject buffer that
 * only grows, and PCRE2's per-match heap frames, which it keeps in the match
 * data and grows by doubling — all sizes that recur, so a block freed is soon
 * taken again from its own list. The cost is up to half of each block unused,
 * which for this workload is far less than the code a general allocator needs.
 *
 * Each block starts with a 16-byte header holding its class, so every pointer
 * handed out is 16-byte aligned (max_align_t on wasm32), as malloc must be. */

#define HEADER 16u
#define MIN_CLASS 5u  /* 32 bytes: the header and 16 bytes of payload */
#define MAX_CLASS 31u /* 2 GiB */
#define PAGE 65536u

extern unsigned char __heap_base;

static void *free_lists[MAX_CLASS + 1];
static uintptr_t heap_top;

static unsigned size_class(size_t total) {
  unsigned cls = MIN_CLASS;
  while (cls < MAX_CLASS && ((size_t)1 << cls) < total) cls++;
  return cls;
}

void *malloc(size_t size) {
  if (size > ((size_t)1 << MAX_CLASS) - HEADER) return NULL;
  unsigned cls = size_class(size + HEADER);
  unsigned char *block = free_lists[cls];
  if (block) {
    free_lists[cls] = *(void **)(block + HEADER);
  } else {
    if (heap_top == 0) heap_top = ((uintptr_t)&__heap_base + HEADER - 1) & ~(uintptr_t)(HEADER - 1);
    size_t bytes = (size_t)1 << cls;
    uintptr_t end = heap_top + bytes;
    if (end < heap_top) return NULL;
    size_t have = __builtin_wasm_memory_size(0) * (size_t)PAGE;
    if (end > have) {
      size_t pages = (end - have + PAGE - 1) / PAGE;
      if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
    }
    block = (unsigned char *)heap_top;
    heap_top = end;
    *(uint32_t *)block = cls;
  }
  return block + HEADER;
}

void free(void *ptr) {
  if (!ptr) return;
  unsigned char *block = (unsigned char *)ptr - HEADER;
  unsigned cls = *(uint32_t *)block;
  *(void **)ptr = free_lists[cls];
  free_lists[cls] = block;
}

/* PCRE2 build configuration for Mudlet Web's wasm module (see build.sh).
 *
 * PCRE2's own defaults, written out so an upgrade can't change them silently,
 * except HEAP_LIMIT: the module this replaced (pcre2-wasm-universal 1.0.0) was
 * configured --with-heap-limit=2000000 (KiB), and patterns that backtrack
 * deeply relied on it. MATCH_LIMIT is the ceiling; Pcre2.ts lowers it per
 * pattern with a (*LIMIT_MATCH=…) verb. */

#define SUPPORT_UNICODE 1
#define PCRE2_STATIC 1
#define PCRE2_EXPORT
#define HAVE_MEMMOVE 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1

#define NEWLINE_DEFAULT 2 /* LF */
#define LINK_SIZE 2
#define MATCH_LIMIT 10000000
#define MATCH_LIMIT_DEPTH MATCH_LIMIT
#define HEAP_LIMIT 2000000
#define PARENS_NEST_LIMIT 250
#define MAX_NAME_SIZE 128
#define MAX_NAME_COUNT 10000
#define MAX_VARLOOKBEHIND 255

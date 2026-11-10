/* The functions src/mud/triggers/pcre/Pcre2.ts calls, over PCRE2's 16-bit
 * library in UTF mode, so offsets are JS string indices as they are.
 *
 * These are the exports pcre2-wasm-universal's C wrapper had, with the names
 * and arguments Pcre2.ts already used, except that match() takes the
 * pcre2_match options. That wrapper hard-coded them to 0, so every call
 * re-checked the subject's UTF-16 from the start offset to its end, and a
 * global match — one call per match — was quadratic in the line's length; it
 * took a patch of the compiled module to pass PCRE2_NO_UTF_CHECK. */

#define PCRE2_CODE_UNIT_WIDTH 16
#include <stddef.h>
#include <stdint.h>
#include "pcre2.h"

#define EXPORT(name) __attribute__((export_name(name)))

static int last_error_code = 0;
static PCRE2_SIZE last_error_offset = 0;

/* The library's version string into `result` (16-bit units), as
 * pcre2_config(PCRE2_CONFIG_VERSION) writes it; with no buffer, its length. */
EXPORT("version")
int version(PCRE2_UCHAR *result) {
  return pcre2_config(PCRE2_CONFIG_VERSION, result);
}

/* Compiles `pattern` (`length` 16-bit units) in UTF mode, plus the flags named
 * in the NUL-terminated `flags`: m, s, i, x. Returns NULL on failure, with
 * the error kept for lastErrorMessage/lastErrorOffset. */
EXPORT("compile")
pcre2_code *compile(PCRE2_SPTR pattern, PCRE2_SIZE length, const char *flags) {
  last_error_code = 0;
  last_error_offset = 0;
  uint32_t options = PCRE2_UTF;
  for (; *flags; flags++) {
    switch (*flags) {
      case 'm': options |= PCRE2_MULTILINE; break;
      case 's': options |= PCRE2_DOTALL; break;
      case 'i': options |= PCRE2_CASELESS; break;
      case 'x': options |= PCRE2_EXTENDED; break;
      default:
        last_error_code = PCRE2_ERROR_BAD_OPTIONS;
        return NULL;
    }
  }
  return pcre2_compile(pattern, length, options, &last_error_code, &last_error_offset, NULL);
}

EXPORT("destroyCode")
void destroy_code(pcre2_code *code) {
  pcre2_code_free(code);
}

/* The last compile error's message into `buffer`; its length in units. */
EXPORT("lastErrorMessage")
int last_error_message(PCRE2_UCHAR *buffer, PCRE2_SIZE buffer_length) {
  if (last_error_code == 0) return 0;
  return pcre2_get_error_message(last_error_code, buffer, buffer_length);
}

EXPORT("lastErrorOffset")
PCRE2_SIZE last_error_offset_of(void) {
  return last_error_offset;
}

EXPORT("createMatchData")
pcre2_match_data *create_match_data(pcre2_code *code) {
  return pcre2_match_data_create_from_pattern(code, NULL);
}

EXPORT("destroyMatchData")
void destroy_match_data(pcre2_match_data *data) {
  pcre2_match_data_free(data);
}

EXPORT("match")
int match(pcre2_code *code, PCRE2_SPTR subject, PCRE2_SIZE length, PCRE2_SIZE start,
          pcre2_match_data *data, uint32_t options) {
  return pcre2_match(code, subject, length, start, options, data, NULL);
}

EXPORT("getOvectorCount")
uint32_t get_ovector_count(pcre2_match_data *data) {
  return pcre2_get_ovector_count(data);
}

EXPORT("getOvectorPointer")
PCRE2_SIZE *get_ovector_pointer(pcre2_match_data *data) {
  return pcre2_get_ovector_pointer(data);
}

EXPORT("getMatchNameCount")
uint32_t get_match_name_count(pcre2_code *code) {
  uint32_t count = 0;
  pcre2_pattern_info(code, PCRE2_INFO_NAMECOUNT, &count);
  return count;
}

EXPORT("getMatchNameTableEntrySize")
uint32_t get_match_name_table_entry_size(pcre2_code *code) {
  uint32_t size = 0;
  pcre2_pattern_info(code, PCRE2_INFO_NAMEENTRYSIZE, &size);
  return size;
}

EXPORT("getMatchNameTable")
PCRE2_SPTR get_match_name_table(pcre2_code *code) {
  PCRE2_SPTR table = NULL;
  pcre2_pattern_info(code, PCRE2_INFO_NAMETABLE, &table);
  return table;
}

/* For Pcre2.ts to place subjects, patterns and buffers in the module's memory. */
EXPORT("malloc")
void *export_malloc(size_t size) {
  void *malloc(size_t);
  return malloc(size);
}

EXPORT("free")
void export_free(void *ptr) {
  void free(void *);
  free(ptr);
}

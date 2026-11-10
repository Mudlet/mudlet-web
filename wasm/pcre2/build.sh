#!/usr/bin/env bash
# Builds libpcre2.wasm, the regex engine behind triggers, aliases and rex,
# from a pinned PCRE2 release.
#
#   wasm/pcre2/build.sh          build, then write libpcre2.wasm and its checksum
#   wasm/pcre2/build.sh --check  build into a temp dir and fail unless the result
#                                is byte-identical to the committed libpcre2.wasm
#
# Needs only clang with the wasm32 target and wasm-ld (LLVM's lld) — no
# emscripten, no wasi-sdk, no JS glue. The module brings its own small libc
# (libc/) and imports nothing; Pcre2.ts instantiates it with an empty import
# object. Output is reproducible for a given clang major version, which is why
# CI rebuilds it with the one named below and compares.
#
# UPGRADING PCRE2: set PCRE2_VERSION and PCRE2_SHA256 (from the release's
# .tar.gz on github.com/PCRE2Project/pcre2/releases), check the source list
# below against the release's CMakeLists.txt (the files making up the
# library, less JIT, DFA, convert, serialize, maketables and the POSIX layer,
# which Mudlet Web doesn't call), run this, then `yarn test`. The new version
# string shows up in rex.version(). Refresh LICENCE-PCRE2.md from the
# release's LICENCE.md: its notice has to travel with the binary.
set -euo pipefail

PCRE2_VERSION=10.49
PCRE2_SHA256=929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae
PCRE2_URL="https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${PCRE2_VERSION}/pcre2-${PCRE2_VERSION}.tar.gz"
EXPECTED_CLANG_MAJOR=18

CLANG=${CLANG:-clang}
WASM_LD=${WASM_LD:-wasm-ld}

here=$(cd "$(dirname "$0")" && pwd)
out="$here/libpcre2.wasm"
sumfile="$here/libpcre2.wasm.sha256"

check=0
[[ "${1:-}" == "--check" ]] && check=1

clang_major=$("$CLANG" -dumpversion | cut -d. -f1)
if [[ "$clang_major" != "$EXPECTED_CLANG_MAJOR" ]]; then
  echo "warning: clang $clang_major, expected $EXPECTED_CLANG_MAJOR; the module will work but not match the committed bytes" >&2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cache="${PCRE2_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/mudlet-web-pcre2}"
mkdir -p "$cache"
tarball="$cache/pcre2-${PCRE2_VERSION}.tar.gz"
if [[ ! -f "$tarball" ]] || ! echo "$PCRE2_SHA256  $tarball" | sha256sum -c --status; then
  curl -fsSL "$PCRE2_URL" -o "$tarball.part"
  mv "$tarball.part" "$tarball"
fi
echo "$PCRE2_SHA256  $tarball" | sha256sum -c --quiet

tar xzf "$tarball" -C "$work"
src="$work/pcre2-${PCRE2_VERSION}/src"
cp "$src/pcre2.h.generic" "$src/pcre2.h"
cp "$src/pcre2_chartables.c.dist" "$src/pcre2_chartables.c"

sources=(
  auto_possess chartables chkdint compile compile_cgroup compile_class config
  context error extuni find_bracket match match_data match_next newline ord2utf
  pattern_info script_run string_utils study substitute substring tables ucd
  valid_utf xclass
)

# Paths inside the build are mapped to stable names so the temp dir and the
# checkout location don't end up in the module.
cflags=(
  --target=wasm32 -O2 -ffreestanding -nostdlib -mbulk-memory
  -fno-builtin-malloc -fno-builtin-free
  -ffile-prefix-map="$work"=. -ffile-prefix-map="$here"=.
  -DHAVE_CONFIG_H -DPCRE2_CODE_UNIT_WIDTH=16
  -I "$here" -isystem "$here/libc/include" -I "$src"
)

objs=()
for name in "${sources[@]}"; do
  "$CLANG" "${cflags[@]}" -c "$src/pcre2_${name}.c" -o "$work/${name}.o"
  objs+=("$work/${name}.o")
done
# Mudlet Web's own C is held to warnings-as-errors; PCRE2 builds as released.
"$CLANG" "${cflags[@]}" -Wall -Wextra -Werror -c "$here/libc/libc.c" -o "$work/libc.o"
"$CLANG" "${cflags[@]}" -Wall -Wextra -Werror -c "$here/bridge.c" -o "$work/bridge.o"

# A 1 MiB stack placed first, so an overflow traps instead of running into
# static data. The heap grows from __heap_base up to 2 GiB; PCRE2's own
# HEAP_LIMIT (config.h) stops a runaway match long before that.
"$WASM_LD" --no-entry --gc-sections --strip-all --stack-first \
  -z stack-size=1048576 --export-memory \
  --initial-memory=2097152 --max-memory=2147483648 \
  "${objs[@]}" "$work/libc.o" "$work/bridge.o" -o "$work/libpcre2.wasm"

built_sum=$(sha256sum "$work/libpcre2.wasm" | cut -d' ' -f1)

if [[ $check -eq 1 ]]; then
  committed_sum=$(sha256sum "$out" | cut -d' ' -f1)
  if [[ "$committed_sum" != "$(cut -d' ' -f1 "$sumfile")" ]]; then
    echo "libpcre2.wasm does not match libpcre2.wasm.sha256" >&2
    exit 1
  fi
  if [[ "$built_sum" != "$committed_sum" ]]; then
    echo "rebuilt module ($built_sum) differs from the committed one ($committed_sum)" >&2
    exit 1
  fi
  echo "libpcre2.wasm reproduces: $built_sum"
else
  cp "$work/libpcre2.wasm" "$out"
  echo "$built_sum  libpcre2.wasm" > "$sumfile"
  echo "wrote $out ($(wc -c < "$out") bytes, sha256 $built_sum)"
fi

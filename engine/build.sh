#!/usr/bin/env bash
# engine/build.sh — 编 quickjs C 源码 + engine.c → engine.wasm（wasm32-wasip1）
#
# 工具链优先级：
#   1. $WASI_SDK_PATH（已就位的 wasi-sdk，含 clang + wasi-sysroot）
#   2. vendor/wasi-sdk（build.sh 首次自动下载 release tarball，~45MB）
# 用法：./build.sh   （产物 ../src/engine.wasm）
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
QJS="$ROOT/vendor/quickjs"
OUT="$ROOT/src/engine.wasm"
VER=$(head -1 "$QJS/VERSION" | tr -d '[:space:]')

if [[ -z "${WASI_SDK_PATH:-}" ]]; then
  WSDK="$ROOT/vendor/wasi-sdk"
  if [[ ! -x "$WSDK/bin/clang" ]]; then
    mkdir -p "$WSDK"
    # wasi-sdk 25 (LLVM 20)；其它镜像可用 WASI_SDK_URL 覆盖
    URL="${WASI_SDK_URL:-https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz}"
    echo "downloading wasi-sdk: $URL"
    curl -fsSL "$URL" | tar xz -C "$WSDK" --strip-components=1
  fi
  WASI_SDK_PATH="$WSDK"
fi
CC="$WASI_SDK_PATH/bin/clang"
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"
CFLAGS=(-Oz --target=wasm32-wasip1 --sysroot="$SYSROOT"
        -D__EMSCRIPTEN__ -D_GNU_SOURCE "-DCONFIG_VERSION=\"$VER\""
        # Intl + Temporal：这两个内建 quickjs 不装进 JS_NewContext，须宿主显式调
        # JS_AddIntrinsicIntl/Temporal（见 engine.c 的 qjs_new），而它们本身由这个
        # 宏门控。代价：wasm 797KB → ~930KB，+3 个 wasi 导入（src/engine.js 已给桩）。
        -DCONFIG_TEMPORAL_INTL
        -ffunction-sections -fdata-sections -I"$QJS" -I.)

OBJ=$(mktemp -d)
trap 'rm -rf "$OBJ"' EXIT
# dtoa.c：vendor 原件的第 33 行 #include <setjmp.h> 在 wasi-libc 上触发
# EH 提案 #error；函数体实测未用 setjmp，剔除该行（已在 vendor 内就地打补丁，
# 此处幂等兜底）。
sed '/#include <setjmp.h>/d' "$QJS/dtoa.c" > "$OBJ/dtoa.c"

for f in quickjs cutils libregexp libunicode; do
  echo "cc $f.c"
  "$CC" "${CFLAGS[@]}" -c "$QJS/$f.c" -o "$OBJ/$f.o"
done
# Intl + Temporal（对应 vendor Makefile 里 CONFIG_TEMPORAL_INTL 的同一组文件；
# 集合必须与 Makefile 一致，漏一个会链接失败）
for f in intl/intl intl/locale intl/locale-data intl/numberformat intl/collator \
         intl/datetimeformat intl/pluralrules intl/listformat \
         intl/relativetimeformat intl/displaynames intl/segmenter intl/durationformat \
         temporal/temporal temporal/instant temporal/duration temporal/plaintime \
         temporal/now temporal/plaindate temporal/plaindatetime temporal/plainyearmonth \
         temporal/plainmonthday temporal/zoneddatetime temporal/calendar \
         temporal/timezone temporal/tzdata_generated; do
  echo "cc $f.c"
  "$CC" "${CFLAGS[@]}" -c "$QJS/$f.c" -o "$OBJ/$(echo "$f" | tr / _).o"
done
echo "cc dtoa.c (patched)"
"$CC" "${CFLAGS[@]}" -c "$OBJ/dtoa.c" -o "$OBJ/dtoa.o"
echo "cc engine.c"
"$CC" "${CFLAGS[@]}" -c engine.c -o "$OBJ/engine.o"
# 链接：reactor 模型（无 main；crt1-reactor 跑构造器；engine.js 实例化后
# 必须先调一次 _initialize 再调任何 qjs_*）
echo "link engine.wasm"
"$CC" "${CFLAGS[@]}" -mexec-model=reactor -Wl,--gc-sections \
 \
  "$OBJ"/*.o -o engine.wasm
mkdir -p "$ROOT/src"
cp engine.wasm "$OUT"
ls -l "$OUT"
# 导入面自检
node -e '
const fs=require("fs");
const m=new WebAssembly.Module(fs.readFileSync(process.argv[1]));
const imps=[...new Set(WebAssembly.Module.imports(m).map(i=>i.module+"."+i.name))].sort();
const exps=WebAssembly.Module.exports(m).map(x=>x.name);
console.log("imports:",imps.join(", "));
console.log("exports:",exps.filter(e=>e.startsWith("qjs_")).join(", "));
const need=imps.filter(i=>!i.startsWith("wasi_snapshot_preview1"));
if(need.length){console.error("非 wasi 导入:",need);process.exit(1);}
' "$OUT"
echo "OK"

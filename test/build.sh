#!/bin/sh
# uso: build.sh nome.c [thumb|arm] [extra.s...]
set -e
cd "$(dirname "$0")"
src=$1; mode=${2:-thumb}; shift 2 || true
out=build/$(basename $src .c)_$mode
mkdir -p build
clang --target=armv4t-none-eabi -m$mode -mfloat-abi=soft -O2 -ffreestanding -fno-builtin -nostdlib -fno-exceptions -c $src -o $out.o
clang --target=armv4t-none-eabi -c crt0.s -o build/crt0.o
extra=""; rt=1
for s in "$@"; do clang --target=armv4t-none-eabi -c $s -o build/$(basename $s .s).o; extra="$extra build/$(basename $s .s).o"; done
ld.lld -T link.ld build/crt0.o $out.o $extra -o $out.elf
llvm-objcopy -O binary $out.elf $out.gba
echo $out.gba

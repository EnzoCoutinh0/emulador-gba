#!/bin/sh
# Compila o Astro Defensor. Precisa de: python3, clang, ld.lld e llvm-objcopy.
set -e
cd "$(dirname "$0")"
mkdir -p build
python3 tools/gfx.py
FLAGS="--target=armv4t-none-eabi -mfloat-abi=soft"
CFLAGS="-ffreestanding -fno-builtin -nostdlib"
clang $FLAGS $CFLAGS -mthumb -O2 -Wall -c source/main.c -o build/main.o
clang $FLAGS $CFLAGS -mthumb -O2 -c source/libc.c -o build/libc.o
clang $FLAGS -c source/crt0.s -o build/crt0.o
clang $FLAGS -c source/irq.s -o build/irq.o
ld.lld -T source/link.ld build/crt0.o build/main.o build/libc.o build/irq.o -o build/astro.elf
llvm-objcopy -O binary build/astro.elf build/astro-defensor.gba
python3 tools/fixheader.py build/astro-defensor.gba

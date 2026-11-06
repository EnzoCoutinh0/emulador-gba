#!/bin/sh
cd "$(dirname "$0")"
cat src/cpu.js src/bus.js src/io.js src/save.js src/hle.js src/ppu.js src/apu.js src/gba.js | grep -v "^'use strict';" > core.js
sed -i "1i 'use strict';" core.js

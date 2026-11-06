#!/usr/bin/env python3
# Gera source/gfx.h: paletas, fonte, estrelas, sprites e música do Astro Defensor.
# Toda a arte é desenhada aqui em "ASCII art": cada caractere é uma cor da paleta.
import math, pathlib

def rgb(r, g, b):  # cor de 24 bits -> 15 bits do GBA (BGR555)
    return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10)

# ---------------- paleta dos sprites (16 cores) ----------------
OBJ_COLORS = {
    '.': (0, 0, 0),         # 0 transparente
    'k': (16, 18, 40),      # contorno escuro
    'g': (150, 160, 180),   # cinza metálico
    'w': (240, 244, 255),   # branco
    'c': (60, 200, 255),    # ciano (cabine)
    'o': (255, 140, 30),    # laranja
    'y': (255, 230, 80),    # amarelo
    'r': (230, 40, 60),     # vermelho
    'd': (70, 76, 100),     # cinza escuro
    'b': (130, 220, 255),   # azul claro (laser)
    'p': (140, 70, 200),    # roxo
    'm': (220, 120, 255),   # lilás
    'G': (40, 170, 80),     # verde
    'L': (160, 255, 120),   # verde-limão
    'R': (120, 20, 40),     # vinho
    'O': (255, 200, 150),   # pêssego
}
OBJ_KEYS = list(OBJ_COLORS.keys())

def tiles_from_art(art, keys):
    """Converte ASCII art (múltiplo de 8 em cada lado) em tiles 4bpp, na ordem do mapeamento 1D."""
    rows = [r for r in art.strip('\n').split('\n')]
    h, w = len(rows), len(rows[0])
    assert all(len(r) == w for r in rows), f'linhas de tamanhos diferentes: {[len(r) for r in rows]}'
    assert w % 8 == 0 and h % 8 == 0, (w, h)
    words = []
    for ty in range(h // 8):
        for tx in range(w // 8):
            for y in range(8):
                v = 0
                for x in range(8):
                    ch = rows[ty * 8 + y][tx * 8 + x]
                    v |= keys.index(ch) << (x * 4)
                words.append(v)
    return words

# ---------------- sprites ----------------
SHIP = ['''
................
................
..kk............
..kgkk..........
...kggkk........
...kgggwkkk.....
.ookggggcccckk..
oyykgwwwwccbbbk.
oyykgwwwwccbbbk.
.ookggggcccckk..
...kgggwkkk.....
...kggkk........
..kgkk..........
..kk............
................
................
''', '''
................
................
..kk............
..kgkk..........
...kggkk........
...kgggwkkk.....
..okggggcccckk..
.oykgwwwwccbbbk.
.oykgwwwwccbbbk.
..okggggcccckk..
...kgggwkkk.....
...kggkk........
..kgkk..........
..kk............
................
................
''']

SAUCER = ['''
................
................
................
......kkkk......
.....kmwmmk.....
....kmmmmmmk....
..kkkkkkkkkkkk..
.kppppppppppppk.
kpyppyppyppyppk.
.kppppppppppppk.
..kkkkkkkkkkkk..
....kdddddddk...
.....kk...kk....
................
................
................
''', '''
................
................
................
......kkkk......
.....kmwmmk.....
....kmmmmmmk....
..kkkkkkkkkkkk..
.kppppppppppppk.
kppyppyppyppypk.
.kppppppppppppk.
..kkkkkkkkkkkk..
....kdddddddk...
.....kk...kk....
................
................
................
''']

BUG = ['''
................
................
....k......k....
.....k....k.....
.....kkkkkk.....
....kLLGGGGGk...
...kLwkGGGGGGk..
..kLLkkGGGGGGGk.
..kGGGGGGGGGGGk.
...kGGGGGGGGGk..
..k.kGGkkGGk.k..
.k..k.k..k.k..k.
....k......k....
................
................
................
''', '''
................
................
....k......k....
.....k....k.....
.....kkkkkk.....
....kLLGGGGGk...
...kLwkGGGGGGk..
..kLLkkGGGGGGGk.
..kGGGGGGGGGGGk.
...kGGGGGGGGGk..
...kkGGkkGGkk...
..k..k.kk.k..k..
.....k....k.....
................
................
................
''']

TURRET = '''
................
.......kkk......
.....kkrrrk.....
....krrrrrRk....
...krwrrrrrRk...
..kkkkkkkkkkkk..
.kddgggggggddk..
kooddgggggddRRk.
kyyddgggggddRRk.
.kddgggggggddk..
..kkkkkkkkkkkk..
...krrrrrrrRk...
....krrrrrRk....
.....kkrrrk.....
.......kkk......
................
'''

LASER = '''
........
........
........
.bbwwwww
.bbwwwww
........
........
........
'''

EBULLET = '''
........
..kkkk..
.korrok.
.kryyrk.
.kryyrk.
.korrok.
..kkkk..
........
'''

POWER = '''
................
....kkkkkkk.....
...kLLLLLLLk....
..kLwwwwwLLLk...
..kLwGGGGwLLk...
..kLwGLLLwLLk...
..kLwGGGGwLLk...
..kLwGLLLLLLk...
..kLwGLLLLLLk...
..kLLLLLLLLLk...
..kGGGGGGGGGk...
...kGGGGGGGk....
....kkkkkkk.....
................
................
................
'''

def explosion(frame):
    """Explosão desenhada por círculos: cada quadro é maior e mais escuro."""
    rad = [3.0, 5.0, 6.8, 7.6][frame]
    rows = []
    for y in range(16):
        r = ''
        for x in range(16):
            d = math.hypot(x - 7.5, y - 7.5)
            n = ((x * 7 + y * 13 + frame * 5) % 11) / 11.0  # "ruído" fixo para bordas irregulares
            edge = rad + n * 1.4 - 0.7
            if d > edge: r += '.'
            elif frame == 3: r += 'd' if d > edge - 2 else ('R' if d > edge - 3.5 else '.')
            elif d < edge * 0.35: r += 'w'
            elif d < edge * 0.6: r += 'y'
            elif d < edge * 0.85: r += 'o'
            else: r += 'r'
        rows.append(r)
    return '\n'.join(rows)

# ---------------- fonte 5x7 (desenhada à mão) ----------------
FONT = {
'0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
'1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
'2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
'3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
'4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
'5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
'6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
'7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
'8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
'9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
'N': ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
'!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
'-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
'.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
'?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
'x': ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
'>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
'(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
}
FONT_ORDER = ' ' + ''.join(k for k in FONT)  # o índice do tile = posição nesta string

def font_tile(ch):
    """Tile 8x8: letra na cor 1 (branca) com sombra na cor 2 (azul-escuro) deslocada 1 pixel."""
    g = FONT.get(ch, ['.....'] * 7)
    assert len(g) == 7 and all(len(r) == 5 for r in g), ch
    px = [[0] * 8 for _ in range(8)]
    for y in range(7):
        for x in range(5):
            if g[y][x] == '#':
                if px[y + 1][x + 2] == 0: px[y + 1][x + 2] = 2
    for y in range(7):
        for x in range(5):
            if g[y][x] == '#': px[y][x + 1] = 1
    words = []
    for y in range(8):
        v = 0
        for x in range(8): v |= px[y][x] << (x * 4)
        words.append(v)
    return words

# ---------------- estrelas do fundo ----------------
def star_tile(positions):
    px = [[0] * 8 for _ in range(8)]
    for (x, y, c) in positions: px[y][x] = c
    return [sum(px[y][x] << (x * 4) for x in range(8)) for y in range(8)]

STAR_TILES = [
    star_tile([(3, 4, 3)]),                      # estrela fraca
    star_tile([(5, 2, 4)]),                      # estrela média
    star_tile([(2, 5, 5)]),                      # estrela forte
    star_tile([(4, 3, 5), (3, 3, 4), (5, 3, 4), (4, 2, 4), (4, 4, 4)]),  # estrela brilhante (cruz)
]

# ---------------- paleta dos fundos ----------------
BG_PAL = [rgb(4, 4, 16), rgb(250, 250, 255), rgb(20, 24, 70), rgb(70, 80, 130), rgb(140, 150, 200), rgb(230, 235, 255)] + [0] * 10
BG_PAL2 = [0, rgb(255, 220, 90), rgb(120, 60, 0)] + [0] * 13   # banco 1: texto amarelo (títulos)

# ---------------- música ----------------
# Melodia original em lá menor, 1 passo = 8 quadros. 0 = pausa. Números = notas MIDI.
MELODY = [
    57, 0, 64, 0, 69, 0, 64, 0, 60, 0, 64, 0, 67, 66, 64, 0,
    57, 0, 64, 0, 69, 0, 71, 0, 72, 0, 71, 0, 69, 0, 0, 0,
    53, 0, 60, 0, 65, 0, 60, 0, 55, 0, 62, 0, 67, 0, 62, 0,
    52, 0, 59, 0, 64, 0, 68, 0, 71, 0, 68, 0, 64, 0, 0, 0,
]
def wave_freq(note):
    if note == 0: return 0
    f = 440.0 * 2 ** ((note - 69) / 12.0)
    return max(0, min(2047, round(2048 - 65536 / f)))
# forma de onda (32 amostras de 4 bits): triângulo suave
WAVE = [round(7.5 + 7.5 * math.sin(2 * math.pi * i / 32)) for i in range(32)]

SINE = [round(26 * math.sin(2 * math.pi * i / 64)) for i in range(64)]

# ---------------- saída ----------------
def carr(ctype, name, vals, fmt='0x{:08X}'):
    body = ', '.join(fmt.format(v & 0xFFFFFFFF) if 'X' in fmt else str(v) for v in vals)
    return f'static const {ctype} {name}[{len(vals)}] = {{ {body} }};\n'

obj_tiles = []
offs = {}
def add(name, art):
    offs[name] = len(obj_tiles) // 8
    obj_tiles.extend(tiles_from_art(art, OBJ_KEYS))
add('SHIP0', SHIP[0]); add('SHIP1', SHIP[1])
add('SAUCER0', SAUCER[0]); add('SAUCER1', SAUCER[1])
add('BUG0', BUG[0]); add('BUG1', BUG[1])
add('TURRET', TURRET); add('POWER', POWER)
for i in range(4): add(f'EXPL{i}', explosion(i))
add('LASER', LASER); add('EBULLET', EBULLET)

font_words = []
for ch in FONT_ORDER: font_words += font_tile(ch)
FONT_TILES = len(FONT_ORDER)
star_words = sum(STAR_TILES, [])

out = ['// Arquivo gerado por tools/gfx.py — não edite à mão.\n#pragma once\n']
out.append(carr('unsigned short', 'obj_pal', [rgb(*c) for c in OBJ_COLORS.values()], '0x{:04X}'))
out.append(carr('unsigned short', 'bg_pal', BG_PAL + BG_PAL2, '0x{:04X}'))
out.append(carr('unsigned int', 'obj_tiles', obj_tiles))
out.append(carr('unsigned int', 'font_tiles', font_words))
out.append(carr('unsigned int', 'star_tiles', star_words))
out.append(f'#define FONT_TILES {FONT_TILES}\n#define STAR_TILE0 {FONT_TILES}\n')
out.append(f'static const char font_order[] = "{FONT_ORDER}";\n')
for k, v in offs.items(): out.append(f'#define T_{k} {v}\n')
out.append(carr('unsigned short', 'melody', [wave_freq(n) for n in MELODY], '{}'))
out.append(f'#define MELODY_LEN {len(MELODY)}\n')
packed = [(WAVE[i * 2] << 4) | WAVE[i * 2 + 1] for i in range(16)]
out.append(carr('unsigned char', 'wave_data', packed, '{}'))
out.append(carr('signed char', 'sine_tab', SINE, '{}'))
root = pathlib.Path(__file__).resolve().parent.parent
(root / 'source').mkdir(exist_ok=True)
(root / 'source' / 'gfx.h').write_text(''.join(out))
print('gfx.h:', len(obj_tiles) * 4, 'bytes de sprites,', FONT_TILES, 'letras')

# prévia em PNG de todos os sprites (para conferir a arte)
try:
    from PIL import Image
    arts = SHIP + SAUCER + BUG + [TURRET, POWER] + [explosion(i) for i in range(4)]
    im = Image.new('RGB', (len(arts) * 18 * 4, 18 * 4), (8, 8, 24))
    for n, art in enumerate(arts):
        rows = art.strip('\n').split('\n')
        for y, r in enumerate(rows):
            for x, ch in enumerate(r):
                if ch != '.':
                    for dy in range(4):
                        for dx in range(4): im.putpixel(((n * 18 + 1 + x) * 4 + dx, (1 + y) * 4 + dy), OBJ_COLORS[ch])
    im.save(root / 'tools' / 'preview.png')
except ImportError:
    pass

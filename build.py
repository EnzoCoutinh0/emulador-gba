import subprocess, pathlib
root = pathlib.Path(__file__).parent
subprocess.run(['sh', str(root / 'build-core.sh')], check=True)
core = (root / 'core.js').read_text() + '\n' + (root / 'src/engine.js').read_text().replace("'use strict';", '')
ui = (root / 'src/accounts.js').read_text() + '\n' + (root / 'src/renderer.js').read_text() + '\n' + (root / 'src/ui.js').read_text()
html = (root / 'src/template.html').read_text()
assert '</script' not in core and '</script' not in ui
html = html.replace('/*CORE*/', core).replace('/*UI*/', ui)
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/index.html').write_text(html)
(root / 'index.html').write_text(html)  # cópia na raiz para o GitHub Pages
print('ok', len(html))

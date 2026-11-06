'use strict';
// =====================================================================
// ui.js — A INTERFACE (tudo o que a pessoa vê e toca)
// =====================================================================
// Cuida de: abrir ROMs (inclusive .zip), mostrar a imagem, tocar o som,
// ler teclado, gamepad e toque, configurações, acelerar, save states e
// onde os saves ficam guardados. A emulação em si roda no motor
// (engine.js, num Web Worker); aqui só mandamos e recebemos mensagens.
// =====================================================================
// ===================== Interface do navegador =====================
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const canvas = $('#screen');
  const statusEl = $('#status'), toastEl = $('#toast');
  const renderer = new Renderer(canvas, new ArrayBuffer(240 * 160 * 4));
  const IN_CLAUDE = !!(window.claude && window.claude.use);
  let running = false, paused = false;
  let gameKey = null;
  const game = { title: '', code: '', saveType: 'none', saveSize: 0 };
  let emuFps = 0, frameReady = false, lastSave = null, lastSaveUnstored = false;

  // motor num Web Worker (cai para o fio principal se não der)
  let send, workerMode = false;
  const pending = new Map(); let rpcId = 0;
  function rpc(msg, transfer) { return new Promise((res) => { const id = ++rpcId; pending.set(id, res); msg.id = id; send(msg, transfer); }); }
  // Recebe as mensagens do motor: imagem nova, áudio, save novo, estatísticas e respostas.
  function onEngine(msg) {
    switch (msg.t) {
      case 'frame': renderer.setFrame(msg.d); frameReady = true; break;
      case 'audio': pushAudio(msg.d); break;
      case 'stats': emuFps = msg.fps; updateStatus(); break;
      case 'save': lastSave = new Uint8Array(msg.d); lastSaveUnstored = true; queueStore(); break;
      case 'info': Object.assign(game, msg); break;
      case 'reply': { const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); } break; }
      case 'error': running = false; toast('Erro na emulação: ' + msg.m, 8000); break;
      case 'log': console.log('[GBA]', msg.m); break;
    }
  }
  try {
    // Cria o Web Worker a partir do próprio código do núcleo, que está na tag <script id="coreScript">.
    // Se der erro (navegador antigo ou bloqueio), o catch abaixo roda o motor aqui mesmo.
    const src = document.getElementById('coreScript').textContent;
    const boot = '\nconst __E = createEngine((m, tr) => self.postMessage(m, tr || []));\nself.onmessage = (e) => __E.handle(e.data);\n';
    const w = new Worker(URL.createObjectURL(new Blob([src, boot], { type: 'text/javascript' })));
    w.onmessage = (e) => onEngine(e.data);
    w.onerror = (e) => { console.warn('worker', e); };
    send = (m, tr) => w.postMessage(m, tr || []);
    workerMode = true;
  } catch (e) {
    console.warn('Worker indisponível, usando o fio principal', e);
    const E = createEngine((m) => onEngine(m));
    send = (m) => E.handle(m);
  }

  // ---------- utilidades ----------
  function toast(msg, ms = 2600) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
  }
  function b64enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function b64dec(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  async function gz(u8) { const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function gunzip(u8) { const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function inflateRaw(u8) { const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return new Uint8Array(await new Response(s).arrayBuffer()); }
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

  // ---------- ZIP ----------
  // Lê um .zip sem biblioteca: acha o índice no fim do arquivo, encontra o
  // primeiro arquivo com a extensão pedida e o descomprime com o DecompressionStream do navegador.
  async function unzipFirst(u8, exts) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65600); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('ZIP inválido');
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      entries.push({ name, method, csize, lho });
      p += 46 + nl + el + cl;
    }
    const e = entries.find(x => exts.some(ext => x.name.toLowerCase().endsWith(ext)));
    if (!e) throw new Error('Nenhum arquivo ' + exts.join('/') + ' dentro do ZIP');
    const lnl = dv.getUint16(e.lho + 26, true), lel = dv.getUint16(e.lho + 28, true);
    const data = u8.subarray(e.lho + 30 + lnl + lel, e.lho + 30 + lnl + lel + e.csize);
    if (e.method === 0) return { name: e.name, data: data.slice() };
    if (e.method === 8) return { name: e.name, data: await inflateRaw(data) };
    throw new Error('Compressão ZIP não suportada (use ZIP comum)');
  }
  // Cria um .zip simples (sem compressão) com um arquivo dentro. Serve para exportar o .sav no site do Claude, que não permite baixar .sav direto.
  function zipStore(name, data) {
    const nb = new TextEncoder().encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length), ch = new Uint8Array(46 + nb.length), end = new Uint8Array(22);
    const L = new DataView(lh.buffer), C = new DataView(ch.buffer), E = new DataView(end.buffer);
    L.setUint32(0, 0x04034b50, true); L.setUint16(4, 10, true); L.setUint32(14, crc, true); L.setUint32(18, data.length, true); L.setUint32(22, data.length, true); L.setUint16(26, nb.length, true); lh.set(nb, 30);
    C.setUint32(0, 0x02014b50, true); C.setUint16(4, 20, true); C.setUint16(6, 10, true); C.setUint32(16, crc, true); C.setUint32(20, data.length, true); C.setUint32(24, data.length, true); C.setUint16(28, nb.length, true); ch.set(nb, 46);
    E.setUint32(0, 0x06054b50, true); E.setUint16(8, 1, true); E.setUint16(10, 1, true); E.setUint32(12, ch.length, true); E.setUint32(16, lh.length + data.length, true);
    const out = new Uint8Array(lh.length + data.length + ch.length + end.length);
    out.set(lh, 0); out.set(data, lh.length); out.set(ch, lh.length + data.length); out.set(end, lh.length + data.length + ch.length);
    return out;
  }

  // ---------- armazenamento ----------
  // Onde os saves ficam guardados:
  //   • No site do Claude: no banco de dados da página, na área privada de cada
  //     pessoa (data/users/<id>), que acompanha a conta em qualquer aparelho.
  //   • Sempre também no localStorage do navegador, como cópia local.
  // Os dados são comprimidos (gzip), viram texto (base64) e, se forem grandes,
  // são divididos em pedaços de 200 KB (cada documento do banco aceita até 256 KB).
  const Store = {
    db: null, uid: null, dl: null, ready: null,
    init() {
      this.ready = (async () => {
        if (!IN_CLAUDE) return;
        try {
          const [db, user, dl] = await Promise.all([window.claude.use('db'), window.claude.use('user'), window.claude.use('downloads')]);
          this.dl = dl;
          if (db && user) { const id = await user.id(); if (id) { this.db = db; this.uid = id; } }
        } catch (e) { console.warn(e); }
        updateCloudBadge();
      })();
    },
    col() { return this.db.collection('data/users/' + this.uid); },
    async putBlob(name, u8) {
      const b64 = b64enc(await gz(u8));
      const t = Date.now();
      lsSet('gba.' + name, JSON.stringify({ t, b64 }));
      if (!this.db) return 'local';
      const CH = 200000, n = Math.ceil(b64.length / CH);
      try {
        for (let i = 0; i < n; i++) await withTimeout(this.col().doc(name + '.' + i).set({ d: b64.slice(i * CH, (i + 1) * CH) }), 15000);
        await withTimeout(this.col().doc(name).set({ t, n, size: u8.length }), 15000);
        return 'cloud';
      } catch (e) { console.warn('db', e); return 'local'; }
    },
    async getBlob(name) {
      let best = null;
      const ls = lsGet('gba.' + name);
      if (ls) { try { const o = JSON.parse(ls); best = { t: o.t, b64: o.b64 }; } catch (e) { } }
      if (this.db) {
        try {
          const meta = await withTimeout(this.col().doc(name).get(), 10000);
          if (meta.exists) {
            const m = meta.data();
            if (!best || m.t > best.t) {
              let b64 = '';
              for (let i = 0; i < m.n; i++) { const c = await withTimeout(this.col().doc(name + '.' + i).get(), 10000); if (!c.exists) throw new Error('pedaço faltando'); b64 += c.data().d; }
              best = { t: m.t, b64 };
            }
          }
        } catch (e) { console.warn('db', e); }
      }
      if (!best) return null;
      return { t: best.t, data: await gunzip(b64dec(best.b64)) };
    },
    async putJSON(name, obj) {
      lsSet('gba.' + name, JSON.stringify(obj));
      if (this.db) { try { await withTimeout(this.col().doc(name).set(obj), 10000); } catch (e) { console.warn(e); } }
    },
    async getJSON(name) {
      if (this.db) { try { const d = await withTimeout(this.col().doc(name).get(), 8000); if (d.exists) return d.data(); } catch (e) { } }
      return null;
    },
  };
  function updateCloudBadge() {
    const el = $('#cloud');
    if (Store.db) { el.textContent = 'Saves guardados na sua conta'; el.className = 'badge ok'; }
    else if (IN_CLAUDE) { el.textContent = 'Saves só neste navegador — exporte com frequência'; el.className = 'badge warn'; }
    else { el.textContent = 'Versão local — saves neste navegador'; el.className = 'badge warn'; }
    $('#btnExport').disabled = !running;
    $('#exportNote').textContent = IN_CLAUDE ? 'Gera um .zip com o arquivo .sav dentro, que funciona em outros emuladores.' : 'Baixa o arquivo .sav, que funciona em outros emuladores.';
  }

  // ---------- configurações ----------
  // Todas as ações que podem ser mapeadas: [código, nome, bit do botão do GBA (-1 = atalho do emulador)].
  const ACTIONS = [
    ['up', 'Cima', 6], ['down', 'Baixo', 7], ['left', 'Esquerda', 5], ['right', 'Direita', 4],
    ['a', 'A', 0], ['b', 'B', 1], ['l', 'L', 9], ['r', 'R', 8], ['start', 'Start', 3], ['select', 'Select', 2],
    ['turboA', 'Turbo A', -1], ['turboB', 'Turbo B', -1],
    ['ffHold', 'Acelerar (segurar)', -1], ['ffToggle', 'Acelerar (liga/desliga)', -1],
    ['pause', 'Pausar', -1], ['saveState', 'Salvar estado', -1], ['loadState', 'Carregar estado', -1],
    ['fullscreen', 'Tela cheia', -1], ['upscale', 'Liga/desliga upscaling', -1], ['screenshot', 'Captura em 4K', -1], ['menu', 'Menu rápido', -1],
  ];
  // Teclas padrão. Os nomes são os códigos físicos (e.code), então funcionam igual em teclados ABNT e americanos.
  const DEF_KB = { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], a: ['KeyX'], b: ['KeyZ'], l: ['KeyA'], r: ['KeyS'], start: ['Enter'], select: ['Backspace', 'ShiftRight'], turboA: ['KeyC'], turboB: ['KeyV'], ffHold: ['Space'], ffToggle: ['Tab'], pause: ['KeyP'], saveState: ['F2'], loadState: ['F4'], fullscreen: ['KeyF'], upscale: ['KeyU'], screenshot: ['F9'], menu: ['Escape'] };
  // Botões padrão do gamepad no "mapeamento padrão" do navegador: b0 = A/✕, b1 = B/○,
  // b12–b15 = direcional, a0/a1 = analógico esquerdo (− e + = direções).
  const DEF_GP = { up: ['b12', 'a1-'], down: ['b13', 'a1+'], left: ['b14', 'a0-'], right: ['b15', 'a0+'], a: ['b1'], b: ['b0'], l: ['b4'], r: ['b5'], start: ['b9'], select: ['b8'], turboA: ['b3'], turboB: ['b2'], ffHold: ['b7'], ffToggle: [], pause: [], saveState: [], loadState: [], fullscreen: [], upscale: [], screenshot: [], menu: ['b16'] };
  // Configurações padrão. As escolhas da pessoa são guardadas no navegador e na conta.
  const DEFAULTS = { filter: 'sharp', lastUpscale: 'xbr', fit: 'fit', cc: 0, ffSpeed: 4, ffAudio: 1, turboRate: 4, showFps: 1, volume: 80, muted: 0, touchMode: 'auto', touchSize: 100, touchOpacity: 75, haptics: 1, deadzone: 40, kb: DEF_KB, gp: DEF_GP, t: 0 };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let S = clone(DEFAULTS);
  try { const o = JSON.parse(lsGet('gba.settings') || 'null'); if (o) S = Object.assign(clone(DEFAULTS), o); } catch (e) { }
  for (const [id] of ACTIONS) { if (!S.kb[id]) S.kb[id] = (DEF_KB[id] || []).slice(); if (!S.gp[id]) S.gp[id] = (DEF_GP[id] || []).slice(); }
  let settingsTimer = null;
  function saveSettings() {
    S.t = Date.now();
    lsSet('gba.settings', JSON.stringify(S));
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => Store.putJSON('settings', { json: JSON.stringify(S), t: S.t }), 1500);
  }
  async function loadCloudSettings() {
    await Store.ready;
    const o = await Store.getJSON('settings');
    if (o && o.json && o.t > (S.t || 0)) {
      try { S = Object.assign(clone(DEFAULTS), JSON.parse(o.json)); lsSet('gba.settings', o.json); applySettings(); } catch (e) { }
    }
  }

  // nomes legíveis
  // Nome legível de cada tecla, para mostrar na tela de configurações.
  function keyName(code) {
    if (!code) return '';
    const map = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Espaço', Enter: 'Enter', Backspace: 'Backspace', Escape: 'Esc', Tab: 'Tab', ShiftLeft: 'Shift esq.', ShiftRight: 'Shift dir.', ControlLeft: 'Ctrl esq.', ControlRight: 'Ctrl dir.', AltLeft: 'Alt esq.', AltRight: 'Alt dir.', MetaLeft: 'Win/Cmd', CapsLock: 'Caps Lock', Semicolon: 'Ç / ;', Comma: ',', Period: '.', Slash: '/ ;', Quote: "'", BracketLeft: '´ [', BracketRight: '[ ]', Backslash: ']', Minus: '-', Equal: '=', Backquote: "'", IntlBackslash: '\\', IntlRo: '/' };
    if (map[code]) return map[code];
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
  }
  const PAD_NAMES = ['A / ✕', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'Back / Select', 'Start / Options', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home / PS'];
  function padName(b) {
    if (!b) return '';
    if (b[0] === 'b') { const i = +b.slice(1); return PAD_NAMES[i] ? PAD_NAMES[i] : 'Botão ' + i; }
    const ax = +b.slice(1, -1), dir = b.slice(-1);
    const names = { '0-': 'Analóg. esq. ←', '0+': 'Analóg. esq. →', '1-': 'Analóg. esq. ↑', '1+': 'Analóg. esq. ↓', '2-': 'Analóg. dir. ←', '2+': 'Analóg. dir. →', '3-': 'Analóg. dir. ↑', '3+': 'Analóg. dir. ↓' };
    return names[ax + dir] || ('Eixo ' + ax + ' ' + dir);
  }

  // Áudio: o motor manda blocos de amostras a 32.768 Hz, que entram num buffer circular (rbuf).
  // O ScriptProcessor do navegador lê esse buffer na taxa da placa de som (44,1 ou 48 kHz), interpolando.
  // Se o buffer enche ou esvazia demais, a velocidade de leitura é ajustada um pouco para não estalar.
  // ---------- áudio ----------
  let actx = null, node = null;
  const RB = 16384, rbuf = new Float32Array(RB * 2);
  let rw = 0, rr = 0, rfill = 0, rfrac = 0, lastL = 0, lastR = 0;
  function pushAudio(d) {
    for (let i = 0; i + 1 < d.length; i += 2) {
      if (rfill >= RB - 1) return;
      rbuf[rw * 2] = d[i]; rbuf[rw * 2 + 1] = d[i + 1]; rw = (rw + 1) % RB; rfill++;
    }
  }
  // Os navegadores só liberam o som depois de um clique ou tecla, então o áudio é criado na primeira interação.
  function initAudio() {
    if (actx) { if (actx.state !== 'running') actx.resume().catch(() => { }); return; }
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      node = actx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (ev) => {
        const L = ev.outputBuffer.getChannelData(0), R = ev.outputBuffer.getChannelData(1);
        let ratio = 32768 / actx.sampleRate;
        const target = 2048;
        if (rfill > target * 2) ratio *= 1.02; else if (rfill > target * 1.3) ratio *= 1.005; else if (rfill < target / 2) ratio *= 0.99;
        const g = S.muted ? 0 : S.volume / 100;
        for (let i = 0; i < L.length; i++) {
          if (rfill > 1) {
            const j = (rr + 1) % RB;
            const a = rbuf[rr * 2], ar = rbuf[rr * 2 + 1];
            lastL = a + (rbuf[j * 2] - a) * rfrac; lastR = ar + (rbuf[j * 2 + 1] - ar) * rfrac;
            rfrac += ratio;
            while (rfrac >= 1 && rfill > 1) { rfrac -= 1; rr = (rr + 1) % RB; rfill--; }
          } else { lastL *= 0.995; lastR *= 0.995; }
          L[i] = lastL * g; R[i] = lastR * g;
        }
      };
      node.connect(actx.destination);
    } catch (e) { console.warn('áudio indisponível', e); }
  }
  function clearAudio() { rfill = 0; rr = rw = 0; rfrac = 0; }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { if (running) initAudio(); }, { passive: true }));

  // Entrada: teclado (teclas apertadas em kbDown), gamepad (lido a cada quadro) e toque (touchBits).
  // A cada quadro, pollInput junta tudo em actState (qual ação está ativa) e envia os botões ao motor.
  // ---------- entrada ----------
  const kbDown = new Set();
  let touchBits = 0, touchFF = false;
  const actState = {}, prevAct = {};
  let capture = null; // {kind:'kb'|'gp', act, slot, el}
  let ffToggled = false, lastKeys = -1;

  window.addEventListener('keydown', (e) => {
    if (capture && capture.kind === 'kb') {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') endCapture(); else assignBinding('kb', capture.act, capture.slot, e.code);
      return;
    }
    if (settingsOpen()) { if (e.code === 'Escape') { e.preventDefault(); closeSettings(); } return; }
    if ($('#quick').classList.contains('open') && e.code === 'Escape') { e.preventDefault(); closeQuick(); return; }
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && !running) return;
    const bound = ACTIONS.some(([id]) => S.kb[id].includes(e.code));
    if (bound) { e.preventDefault(); kbDown.add(e.code); if (!e.repeat) pollInput(true); }
  }, true);
  window.addEventListener('keyup', (e) => { if (kbDown.delete(e.code)) { e.preventDefault(); pollInput(true); } }, true);
  window.addEventListener('blur', () => { kbDown.clear(); touchBits = 0; touchFF = false; });

  function padActive(gp, b, dz) {
    if (b[0] === 'b') { const btn = gp.buttons[+b.slice(1)]; return !!btn && (btn.pressed || btn.value > 0.5); }
    const ax = gp.axes[+b.slice(1, -1)]; if (ax === undefined) return false;
    return b.endsWith('-') ? ax < -dz : ax > dz;
  }
  function getPads() { try { return navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : []; } catch (e) { return []; } }

  // Lê todas as fontes de entrada. Também cuida da "captura" na tela de configurações
  // (esperando a pessoa apertar a nova tecla ou botão) e dos atalhos, que disparam
  // só no momento em que a tecla é apertada (borda de subida).
  function pollInput(fromKey) {
    const pads = fromKey ? [] : getPads();
    const dz = S.deadzone / 100;
    if (!fromKey && capture && capture.kind === 'gp') { checkPadCapture(pads); }
    for (const [id] of ACTIONS) {
      let on = false;
      for (const c of S.kb[id]) if (kbDown.has(c)) { on = true; break; }
      if (!on && !fromKey) for (const gp of pads) { for (const b of S.gp[id]) if (padActive(gp, b, dz)) { on = true; break; } if (on) break; }
      if (fromKey && !on) on = !!padLatch[id];
      actState[id] = on;
    }
    if (!fromKey) for (const [id] of ACTIONS) padLatch[id] = S.gp[id].some(b => pads.some(gp => padActive(gp, b, dz)));
    if (capture) { for (const [id] of ACTIONS) prevAct[id] = actState[id]; return; }
    // atalhos (na borda de subida)
    const edge = (id) => actState[id] && !prevAct[id];
    if (edge('ffToggle')) toggleFF();
    if (edge('pause')) togglePause();
    if (edge('saveState')) saveState();
    if (edge('loadState')) loadState();
    if (edge('fullscreen')) toggleFullscreen();
    if (edge('screenshot')) screenshot();
    if (edge('upscale')) toggleUpscale();
    if (edge('menu')) { if (settingsOpen()) closeSettings(); else if ($('#quick').classList.contains('open')) closeQuick(); else if (running) openQuick(); }
    for (const [id] of ACTIONS) prevAct[id] = actState[id];
    applyKeys();
  }
  const padLatch = {};
  // Converte as ações em bits de botão do GBA (com o turbo piscando A/B) e envia ao motor só quando mudam.
  function applyKeys() {
    let bits = touchBits;
    for (const [id, , bit] of ACTIONS) if (bit >= 0 && actState[id]) bits |= 1 << bit;
    const phase = Math.floor(performance.now() / (S.turboRate * 1000 / 120)) & 1;
    if (actState.turboA && phase) bits |= 1;
    if (actState.turboB && phase) bits |= 2;
    if (settingsOpen() || $('#quick').classList.contains('open')) bits = 0;
    const k = 0x3FF & ~bits;
    if (k !== lastKeys) { lastKeys = k; window.__keys = k; send({ t: 'keys', v: k }); }
  }

  // Acelerar: ligado pelo botão ⏩, segurando a tecla (padrão: Espaço) ou alternando (padrão: Tab).
  // ---------- acelerar ----------
  function ffActive() { return ffToggled || actState.ffHold || touchFF; }
  function toggleFF() { ffToggled = !ffToggled; updateFFUI(); }
  let lastFFMsg = '';
  function syncFF() {
    const on = ffActive();
    const m = JSON.stringify([on, S.ffSpeed, S.ffAudio]);
    if (m !== lastFFMsg) { lastFFMsg = m; send({ t: 'ff', on, mult: S.ffSpeed, audio: !!S.ffAudio }); if (!on) clearAudioSoon(); }
  }
  function clearAudioSoon() { if (rfill > 4096) clearAudio(); }
  function updateFFUI() {
    syncFF();
    const on = ffActive();
    $('#btnFF').classList.toggle('active', on);
    $('#tFF').classList.toggle('on', on);
    document.body.classList.toggle('ff', on && running);
    $('#osdFF').textContent = '⏩ ' + (S.ffSpeed ? S.ffSpeed + 'x' : 'máx');
  }
  $('#btnFF').addEventListener('click', () => { initAudio(); toggleFF(); });

  // A cada atualização da tela (requestAnimationFrame): lê os controles e desenha a imagem mais nova que o motor mandou.
  // ---------- laço principal (só exibe; a emulação roda no motor) ----------
  let statusExtra = '', statusExtraT = 0, lastFF = false;
  function setStatusExtra(s) { statusExtra = s; statusExtraT = performance.now(); }
  function loop() {
    requestAnimationFrame(loop);
    pollInput(false);
    const ff = ffActive();
    if (ff !== lastFF) { lastFF = ff; updateFFUI(); }
    if (frameReady) { frameReady = false; renderer.draw(); }
  }
  function updateStatus() {
    const extra = statusExtra && performance.now() - statusExtraT < 4000 ? ' · ' + statusExtra : '';
    const sp = emuFps / 59.73;
    const speedTxt = S.showFps ? ` · ${Math.round(emuFps)} fps${ffActive() ? ' (' + sp.toFixed(1) + 'x)' : ''}` : '';
    if (!running) return;
    statusEl.textContent = `${game.title || 'Jogo'} · ${saveLabel(game.saveType)}${speedTxt} · saída ${renderer.outW}×${renderer.outH}${extra}`;
    if (ffActive()) $('#osdFF').textContent = '⏩ ' + sp.toFixed(1) + 'x';
  }
  requestAnimationFrame(loop);
  function saveLabel(t) { return { sram: 'SRAM', flash64: 'Flash 64K', flash128: 'Flash 128K', eeprom: 'EEPROM', none: 'sem save' }[t] || t; }

  // Save da bateria: o motor manda o save quando o jogo grava. queueStore() guarda um por vez
  // (sem atropelar), e na saída da página é feita uma cópia rápida no localStorage.
  // ---------- save da bateria ----------
  let storing = false;
  async function queueStore() {
    if (storing || !lastSaveUnstored || !gameKey) return;
    storing = true;
    try {
      while (lastSaveUnstored) {
        lastSaveUnstored = false;
        const key = gameKey, data = lastSave;
        const where = await Store.putBlob('save-' + key, data);
        setStatusExtra(where === 'cloud' ? 'save sincronizado' : 'save guardado no navegador');
      }
    } finally { storing = false; }
  }
  async function flushSave() {
    if (!running || !game.saveSize) return;
    send({ t: 'flushSave' });
    await new Promise(r => setTimeout(r, 60));
    await queueStore();
  }
  function flushSaveLocalSync() {
    if (!gameKey || !lastSave || !lastSaveUnstored) return;
    lsSet('gba.raw.save-' + gameKey, JSON.stringify({ t: Date.now(), b64: b64enc(lastSave) }));
  }

  // ---------- carregar ROM ----------
  async function openFile(file) {
    try {
      let data = new Uint8Array(await file.arrayBuffer());
      let name = file.name;
      if (data[0] === 0x50 && data[1] === 0x4B) { const z = await unzipFirst(data, ['.gba', '.agb', '.bin']); data = z.data; name = z.name; }
      if (name.toLowerCase().endsWith('.sav')) throw new Error('Isso é um save. Use "Importar save" depois de abrir o jogo.');
      if (data.length < 0xC0) throw new Error('Arquivo pequeno demais para ser uma ROM de GBA');
      await startRom(data, name);
    } catch (e) { console.error(e); toast(e.message, 6000); }
  }
  function romHeader(bytes) {
    const hdr = (o, n) => { let t = ''; for (let i = 0; i < n; i++) { const c = bytes[o + i]; if (c >= 32 && c < 127) t += String.fromCharCode(c); } return t.trim(); };
    return { title: hdr(0xA0, 12), code: hdr(0xAC, 4) };
  }
  // Abre um jogo: calcula a chave dele (código + título), busca o save guardado (o mais
  // recente entre a conta e o navegador) e manda a ROM e o save para o motor.
  async function startRom(data, name) {
    if (running) { await flushSave(); flushSaveLocalSync(); }
    running = false;
    const h = romHeader(data);
    let id = (h.code + '_' + h.title).replace(/[^A-Za-z0-9_-]/g, '_');
    if (!/[A-Za-z0-9]/.test(id)) id = 'rom' + crc32(data.subarray(0, 65536)).toString(16);
    gameKey = id; lastSave = null; lastSaveUnstored = false;
    await Store.ready;
    let best = await Store.getBlob('save-' + gameKey);
    const raw = lsGet('gba.raw.save-' + gameKey);
    if (raw) { try { const o = JSON.parse(raw); if (!best || o.t > best.t) best = { t: o.t, data: b64dec(o.b64) }; } catch (e) { } }
    const restored = !!(best && best.data.length);
    Object.assign(game, { title: h.title, code: h.code });
    const rom = data.slice().buffer;
    const sv = restored ? best.data.slice().buffer : null;
    send({ t: 'load', rom, save: sv }, sv ? [rom, sv] : [rom]);
    if (restored) lastSave = best.data;
    const bios = lsGet('gba.bios'); if (bios) { try { send({ t: 'bios', d: b64dec(bios).buffer }); } catch (e) { } }
    $('#drop').classList.add('hidden');
    document.body.classList.add('playing');
    running = true; paused = false; clearAudio(); lastFFMsg = ''; lastKeys = -1;
    send({ t: 'pause', v: false });
    document.body.classList.remove('paused');
    $('#btnPause').textContent = 'Pausar';
    ['#btnPause', '#btnReset', '#btnSaveState', '#btnLoadState', '#btnImport', '#btnShot'].forEach(s => $(s).disabled = false);
    updateCloudBadge(); updateFFUI(); fitScreen();
    initAudio();
    toast(`${h.title || name} carregado${restored ? ' — save restaurado' : ''}`);
    document.title = (h.title || 'GBA') + ' — Emulador GBA';
  }
  $('#romInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
  const pickRom = () => { initAudio(); $('#romInput').click(); };
  $('#btnOpen').addEventListener('click', pickRom);
  $('#drop').addEventListener('click', pickRom);
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (running && /\.(sav|srm)$/i.test(f.name)) importSave(f); else openFile(f);
  });

  // ---------- ações ----------
  function togglePause() {
    if (!running) return;
    paused = !paused;
    $('#btnPause').textContent = paused ? 'Continuar' : 'Pausar';
    document.body.classList.toggle('paused', paused);
    send({ t: 'pause', v: paused });
    if (paused) flushSave();
  }
  async function resetGame() {
    if (!running) return;
    await flushSave();
    send({ t: 'reset' });
    toast('Jogo reiniciado');
  }
  async function toggleFullscreen() {
    const el = $('#player');
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      else if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else toast('Tela cheia indisponível aqui');
    } catch (e) { toast('Tela cheia indisponível aqui'); }
  }
  // liga/desliga o upscaling: alterna entre a imagem original e o último filtro escolhido
  // Upscaling: "Original" (sharp) = desligado. Os outros filtros ligam o upscaling; o último usado é lembrado para a tecla U.
  function setFilter(f) {
    S.filter = f; if (f !== 'sharp') S.lastUpscale = f;
    saveSettings(); applySettings();
  }
  function toggleUpscale() {
    const on = S.filter === 'sharp';
    setFilter(on ? (S.lastUpscale || 'xbr') : 'sharp');
    toast(on ? 'Upscaling ligado: ' + Renderer.FILTERS.find(x => x[0] === S.filter)[1].replace(/^Upscaling /, '') : 'Upscaling desligado: imagem original');
  }
  // captura da tela em 3840×2560 (4K), com o filtro escolhido
  // Captura em 4K: o renderizador desenha uma vez em 3840×2560 com o filtro atual e a imagem vira um PNG para baixar.
  async function screenshot() {
    if (!running) return;
    try {
      const { url, w, h } = renderer.capture(3840, 2560);
      const bin = atob(url.split(',')[1]); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const name = ((game.title || 'gba').replace(/[^A-Za-z0-9_-]/g, '') || 'gba') + `-${w}x${h}.png`;
      if (!IN_CLAUDE) {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u8], { type: 'image/png' })); a.download = name;
        document.body.appendChild(a); a.click(); a.remove(); toast(`Captura salva: ${w}×${h}`); return;
      }
      await Store.ready;
      if (!Store.dl) { toast('Download indisponível nesta visualização'); return; }
      await Store.dl.save({ filename: name, data: u8 });
      toast(`Captura salva: ${w}×${h}`);
    } catch (e) { if (!e || e.code !== 'declined') toast('Não consegui capturar: ' + (e && (e.message || e.code))); }
  }
  $('#btnShot').addEventListener('click', screenshot);
  $('#btnPause').addEventListener('click', togglePause);
  $('#btnReset').addEventListener('click', resetGame);
  $('#btnFull').addEventListener('click', toggleFullscreen);
  $('#btnMute').addEventListener('click', () => { S.muted = S.muted ? 0 : 1; saveSettings(); applySettings(); initAudio(); });
  $('#vol').addEventListener('input', (e) => { S.volume = +e.target.value; saveSettings(); });

  let stateBusy = false;
  async function saveState() {
    if (!running || stateBusy) return;
    stateBusy = true;
    try {
      const r = await rpc({ t: 'saveState' });
      if (r.err) throw new Error(r.err);
      const u8 = new Uint8Array(r.d);
      toast('Salvando estado…');
      const where = await Store.putBlob('state-' + gameKey, u8);
      toast(where === 'cloud' ? 'Estado salvo (na sua conta)' : 'Estado salvo (neste navegador)');
    } catch (e) { console.error(e); toast('Não consegui salvar o estado: ' + e.message, 5000); }
    stateBusy = false;
  }
  async function loadState() {
    if (!running || stateBusy) return;
    stateBusy = true;
    try {
      const got = await Store.getBlob('state-' + gameKey);
      if (!got) toast('Nenhum estado salvo para este jogo');
      else {
        const d = got.data.slice().buffer;
        const r = await rpc({ t: 'loadState', d }, [d]);
        if (r.err) toast(r.err, 4000); else { clearAudio(); toast('Estado carregado'); }
      }
    } catch (e) { console.error(e); toast('Não consegui carregar o estado: ' + e.message, 5000); }
    stateBusy = false;
  }
  $('#btnSaveState').addEventListener('click', saveState);
  $('#btnLoadState').addEventListener('click', loadState);

  // exportar / importar save
  $('#btnExport').addEventListener('click', async () => {
    if (!running || !game.saveSize) { toast('Este jogo não tem save'); return; }
    await Store.ready;
    const saveData = new Uint8Array((await rpc({ t: 'getSave' })).d);
    const fname = (game.title || 'jogo').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'jogo';
    if (!IN_CLAUDE) {
      const url = URL.createObjectURL(new Blob([saveData]));
      const a = document.createElement('a'); a.href = url; a.download = fname + '.sav';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Save exportado: ' + fname + '.sav'); return;
    }
    if (!Store.dl) { toast('Download indisponível nesta visualização'); return; }
    try { await Store.dl.save({ filename: fname + '-save.zip', data: zipStore(fname + '.sav', saveData) }); toast('Save exportado (o .sav está dentro do .zip)'); }
    catch (e) { if (e && e.code !== 'declined') toast('Não foi possível exportar: ' + (e.message || e.code)); }
  });
  async function importSave(file) {
    try {
      let data = new Uint8Array(await file.arrayBuffer());
      if (data[0] === 0x50 && data[1] === 0x4B) data = (await unzipFirst(data, ['.sav', '.srm', '.fla', '.eep'])).data;
      if (!game.saveSize) { toast('Este jogo não usa save'); return; }
      const d = data.slice().buffer;
      send({ t: 'importSave', d }, [d]);
      toast('Save importado — jogo reiniciado');
    } catch (e) { toast('Falha ao importar: ' + e.message, 5000); }
  }
  $('#saveInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importSave(f); e.target.value = ''; });
  $('#btnImport').addEventListener('click', () => $('#saveInput').click());

  // BIOS
  function applyBios(u8) { if (u8 && u8.length >= 0x4000) { send({ t: 'bios', d: u8.slice().buffer }); $('#biosState').textContent = 'BIOS original carregada'; } }
  $('#biosInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    const u8 = new Uint8Array(await f.arrayBuffer());
    if (u8.length !== 0x4000) { toast('A BIOS do GBA tem exatamente 16 KB'); return; }
    applyBios(u8); lsSet('gba.bios', b64enc(u8));
    toast('BIOS carregada — reinicie o jogo para usar');
  });
  $('#btnBios').addEventListener('click', () => $('#biosInput').click());
  $('#btnBiosOff').addEventListener('click', () => {
    send({ t: 'bios', d: null }); try { localStorage.removeItem('gba.bios'); } catch (e) { }
    $('#biosState').textContent = 'Usando BIOS emulada (padrão)'; toast('Voltando à BIOS emulada');
  });
  { const ls = lsGet('gba.bios'); if (ls) { try { applyBios(b64dec(ls)); } catch (e) { } } }

  // Tela de configurações com abas: teclado, gamepad, tela e upscaling, velocidade e som, celular e avançado.
  // ---------- modal de configurações ----------
  const settingsEl = $('#settings');
  function settingsOpen() { return settingsEl.classList.contains('open'); }
  function openSettings(tab) {
    closeQuick();
    settingsEl.classList.add('open');
    if (tab) selectTab(tab);
    buildBindTables(); updatePadList();
  }
  function closeSettings() { endCapture(); settingsEl.classList.remove('open'); }
  function selectTab(t) {
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === t));
  }
  $$('.tabs button').forEach(b => b.addEventListener('click', () => { endCapture(); selectTab(b.dataset.tab); }));
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#btnSettings2').addEventListener('click', () => openSettings());
  $('#btnEditKeys').addEventListener('click', () => openSettings('kb'));
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  settingsEl.addEventListener('pointerdown', (e) => { if (e.target === settingsEl) closeSettings(); });

  function buildBindTables() {
    for (const kind of ['kb', 'gp']) {
      const tb = kind === 'kb' ? $('#kbTable') : $('#gpTable');
      tb.innerHTML = '<tr><th>Ação</th><th>' + (kind === 'kb' ? 'Tecla' : 'Botão') + ' 1</th><th>' + (kind === 'kb' ? 'Tecla' : 'Botão') + ' 2</th></tr>';
      for (const [id, label] of ACTIONS) {
        const tr = document.createElement('tr'); tr.dataset.act = id;
        const td0 = document.createElement('td'); td0.textContent = label; tr.appendChild(td0);
        for (let slot = 0; slot < 2; slot++) {
          const td = document.createElement('td');
          const btn = document.createElement('button'); btn.className = 'bind';
          const v = S[kind][id][slot];
          btn.innerHTML = '<span></span><span class="x" title="Apagar">✕</span>';
          btn.firstChild.textContent = v ? (kind === 'kb' ? keyName(v) : padName(v)) : '—';
          if (!v) { btn.classList.add('empty'); btn.lastChild.style.visibility = 'hidden'; }
          btn.addEventListener('click', (e) => {
            if (e.target.classList.contains('x')) { S[kind][id].splice(slot, 1); saveSettings(); buildBindTables(); renderKeyHelp(); return; }
            startCapture(kind, id, slot, btn);
          });
          td.appendChild(btn); tr.appendChild(td);
        }
        tb.appendChild(tr);
      }
    }
  }
  function startCapture(kind, act, slot, el) {
    endCapture();
    capture = { kind, act, slot, el, t: performance.now(), base: kind === 'gp' ? padSnapshot(getPads()) : null };
    el.classList.add('wait'); el.firstChild.textContent = kind === 'kb' ? 'Aperte uma tecla…' : 'Aperte no controle…';
    if (kind === 'gp' && !getPads().length) toast('Nenhum controle detectado. Conecte e aperte qualquer botão nele.');
  }
  function endCapture() { if (capture) { capture.el.classList.remove('wait'); capture = null; buildBindTables(); } }
  function padSnapshot(pads) {
    const s = new Set();
    for (const gp of pads) { gp.buttons.forEach((b, i) => { if (b.pressed || b.value > 0.5) s.add('b' + i); }); gp.axes.forEach((a, i) => { if (a < -0.6) s.add('a' + i + '-'); if (a > 0.6) s.add('a' + i + '+'); }); }
    return s;
  }
  function checkPadCapture(pads) {
    const now = padSnapshot(pads);
    for (const b of now) if (!capture.base.has(b)) { assignBinding('gp', capture.act, capture.slot, b); return; }
    for (const b of Array.from(capture.base)) if (!now.has(b)) capture.base.delete(b);
    if (performance.now() - capture.t > 12000) endCapture();
  }
  function assignBinding(kind, act, slot, code) {
    let moved = '';
    for (const [id, label] of ACTIONS) {
      if (id === act) continue;
      const i = S[kind][id].indexOf(code);
      if (i >= 0) { S[kind][id].splice(i, 1); moved = label; }
    }
    const list = S[kind][act];
    const j = list.indexOf(code); if (j >= 0) list.splice(j, 1);
    if (slot >= list.length) list.push(code); else list[slot] = code;
    if (list.length > 2) list.length = 2;
    capture.el.classList.remove('wait'); capture = null;
    saveSettings(); buildBindTables(); renderKeyHelp();
    kbDown.clear();
    if (moved) toast(`${kind === 'kb' ? keyName(code) : padName(code)} saiu de “${moved}”`);
  }
  $('#kbReset').addEventListener('click', () => { S.kb = clone(DEF_KB); saveSettings(); buildBindTables(); renderKeyHelp(); toast('Teclado restaurado'); });
  $('#gpReset').addEventListener('click', () => { S.gp = clone(DEF_GP); saveSettings(); buildBindTables(); toast('Gamepad restaurado'); });
  $('#btnResetAll').addEventListener('click', () => { S = clone(DEFAULTS); saveSettings(); applySettings(); buildBindTables(); toast('Configurações restauradas'); });

  function updatePadList() {
    const pads = getPads(), el = $('#padList');
    el.innerHTML = '';
    if (!pads.length) { const d = document.createElement('div'); d.className = 'none'; d.textContent = 'Nenhum controle detectado. Conecte por USB ou Bluetooth e aperte qualquer botão.'; el.appendChild(d); return; }
    for (const gp of pads) { const d = document.createElement('div'); d.className = 'pad'; d.textContent = '● ' + gp.id.replace(/\(.*?Vendor.*?\)/i, '').trim() + (gp.mapping === 'standard' ? '' : ' (mapeamento não padrão: configure abaixo)'); el.appendChild(d); }
  }
  window.addEventListener('gamepadconnected', (e) => { toast('Controle conectado: ' + e.gamepad.id.split('(')[0].trim()); if (settingsOpen()) updatePadList(); });
  window.addEventListener('gamepaddisconnected', () => { toast('Controle desconectado'); if (settingsOpen()) updatePadList(); });
  setInterval(() => {
    if (!settingsOpen()) return;
    for (const tr of $$('table.binds tr[data-act]')) tr.classList.toggle('live', !!actState[tr.dataset.act]);
  }, 100);

  // campos simples
  const speedOpts = [[2, '2x'], [3, '3x'], [4, '4x'], [6, '6x'], [8, '8x'], [16, '16x'], [0, 'Máxima']];
  for (const sel of [$('#ffSpeed'), $('#ffSpeed2')]) for (const [v, t] of speedOpts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  for (const sel of [$('#filter'), $('#filterQuick')]) for (const [v, t] of Renderer.FILTERS) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  $('#filterQuick').addEventListener('change', (e) => setFilter(e.target.value));
  const bindField = (sel, key, num) => $(sel).addEventListener(sel.startsWith('#touch') || sel === '#deadzone' ? 'input' : 'change', (e) => { S[key] = num ? +e.target.value : e.target.value; saveSettings(); applySettings(); });
  $('#filter').addEventListener('change', (e) => setFilter(e.target.value)); bindField('#fit', 'fit'); bindField('#cc', 'cc', 1); bindField('#ffAudio', 'ffAudio', 1);
  bindField('#turboRate', 'turboRate', 1); bindField('#showFps', 'showFps', 1); bindField('#touchMode', 'touchMode');
  bindField('#touchSize', 'touchSize', 1); bindField('#touchOpacity', 'touchOpacity', 1); bindField('#haptics', 'haptics', 1); bindField('#deadzone', 'deadzone', 1);
  bindField('#ffSpeed', 'ffSpeed', 1); bindField('#ffSpeed2', 'ffSpeed', 1);

  function applySettings() {
    $('#filter').value = S.filter; $('#filterQuick').value = S.filter;
    $('#qUp').textContent = S.filter === 'sharp' ? 'Upscaling: desligado' : 'Upscaling: ligado'; $('#fit').value = S.fit; $('#cc').value = String(S.cc);
    $('#ffSpeed').value = String(S.ffSpeed); $('#ffSpeed2').value = String(S.ffSpeed); $('#ffAudio').value = String(S.ffAudio);
    $('#turboRate').value = String(S.turboRate); $('#showFps').value = String(S.showFps);
    $('#touchMode').value = S.touchMode; $('#touchSize').value = S.touchSize; $('#touchOpacity').value = S.touchOpacity; $('#haptics').value = String(S.haptics);
    $('#deadzone').value = S.deadzone; $('#vol').value = S.volume;
    $('#btnMute').textContent = S.muted ? '🔇' : '🔊';
    renderer.setFilter(S.filter); renderer.colorCorrect = !!S.cc;
    document.documentElement.style.setProperty('--ts', S.touchSize / 100);
    document.documentElement.style.setProperty('--to', S.touchOpacity / 100);
    updateTouchMode(); updateFFUI(); renderKeyHelp(); fitScreen();
    if (running && paused) renderer.draw();
  }
  function renderKeyHelp() {
    const el = $('#keyHelp'); el.innerHTML = '';
    const show = [['up', 'Direcional', ['up', 'down', 'left', 'right']], ['a', 'A'], ['b', 'B'], ['l', 'L'], ['r', 'R'], ['start', 'Start'], ['select', 'Select'], ['ffHold', 'Acelerar (segurar)'], ['ffToggle', 'Acelerar (liga/desliga)'], ['turboA', 'Turbo A / B', ['turboA', 'turboB']], ['saveState', 'Salvar / carregar estado', ['saveState', 'loadState']], ['menu', 'Menu']];
    for (const [id, label, group] of show) {
      const ids = group || [id];
      const txt = ids.map(i => keyName(S.kb[i][0]) || '—').join(group && group.length === 4 ? ' ' : ' / ');
      const k = document.createElement('kbd'); k.textContent = txt;
      const s = document.createElement('span'); s.textContent = label;
      el.appendChild(k); el.appendChild(s);
    }
  }

  // ---------- menu rápido ----------
  function openQuick() { $('#quick').classList.add('open'); }
  function closeQuick() { $('#quick').classList.remove('open'); }
  $('#quick').addEventListener('pointerdown', (e) => { if (e.target.id === 'quick') closeQuick(); });
  $$('#quick [data-q]').forEach(b => b.addEventListener('click', () => {
    const q = b.dataset.q; closeQuick();
    if (q === 'pause') togglePause(); else if (q === 'ff') toggleFF(); else if (q === 'save') saveState(); else if (q === 'load') loadState();
    else if (q === 'up') toggleUpscale();
    else if (q === 'full') toggleFullscreen(); else if (q === 'shot') screenshot(); else if (q === 'open') pickRom(); else if (q === 'reset') resetGame(); else if (q === 'settings') openSettings();
  }));

  // Controles de toque: cada dedo (pointerId) guarda os botões que está apertando.
  // O direcional calcula a direção pela posição do dedo em relação ao centro (permite diagonais e deslizar).
  // Na área A/B, tocar no meio aperta os dois.
  // ---------- controles de toque ----------
  const touchPtr = new Map(); // pointerId -> bits
  function touchRecalc() {
    let b = 0; for (const v of touchPtr.values()) b |= v;
    touchBits = b; applyKeys();
    const pad = $('.dpad');
    pad.classList.toggle('u', !!(b & 64)); pad.classList.toggle('d', !!(b & 128)); pad.classList.toggle('l', !!(b & 32)); pad.classList.toggle('r', !!(b & 16));
    $('.abzone .a').classList.toggle('on', !!(b & 1)); $('.abzone .b').classList.toggle('on', !!(b & 2));
  }
  // Converte a posição do dedo em botões apertados (direcional ou A/B).
  function zoneBits(el, x, y) {
    if (el.dataset.zone === 'dpad') {
      const r = el.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
      const dead = r.width * 0.12; let b = 0;
      if (dx > dead) b |= 16; if (dx < -dead) b |= 32; if (dy < -dead) b |= 64; if (dy > dead) b |= 128;
      if (Math.abs(dx) > Math.abs(dy) * 2.2) b &= ~(64 | 128);
      if (Math.abs(dy) > Math.abs(dx) * 2.2) b &= ~(16 | 32);
      return b;
    }
    const ra = el.querySelector('.a').getBoundingClientRect(), rb = el.querySelector('.b').getBoundingClientRect();
    const da = Math.hypot(x - (ra.left + ra.width / 2), y - (ra.top + ra.height / 2)) / (ra.width / 2);
    const db = Math.hypot(x - (rb.left + rb.width / 2), y - (rb.top + rb.height / 2)) / (rb.width / 2);
    if (da < 1.25 && db < 1.25) return 3;
    return da < db ? 1 : 2;
  }
  function buzz() { if (S.haptics && navigator.vibrate) try { navigator.vibrate(8); } catch (_) { } }
  $$('#touch .zone').forEach(el => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); initAudio(); try { el.setPointerCapture(e.pointerId); } catch (_) { } touchPtr.set(e.pointerId, zoneBits(el, e.clientX, e.clientY)); touchRecalc(); buzz(); });
    el.addEventListener('pointermove', (e) => { if (!touchPtr.has(e.pointerId)) return; const nb = zoneBits(el, e.clientX, e.clientY); if (nb !== touchPtr.get(e.pointerId)) { touchPtr.set(e.pointerId, nb); touchRecalc(); buzz(); } });
    const up = (e) => { if (touchPtr.delete(e.pointerId)) touchRecalc(); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
  });
  $$('#touch [data-act]').forEach(el => {
    const bit = ACTIONS.find(a => a[0] === el.dataset.act)[2];
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); initAudio(); try { el.setPointerCapture(e.pointerId); } catch (_) { } touchPtr.set(e.pointerId, 1 << bit); el.classList.add('on'); touchRecalc(); buzz(); });
    const up = (e) => { if (touchPtr.delete(e.pointerId)) { el.classList.remove('on'); touchRecalc(); } };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
  });
  $$('#touch [data-cmd]').forEach(el => el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); initAudio(); buzz();
    if (el.dataset.cmd === 'menu') openQuick(); else toggleFF();
  }));
  $('#touch').addEventListener('contextmenu', (e) => e.preventDefault());
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  function updateTouchMode() {
    const on = S.touchMode === 'on' || (S.touchMode === 'auto' && coarse);
    document.body.classList.toggle('touch', on);
    updateOrientation();
  }
  function updateOrientation() {
    const land = window.innerWidth > window.innerHeight && document.body.classList.contains('touch') && window.innerHeight < 700;
    document.body.classList.toggle('land', land);
    fitScreen();
  }
  window.addEventListener('orientationchange', () => setTimeout(updateOrientation, 200));

  // ---------- tela ----------
  // Calcula o tamanho da imagem na tela (preencher, escala inteira ou esticar) e manda o
  // renderizador desenhar na resolução real do monitor (pixels CSS × devicePixelRatio).
  function fitScreen() {
    const stage = $('#stage');
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    let cw, ch;
    if (S.fit === 'stretch') { cw = w; ch = h; }
    else {
      const dpr = window.devicePixelRatio || 1;
      let s = Math.min(w / 240, h / 160);
      if (S.fit === 'integer') { const sp = Math.floor(s * dpr); s = Math.max(1, sp) / dpr; }
      cw = 240 * s; ch = 160 * s;
    }
    canvas.style.width = Math.floor(cw) + 'px';
    canvas.style.height = Math.floor(ch) + 'px';
    renderer.resize(Math.floor(cw), Math.floor(ch));
    $('#resNote').textContent = `Resolução de saída agora: ${renderer.outW}×${renderer.outH} pixels (${(renderer.outW / 240).toFixed(1)}× o original)` + (renderer.gl ? '' : ' · WebGL indisponível: filtros limitados');
    if (running) renderer.draw();
  }
  window.addEventListener('resize', () => { updateOrientation(); });
  document.addEventListener('fullscreenchange', fitScreen);
  new ResizeObserver(fitScreen).observe($('#stage'));

  // salvar ao sair
  document.addEventListener('visibilitychange', () => { if (document.hidden) { flushSaveLocalSync(); flushSave(); } });
  window.addEventListener('pagehide', () => { flushSaveLocalSync(); });

  window.__emu = { settings: () => S, renderer, workerMode: () => workerMode, game };
  Store.init();
  applySettings();
  updateCloudBadge();
  loadCloudSettings();
  renderer.draw();
})();

'use strict';
// =====================================================================
// engine.js — O MOTOR (roda num Web Worker)
// =====================================================================
// O emulador roda num "fio" separado do navegador (Web Worker). Assim,
// gravar o save, mexer na interface ou desenhar a tela nunca atrasa o
// jogo. A página e o motor conversam por mensagens:
//   página → motor: load, keys, ff (acelerar), pause, reset, saveState,
//                   loadState, importSave, bios, getSave
//   motor → página: frame (imagem), audio (amostras), save (dados novos),
//                   stats (fps), info (título/tipo de save), reply, error
// Se o navegador não permitir o Worker, a página usa esta mesma função
// no fio principal.
// =====================================================================
// ===================== Motor de emulação (roda num Web Worker) =====================
// Transforma um save state em bytes: a estrutura vai como JSON e os arrays
// (memórias) vão em binário logo depois, sem conversão.
function packState(obj) {
  const bufs = []; let off = 0;
  const json = JSON.stringify(obj, (k, v) => {
    if (ArrayBuffer.isView(v)) { const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice(); bufs.push(u); const d = { __ta: v.constructor.name, o: off, n: u.length }; off += u.length; return d; }
    return v;
  });
  const js = new TextEncoder().encode(json);
  const out = new Uint8Array(4 + js.length + off);
  new DataView(out.buffer).setUint32(0, js.length, true);
  out.set(js, 4); let p = 4 + js.length; for (const b of bufs) { out.set(b, p); p += b.length; }
  return out;
}
// Caminho inverso: lê o JSON e recria cada array a partir dos bytes.
function unpackState(u8) {
  const jl = new DataView(u8.buffer, u8.byteOffset).getUint32(0, true);
  const json = new TextDecoder().decode(u8.subarray(4, 4 + jl));
  const base = 4 + jl;
  const TA = { Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray };
  return JSON.parse(json, (k, v) => (v && v.__ta) ? new TA[v.__ta](u8.slice(base + v.o, base + v.o + v.n).buffer) : v);
}

function createEngine(post) {
  const gba = new GBA();
  gba.log = (m) => post({ t: 'log', m });
  const FRAME_MS = 1000 / 59.7275;
  let running = false, paused = false, ff = false, mult = 1, ffAudio = true;
  let acc = 0, last = 0, timer = null, emuFrames = 0, statT = 0, saveT = 0, frameNo = 0;
  // áudio: junta várias amostras em uma quando acelerado
  // Áudio: no acelerar, juntamos várias amostras em uma (média de "decim" amostras).
  // O som sai acelerado, mas contínuo, sem picotar.
  let abuf = new Float32Array(4096), an = 0, decim = 1, dA = 0, dL = 0, dR = 0, audioOn = true;
  gba.apu.out = (l, r) => {
    if (!audioOn) return;
    dL += l; dR += r;
    if (++dA < decim) return;
    abuf[an++] = dL / dA; abuf[an++] = dR / dA; dL = dR = 0; dA = 0;
    if (an >= abuf.length) flushAudio();
  };
  function flushAudio() {
    if (!an) return;
    const out = abuf.slice(0, an); an = 0;
    post({ t: 'audio', d: out }, [out.buffer]);
  }
  // Envia uma cópia da imagem (240×160×4 bytes) para a página desenhar.
  function sendFrame() {
    const f = new Uint8Array(gba.ppu.frameBuf).slice();
    post({ t: 'frame', d: f.buffer }, [f.buffer]);
  }
  // Se o jogo gravou algo no save, envia uma cópia para a página guardar (no máximo 1 vez por segundo).
  function sendSave(force) {
    if (!gba.save.data.length) return;
    if (!force && !gba.save.dirty) return;
    gba.save.dirty = false;
    const d = gba.save.data.slice();
    post({ t: 'save', d }, [d.buffer]);
  }
  function schedule(ms) { if (timer === null) timer = setTimeout(loop, ms); }
  // Laço principal do motor. Em velocidade normal, roda os quadros que já deveriam
  // ter acontecido pelo relógio (59,73 por segundo). No acelerar, roda "mult" vezes mais.
  // "budget" (15 ms) limita o trabalho por volta para nunca travar.
  function loop() {
    timer = null;
    if (!running || paused) { last = 0; return; }
    const now = performance.now();
    const dt = last ? Math.min(100, now - last) : FRAME_MS; last = now;
    const m = ff ? mult : 1; // 0 = máxima
    // No acelerar, só desenha 1 a cada "skip" quadros: os outros nem chegariam à tela. Isso dobra a velocidade possível.
    const skip = ff ? (m ? Math.max(1, Math.min(8, Math.round(m))) : 8) : 1;
    const budget = 15;
    let n = 0, drew = false;
    try {
      const step = () => { frameNo++; const r = frameNo % skip === 0; gba.runFrame(r); if (r) drew = true; n++; emuFrames++; };
      if (m === 0) { do step(); while (performance.now() - now < budget); acc = 0; }
      else {
        acc += dt * m;
        while (acc >= FRAME_MS) {
          step(); acc -= FRAME_MS;
          if (performance.now() - now > budget) { acc = Math.min(acc, FRAME_MS); break; }
        }
      }
    } catch (e) {
      running = false; post({ t: 'error', m: String(e && e.message || e) }); return;
    }
    if (drew) sendFrame();
    flushAudio();
    if (now - statT > 1000) {
      const fps = statT ? emuFrames * 1000 / (now - statT) : 0;
      emuFrames = 0; statT = now;
      post({ t: 'stats', fps });
      if (ff) { audioOn = ffAudio; decim = Math.max(1, Math.round(m ? m : fps / 59.73)); }
    }
    if (now - saveT > 1000) { saveT = now; sendSave(false); }
    const elapsed = performance.now() - now;
    schedule(ff ? 1 : Math.max(1, Math.min(FRAME_MS, FRAME_MS - acc) - elapsed * 0));
  }

  // O que o motor faz ao receber cada mensagem da página.
  const handlers = {
    load(msg) {
      gba.loadRom(new Uint8Array(msg.rom));
      if (msg.save && gba.save.data.length) gba.save.data.set(new Uint8Array(msg.save).subarray(0, gba.save.data.length));
      gba.save.dirty = false;
      running = true; paused = false; acc = 0; last = 0; an = 0;
      post({ t: 'info', title: gba.title, code: gba.code, saveType: gba.save.type, saveSize: gba.save.data.length });
      schedule(1);
    },
    keys(msg) { gba.setKeys(msg.v); },
    ff(msg) {
      ff = !!msg.on; mult = msg.mult; ffAudio = !!msg.audio;
      if (ff) { audioOn = ffAudio; decim = Math.max(1, mult || 4); } else { audioOn = true; decim = 1; dA = 0; dL = dR = 0; }
    },
    pause(msg) { paused = !!msg.v; if (paused) sendSave(false); else { last = 0; schedule(1); } },
    reset() { const keep = gba.save.data.slice(); gba.reset(); gba.save.data.set(keep); },
    getSave(msg) { post({ t: 'reply', id: msg.id, d: gba.save.data.slice() }); },
    flushSave() { sendSave(false); },
    saveState(msg) {
      try { const d = packState(gba.saveState()); post({ t: 'reply', id: msg.id, d, code: gba.code }, [d.buffer]); }
      catch (e) { post({ t: 'reply', id: msg.id, err: String(e.message || e) }); }
    },
    loadState(msg) {
      try {
        const st = unpackState(new Uint8Array(msg.d));
        if (st.code !== gba.code) { post({ t: 'reply', id: msg.id, err: 'Esse estado é de outro jogo' }); return; }
        gba.loadState(st); post({ t: 'reply', id: msg.id, ok: true });
      } catch (e) { post({ t: 'reply', id: msg.id, err: String(e.message || e) }); }
    },
    importSave(msg) {
      const d = new Uint8Array(msg.d);
      gba.save.data.fill(0xFF); gba.save.data.set(d.subarray(0, gba.save.data.length));
      const keep = gba.save.data.slice(); gba.reset(); gba.save.data.set(keep);
      gba.save.dirty = true; sendSave(false);
    },
    bios(msg) { if (msg.d) gba.bus.loadRealBios(new Uint8Array(msg.d)); else gba.bus.installHleBios(); },
  };
  return { gba, handle(msg) { const h = handlers[msg.t]; if (h) h(msg); } };
}

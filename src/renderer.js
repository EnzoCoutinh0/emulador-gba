'use strict';
// =====================================================================
// renderer.js — MOSTRAR A IMAGEM E FAZER O UPSCALING
// =====================================================================
// A imagem de 240×160 vai para a placa de vídeo (WebGL) como uma textura.
// Pequenos programas da placa de vídeo (shaders) calculam a cor de cada
// pixel da tela na resolução real do monitor (até 4K ou mais). O filtro
// escolhido define como os pixels são ampliados:
//   • Original (sharp) — sem upscaling: pixels quadrados e nítidos,
//     sem tremidos mesmo quando a escala não é inteira.
//   • xBR — detecta bordas e curvas e as redesenha lisas.
//   • Scale2x/Scale4x — dobram a resolução 1 ou 2 vezes arredondando cantos.
//   • Suave, LCD e CRT — borrão leve, grade de LCD e linhas de TV antiga.
// Sem WebGL, cai para um canvas 2D simples.
// =====================================================================
// ===================== Renderizador (WebGL + filtros de upscaling) =====================
class Renderer {
  constructor(canvas, frameBuf) {
    this.canvas = canvas;
    this.src = new Uint8Array(frameBuf);
    this.filter = 'sharp';
    this.colorCorrect = false;
    this.outW = 240; this.outH = 160;
    this.gl = null;
    try {
      this.gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch (e) { this.gl = null; }
    if (this.gl) { try { this.initGL(); } catch (e) { console.warn('WebGL falhou', e); this.gl = null; } }
    if (!this.gl) {
      this.ctx2d = canvas.getContext('2d');
      this.tmp = document.createElement('canvas'); this.tmp.width = 240; this.tmp.height = 160;
      this.tctx = this.tmp.getContext('2d');
      this.img = new ImageData(new Uint8ClampedArray(frameBuf), 240, 160);
    }
  }

  // Lista de opções mostrada na interface: [código, nome].
  static get FILTERS() {
    return [
      ['sharp', 'Original — sem upscaling'],
      ['xbr', 'Upscaling xBR — alta qualidade (recomendado)'],
      ['smooth', 'Upscaling suave (bilinear)'],
      ['scale2x', 'Upscaling Scale2x'],
      ['scale4x', 'Upscaling Scale4x'],
      ['scale4xs', 'Upscaling Scale4x + suavização'],
      ['lcd', 'Efeito grade de LCD (como o GBA)'],
      ['crt', 'Efeito TV antiga (CRT)'],
    ];
  }

  initGL() {
    const gl = this.gl;
    // Vertex shader: desenha um retângulo que cobre a tela toda e passa a coordenada (uv) de cada pixel.
    const vs = `attribute vec2 p; varying vec2 uv; void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
    const vsFbo = `attribute vec2 p; varying vec2 uv; void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;
    // Código comum aos filtros finais:
    // correct() = correção de cor que imita a tela escura e desbotada do GBA original;
    // sharpSample() = "sharp bilinear": pixels nítidos em qualquer escala, suavizando só a borda entre eles.
    const head = `precision highp float; varying vec2 uv; uniform sampler2D tex; uniform vec2 size; uniform vec2 outSize; uniform float cc;
      vec3 correct(vec3 c){ if (cc < 0.5) return c; c = pow(c, vec3(2.2 + 0.3));
        mat3 m = mat3(0.80, 0.135, 0.195,  0.275, 0.64, 0.155,  -0.075, 0.225, 0.65);
        c = clamp(m * c * 0.95, 0.0, 1.0); return pow(c, vec3(1.0/2.2)); }
      vec4 sharpSample(vec2 t){ vec2 texel = t*size; vec2 sc = max(floor(outSize/size), vec2(1.0));
        vec2 tf = floor(texel); vec2 s = fract(texel); vec2 rr = 0.5 - 0.5/sc; vec2 cd = s - 0.5;
        vec2 f = (cd - clamp(cd, -rr, rr)) * sc + 0.5; return texture2D(tex, (tf + f)/size); }`;
    // Scale2x (EPX): cada pixel vira 4. Se os vizinhos de cima e da esquerda são iguais
    // (e diferentes dos outros), o canto vira a cor deles. Isso arredonda diagonais.
    // Aplicado 2 vezes = Scale4x.
    const fsScale2x = `precision highp float; varying vec2 uv; uniform sampler2D tex; uniform vec2 size;
      bool eq(vec3 a, vec3 b){ return all(lessThan(abs(a-b), vec3(0.02))); }
      void main(){ vec2 px = uv*size*2.0; vec2 ip = floor(px/2.0); vec2 f = px/2.0 - ip; vec2 d = 1.0/size; vec2 c = (ip+0.5)*d;
        vec3 E = texture2D(tex,c).rgb; vec3 B = texture2D(tex,c-vec2(0.0,d.y)).rgb; vec3 H = texture2D(tex,c+vec2(0.0,d.y)).rgb;
        vec3 D = texture2D(tex,c-vec2(d.x,0.0)).rgb; vec3 F = texture2D(tex,c+vec2(d.x,0.0)).rgb; vec3 r = E;
        if (!eq(B,H) && !eq(D,F)) {
          if (f.x < 0.5 && f.y < 0.5) { if (eq(D,B)) r = D; }
          else if (f.x >= 0.5 && f.y < 0.5) { if (eq(B,F)) r = F; }
          else if (f.x < 0.5) { if (eq(D,H)) r = D; }
          else { if (eq(H,F)) r = F; } }
        gl_FragColor = vec4(r,1.0); }`;
    // Filtros de um passo só: original (sharp), suave, grade de LCD e CRT.
    const fsFinal = {
      sharp: head + `void main(){ gl_FragColor = vec4(correct(sharpSample(uv).rgb),1.0); }`,
      smooth: head + `void main(){ gl_FragColor = vec4(correct(texture2D(tex,uv).rgb),1.0); }`,
      lcd: head + `void main(){ vec3 c = correct(sharpSample(uv).rgb); vec2 f = fract(uv*size); vec2 sc = outSize/size;
          vec2 e = smoothstep(vec2(0.0), vec2(1.6)/sc, f) * smoothstep(vec2(0.0), vec2(1.6)/sc, 1.0-f);
          float g = mix(0.72, 1.0, e.x*e.y); gl_FragColor = vec4(c*g*1.08,1.0); }`,
      crt: head + `void main(){ vec2 t = uv*size; float y = fract(t.y); vec2 s = vec2(uv.x, (floor(t.y)+0.5)/size.y);
          vec3 c = correct(texture2D(tex, s).rgb); c = pow(c, vec3(1.15));
          float sl = 0.42 + 0.58*pow(sin(y*3.14159), 1.3); float mx = mod(gl_FragCoord.x, 3.0);
          vec3 mask = mx < 1.0 ? vec3(1.06,0.94,0.94) : (mx < 2.0 ? vec3(0.94,1.06,0.94) : vec3(0.94,0.94,1.06));
          vec2 v = uv - 0.5; float vig = 1.0 - dot(v,v)*0.45;
          gl_FragColor = vec4(c*sl*mask*vig*1.35,1.0); }`,
    };
    // xBR nível 2 (algoritmo de Hyllian): olha 21 pixels em volta, compara a
    // "distância" das cores nas duas diagonais e descobre se há uma borda a 30°, 45°
    // ou 60° passando pelo pixel. Se houver, mistura a cor do vizinho com uma
    // transição suave (smoothstep), cuja largura (delta) depende da escala da tela.
    const fsXbr = head + `
      const vec3 rgbw = vec3(14.352, 28.176, 5.472);
      const vec4 Ao = vec4(1.0, -1.0, -1.0, 1.0), Bo = vec4(1.0, 1.0, -1.0, -1.0), Co = vec4(1.5, 0.5, -0.5, 0.5);
      const vec4 Ax = vec4(1.0, -1.0, -1.0, 1.0), Bx = vec4(0.5, 2.0, -0.5, -2.0), Cx = vec4(1.0, 1.0, -0.5, 0.0);
      const vec4 Ay = vec4(1.0, -1.0, -1.0, 1.0), By = vec4(2.0, 0.5, -2.0, -0.5), Cy = vec4(2.0, 0.0, -1.0, 0.5);
      vec4 eqv(vec4 a, vec4 b) { return vec4(lessThan(abs(a - b), vec4(15.0))); }
      vec4 nev(vec4 a, vec4 b) { return vec4(notEqual(a, b)); }
      vec4 orv(vec4 a, vec4 b) { return clamp(a + b, 0.0, 1.0); }
      vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) { return abs(a-b) + abs(a-c) + abs(d-e) + abs(d-f) + 4.0*abs(g-h); }
      float cdf(vec3 a, vec3 b) { vec3 d = abs(a - b); return d.r + d.g + d.b; }
      vec3 T(vec2 p) { return texture2D(tex, p).rgb; }
      void main() {
        vec2 px = uv * size; vec2 fp = fract(px); vec2 tc = (floor(px) + 0.5) / size;
        vec2 dx = vec2(1.0 / size.x, 0.0), dy = vec2(0.0, 1.0 / size.y);
        vec3 A1 = T(tc - dx - 2.0*dy), B1 = T(tc - 2.0*dy), C1 = T(tc + dx - 2.0*dy);
        vec3 A0 = T(tc - 2.0*dx - dy), A = T(tc - dx - dy), B = T(tc - dy), C = T(tc + dx - dy), C4 = T(tc + 2.0*dx - dy);
        vec3 D0 = T(tc - 2.0*dx), D = T(tc - dx), E = T(tc), F = T(tc + dx), F4 = T(tc + 2.0*dx);
        vec3 G0 = T(tc - 2.0*dx + dy), G = T(tc - dx + dy), H = T(tc + dy), I = T(tc + dx + dy), I4 = T(tc + 2.0*dx + dy);
        vec3 G5 = T(tc - dx + 2.0*dy), H5 = T(tc + 2.0*dy), I5 = T(tc + dx + 2.0*dy);
        vec4 b = vec4(dot(B, rgbw), dot(D, rgbw), dot(H, rgbw), dot(F, rgbw));
        vec4 c = vec4(dot(C, rgbw), dot(A, rgbw), dot(G, rgbw), dot(I, rgbw));
        vec4 e = vec4(dot(E, rgbw));
        vec4 d = b.yzwx, f = b.wxyz, g = c.zwxy, h = b.zwxy, i = c.wxyz;
        vec4 i4 = vec4(dot(I4, rgbw), dot(C1, rgbw), dot(A0, rgbw), dot(G5, rgbw));
        vec4 i5 = vec4(dot(I5, rgbw), dot(C4, rgbw), dot(A1, rgbw), dot(G0, rgbw));
        vec4 h5 = vec4(dot(H5, rgbw), dot(F4, rgbw), dot(B1, rgbw), dot(D0, rgbw));
        vec4 f4 = h5.yzwx;
        vec4 fx = Ao * fp.y + Bo * fp.x, fxl = Ax * fp.y + Bx * fp.x, fxu = Ay * fp.y + By * fp.x;
        vec4 delta = vec4(clamp(size.x / outSize.x * 1.5, 0.02, 0.5));
        vec4 r0 = nev(e, f) * nev(e, h);
        vec4 r1 = r0 * orv(orv(orv((1.0 - eqv(f, b)) * (1.0 - eqv(f, c)), (1.0 - eqv(h, d)) * (1.0 - eqv(h, g))),
                   eqv(e, i) * orv((1.0 - eqv(f, f4)) * (1.0 - eqv(f, i4)), (1.0 - eqv(h, h5)) * (1.0 - eqv(h, i5)))), orv(eqv(e, g), eqv(e, c)));
        vec4 r2l = nev(e, g) * nev(d, g), r2u = nev(e, c) * nev(b, c);
        vec4 fx45 = smoothstep(Co - delta, Co + delta, fx), fx30 = smoothstep(Cx - delta, Cx + delta, fxl), fx60 = smoothstep(Cy - delta, Cy + delta, fxu);
        vec4 edr = vec4(lessThan(wd(e, c, g, i, h5, f4, h, f), wd(h, d, i5, f, i4, b, e, i))) * r1;
        vec4 edrl = vec4(lessThanEqual(2.0 * abs(f - g), abs(h - c))) * r2l;
        vec4 edru = vec4(greaterThanEqual(abs(f - g), 2.0 * abs(h - c))) * r2u;
        vec4 w = max(max(edr * edrl * fx30, edr * edru * fx60), edr * fx45);
        vec4 pxs = vec4(lessThanEqual(abs(e - f), abs(e - h)));
        vec3 res1 = E; res1 = mix(res1, mix(H, F, pxs.x), w.x); res1 = mix(res1, mix(B, D, pxs.z), w.z);
        vec3 res2 = E; res2 = mix(res2, mix(F, B, pxs.y), w.y); res2 = mix(res2, mix(D, H, pxs.w), w.w);
        vec3 res = mix(res1, res2, step(cdf(E, res1), cdf(E, res2)));
        gl_FragColor = vec4(correct(res), 1.0);
      }`;
    const mk = (vsrc, fsrc) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vsrc], [gl.FRAGMENT_SHADER, fsrc]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      }
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return { p, tex: gl.getUniformLocation(p, 'tex'), size: gl.getUniformLocation(p, 'size'), outSize: gl.getUniformLocation(p, 'outSize'), cc: gl.getUniformLocation(p, 'cc') };
    };
    this.progs = {};
    for (const k in fsFinal) this.progs[k] = mk(vs, fsFinal[k]);
    this.progs.xbr = mk(vs, fsXbr);
    this.progScale = mk(vsFbo, fsScale2x);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const mkTex = (w, h) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    };
    this.mkTex = mkTex;
    this.texSrc = mkTex(240, 160);
    // Texturas intermediárias de 480×320 e 960×640 para os passes do Scale2x/Scale4x.
    this.fbo = [];
    for (const [w, h] of [[480, 320], [960, 640]]) {
      const t = mkTex(w, h), f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fbo.push({ t, f, w, h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setFilter(f) { this.filter = f; }
  // desenha uma vez num tamanho fixo (ex.: 3840×2560) e devolve um PNG
  capture(w, h) {
    const ow = this.canvas.width, oh = this.canvas.height, oW = this.outW, oH = this.outH;
    const maxTex = this.gl ? this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) : 4096;
    if (w > maxTex) { h = Math.round(h * maxTex / w); w = maxTex; }
    this.canvas.width = w; this.canvas.height = h; this.outW = w; this.outH = h;
    this.draw();
    const url = this.canvas.toDataURL('image/png');
    this.canvas.width = ow; this.canvas.height = oh; this.outW = oW; this.outH = oH;
    this.draw();
    return { url, w, h };
  }
  setFrame(buf) {
    this.src = new Uint8Array(buf);
    if (!this.gl) this.img = new ImageData(new Uint8ClampedArray(buf), 240, 160);
  }

  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 4);
    let w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    const max = 8192; if (w > max) { h = Math.round(h * max / w); w = max; }
    if (w < 1 || h < 1) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.outW = w; this.outH = h;
  }

  draw() {
    const gl = this.gl;
    if (!gl) {
      const c = this.ctx2d;
      this.tctx.putImageData(this.img, 0, 0);
      c.imageSmoothingEnabled = this.filter === 'smooth';
      c.drawImage(this.tmp, 0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 240, 160, gl.RGBA, gl.UNSIGNED_BYTE, this.src);
    let tex = this.texSrc, w = 240, h = 160;
    const f = this.filter;
    // Desenho: envia a imagem nova, aplica os passes de Scale2x se houver e o filtro final na resolução da tela.
    const passes = f === 'scale2x' ? 1 : (f === 'scale4x' || f === 'scale4xs') ? 2 : 0;
    for (let i = 0; i < passes; i++) {
      const fb = this.fbo[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.f); gl.viewport(0, 0, fb.w, fb.h);
      const P = this.progScale; gl.useProgram(P.p);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(P.tex, 0); gl.uniform2f(P.size, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      tex = fb.t; w = fb.w; h = fb.h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.outW, this.outH);
    const key = passes ? (f === 'scale4xs' ? 'smooth' : 'sharp') : f;
    const P = this.progs[key] || this.progs.sharp;
    gl.useProgram(P.p);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const linear = key !== 'xbr';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.uniform1i(P.tex, 0); gl.uniform2f(P.size, w, h); gl.uniform2f(P.outSize, this.outW, this.outH);
    gl.uniform1f(P.cc, this.colorCorrect ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // os passes intermediários precisam de NEAREST como entrada
    if (passes) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); }
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
}

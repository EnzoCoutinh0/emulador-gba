'use strict';
// =====================================================================
// accounts.js — CONTAS E ARMAZENAMENTO LOCAL
// =====================================================================
// LocalDB: guarda tudo no IndexedDB do navegador (aguenta ROMs de 32 MB
// e muitos estados salvos). Se o IndexedDB não estiver disponível (ex.:
// navegação anônima em alguns navegadores), usa a memória e avisa.
//
// Accounts: contas locais. A senha nunca é guardada: guardamos só um
// "hash" PBKDF2-SHA256 (150 mil rodadas, com sal aleatório). Para
// conferir, recalculamos o hash da senha digitada e comparamos.
// Cada conta tem os próprios jogos, saves, estados e configurações,
// separados pelo prefixo "<id da conta>/" nas chaves.
// =====================================================================
const LocalDB = {
  db: null, mem: null, ok: false,
  STORES: ['accounts', 'roms', 'blobs', 'meta'],
  async open() {
    if (this.db || this.mem) return;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('gba-emulador', 1);
        r.onupgradeneeded = () => { for (const s of this.STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('IndexedDB bloqueado'));
      });
      this.ok = true;
    } catch (e) {
      console.warn('IndexedDB indisponível, usando memória', e);
      this.mem = {}; for (const s of this.STORES) this.mem[s] = new Map();
    }
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode), st = t.objectStore(store);
      const req = fn(st);
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  async get(store, key) { await this.open(); if (this.mem) return this.mem[store].get(key); return this.tx(store, 'readonly', s => s.get(key)); },
  async put(store, key, val) { await this.open(); if (this.mem) { this.mem[store].set(key, val); return; } return this.tx(store, 'readwrite', s => s.put(val, key)); },
  async del(store, key) { await this.open(); if (this.mem) { this.mem[store].delete(key); return; } return this.tx(store, 'readwrite', s => s.delete(key)); },
  // todas as chaves que começam com o prefixo (ex.: "enzo/")
  async keys(store, prefix) {
    await this.open();
    if (this.mem) return [...this.mem[store].keys()].filter(k => k.startsWith(prefix));
    return this.tx(store, 'readonly', s => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));
  },
  async delPrefix(store, prefix) { for (const k of await this.keys(store, prefix)) await this.del(store, k); },
};

const Accounts = {
  GUEST: { id: 'convidado', name: 'Convidado', guest: true },
  normalize(name) { return String(name || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_.-]/g, ''); },
  hex(buf) { return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join(''); },
  async hash(password, saltHex) {
    if (!(window.crypto && crypto.subtle)) throw new Error('Este navegador não tem a criptografia necessária para senhas');
    const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
    return this.hex(bits);
  },
  async list() {
    const ids = await LocalDB.keys('accounts', '');
    const out = [];
    for (const id of ids) { const a = await LocalDB.get('accounts', id); if (a) out.push({ id, name: a.name, last: a.last || 0 }); }
    return out.sort((a, b) => b.last - a.last);
  },
  async create(name, password) {
    const id = this.normalize(name);
    if (id.length < 3 || id.length > 20) throw new Error('O nome de usuário precisa ter de 3 a 20 letras ou números');
    if (id === this.GUEST.id) throw new Error('Esse nome é reservado');
    if (String(password).length < 4) throw new Error('A senha precisa ter pelo menos 4 caracteres');
    if (await LocalDB.get('accounts', id)) throw new Error('Já existe uma conta com esse nome neste navegador');
    const salt = this.hex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await this.hash(password, salt);
    await LocalDB.put('accounts', id, { name: String(name).trim().slice(0, 24), salt, hash, created: Date.now(), last: Date.now() });
    return { id, name: String(name).trim().slice(0, 24) };
  },
  async login(name, password) {
    const id = this.normalize(name);
    const a = await LocalDB.get('accounts', id);
    if (!a) throw new Error('Conta não encontrada neste navegador');
    if (await this.hash(password, a.salt) !== a.hash) throw new Error('Senha incorreta');
    a.last = Date.now(); await LocalDB.put('accounts', id, a);
    return { id, name: a.name };
  },
  async changePassword(id, oldPw, newPw) {
    const a = await LocalDB.get('accounts', id);
    if (!a || await this.hash(oldPw, a.salt) !== a.hash) throw new Error('Senha atual incorreta');
    if (String(newPw).length < 4) throw new Error('A senha nova precisa ter pelo menos 4 caracteres');
    a.salt = this.hex(crypto.getRandomValues(new Uint8Array(16)));
    a.hash = await this.hash(newPw, a.salt);
    await LocalDB.put('accounts', id, a);
  },
  // apaga a conta e tudo dela (jogos, saves, estados, configurações)
  async remove(id) {
    for (const s of ['roms', 'blobs', 'meta']) await LocalDB.delPrefix(s, id + '/');
    await LocalDB.del('accounts', id);
  },
};

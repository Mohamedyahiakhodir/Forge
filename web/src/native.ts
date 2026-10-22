// Bridge to the Kotlin layer (window.ForgeNative). Falls back to an in-memory mock so the
// web app can be developed in a desktop browser.

export interface Entry { name: string; isDir: boolean; size: number; mtime: number }
export interface Stat { exists: boolean; isDir: boolean; size: number; mtime: number }
export interface KeyMeta { alias: string; subject: string; sha256: string; sha1: string; notAfter: number; created: number }
export interface Match { path: string; line: number; col: number; len: number; text: string }

declare global {
  interface Window {
    ForgeNative?: Record<string, (...a: any[]) => string>;
    __forgeEvent?: (name: string, payload: string) => void;
    __forgeBack?: () => boolean;
  }
}

export const ASSET_ORIGIN = 'https://appassets.androidplatform.net';

type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();
export function onNative(name: string, fn: Listener): void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
}
window.__forgeEvent = (name, payload) => {
  let data: any = null;
  try { data = payload ? JSON.parse(payload) : null; } catch { data = payload; }
  listeners.get(name)?.forEach((f) => f(data));
};

function native<T>(fn: string, ...args: (string | number | boolean)[]): T {
  const raw = window.ForgeNative![fn](...args);
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

export interface Bridge {
  isNative: boolean;
  list(path: string): Entry[];
  readText(path: string): string;
  readTextRange(path: string, maxBytes: number): string;
  readB64(path: string): string;
  writeText(path: string, text: string): void;
  writeB64(path: string, b64: string): void;
  stat(path: string): Stat;
  mkdir(path: string): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  isBinary(path: string): boolean;
  search(dir: string, pattern: string, flags: string, include: string, exclude: string, max: number): Match[];
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  importFolder(): void;
  exportFolder(project: string): void;
  importZip(): void;
  exportZip(project: string): void;
  openExternal(path: string): void;
  toast(msg: string): void;
  exit(): void;
  keyList(): KeyMeta[];
  keyCreate(alias: string, password: string, cn: string, org: string, country: string): KeyMeta;
  keyDelete(alias: string): void;
  keyExport(alias: string): void;
  keyExportCert(alias: string): void;
  keyImport(alias: string, password: string): void;
  signAab(inputRel: string, alias: string, password: string, outputRel: string): void;
  previewOpen(project: string, entry: string): void;
  previewReload(): void;
  previewClose(): void;
  keyCheck(alias: string, password: string): boolean;
  ghStatus(): { connected: boolean; login: string };
  ghConnect(token: string): void;
  ghDisconnect(): void;
  ghBuild(project: string, repo: string): void;
  openUrl(url: string): void;
  saveFileAs(rel: string, displayName: string, mime: string): void;
  importFile(project: string): void;
  assetUrl(path: string): string;
}

const nativeBridge: Bridge = {
  isNative: true,
  list: (p) => native('list', p),
  readText: (p) => native('readText', p),
  readTextRange: (p, n) => native('readTextRange', p, n),
  readB64: (p) => native('readB64', p),
  writeText: (p, t) => native('writeText', p, t),
  writeB64: (p, b) => native('writeB64', p, b),
  stat: (p) => native('stat', p),
  mkdir: (p) => native('mkdir', p),
  remove: (p) => native('remove', p),
  rename: (a, b) => native('rename', a, b),
  copy: (a, b) => native('copy', a, b),
  isBinary: (p) => native('isBinary', p),
  search: (d, pat, f, i, e, m) => native('search', d, pat, f, i, e, m),
  kvGet: (k) => native('kvGet', k),
  kvSet: (k, v) => native('kvSet', k, v),
  importFolder: () => native('importFolder'),
  exportFolder: (p) => native('exportFolder', p),
  importZip: () => native('importZip'),
  exportZip: (p) => native('exportZip', p),
  openExternal: (p) => native('openExternal', p),
  toast: (m) => native('toast', m),
  exit: () => native('exit'),
  keyList: () => native('keyList'),
  keyCreate: (a, p, cn, o, c) => native('keyCreate', a, p, cn, o, c),
  keyDelete: (a) => native('keyDelete', a),
  keyExport: (a) => native('keyExport', a),
  keyExportCert: (a) => native('keyExportCert', a),
  keyImport: (a, p) => native('keyImport', a, p),
  signAab: (i, a, p, o) => native('signAab', i, a, p, o),
  previewOpen: (p, e) => native('previewOpen', p, e),
  previewReload: () => native('previewReload'),
  previewClose: () => native('previewClose'),
  keyCheck: (a, p) => native('keyCheck', a, p),
  ghStatus: () => native('ghStatus'),
  ghConnect: (t) => native('ghConnect', t),
  ghDisconnect: () => native('ghDisconnect'),
  ghBuild: (p, r) => native('ghBuild', p, r),
  openUrl: (u) => native('openUrl', u),
  saveFileAs: (r, n, m) => native('saveFileAs', r, n, m),
  importFile: (p) => native('importFile', p),
  assetUrl: (p) => `${ASSET_ORIGIN}/files/${p.split('/').map(encodeURIComponent).join('/')}`,
};

// ---------- in-memory mock (desktop browser dev only) ----------
type Node = { dir: true; mtime: number } | { dir: false; data: Uint8Array; mtime: number };
const mem = new Map<string, Node>();
const enc = new TextEncoder();
const dec = new TextDecoder();
const kv = new Map<string, string>();
const norm = (p: string) => p.replace(/^\/+|\/+$/g, '');
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function ensureDirs(p: string) {
  const parts = norm(p).split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!mem.has(cur)) mem.set(cur, { dir: true, mtime: Date.now() });
  }
}
const b64enc = (u: Uint8Array) => { let s = ''; u.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
const b64dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const underDir = (k: string, d: string) => (d === '' ? true : k === d || k.startsWith(d + '/'));

const mockBridge: Bridge = {
  isNative: false,
  list(p) {
    const d = norm(p);
    const out: Entry[] = [];
    for (const [k, v] of mem) {
      if (k === d || parentOf(k) !== d) continue;
      out.push({ name: k.slice(d ? d.length + 1 : 0), isDir: v.dir, size: v.dir ? 0 : v.data.length, mtime: v.mtime });
    }
    return out;
  },
  readText(p) { const n = mem.get(norm(p)); if (!n || n.dir) throw new Error('not found'); return dec.decode(n.data); },
  readTextRange(p, max) { const n = mem.get(norm(p)); if (!n || n.dir) throw new Error('not found'); return dec.decode(n.data.slice(0, max)); },
  readB64(p) { const n = mem.get(norm(p)); if (!n || n.dir) throw new Error('not found'); return b64enc(n.data); },
  writeText(p, t) { ensureDirs(parentOf(norm(p))); mem.set(norm(p), { dir: false, data: enc.encode(t), mtime: Date.now() }); },
  writeB64(p, b) { ensureDirs(parentOf(norm(p))); mem.set(norm(p), { dir: false, data: b64dec(b), mtime: Date.now() }); },
  stat(p) {
    const n = mem.get(norm(p));
    if (!n) return { exists: false, isDir: false, size: 0, mtime: 0 };
    return { exists: true, isDir: n.dir, size: n.dir ? 0 : n.data.length, mtime: n.mtime };
  },
  mkdir(p) { ensureDirs(p); },
  remove(p) { const d = norm(p); for (const k of [...mem.keys()]) if (underDir(k, d)) mem.delete(k); },
  rename(a, b) {
    const from = norm(a), to = norm(b);
    if (mem.has(to)) throw new Error('target exists');
    ensureDirs(parentOf(to));
    for (const [k, v] of [...mem]) if (underDir(k, from)) { mem.delete(k); mem.set(to + k.slice(from.length), v); }
  },
  copy(a, b) {
    const from = norm(a), to = norm(b);
    ensureDirs(parentOf(to));
    for (const [k, v] of [...mem]) if (underDir(k, from)) mem.set(to + k.slice(from.length), v.dir ? { ...v } : { ...v, data: v.data.slice() });
  },
  isBinary(p) { const n = mem.get(norm(p)); return !!n && !n.dir && n.data.slice(0, 8000).includes(0); },
  search(dir, pattern, flags, _inc, _exc, max) {
    const re = new RegExp(pattern, flags.includes('i') ? 'i' : '');
    const out: Match[] = [];
    for (const [k, v] of mem) {
      if (v.dir || !underDir(k, norm(dir))) continue;
      dec.decode(v.data).split('\n').forEach((line, i) => {
        const m = re.exec(line);
        if (m && out.length < max) out.push({ path: k, line: i + 1, col: m.index, len: m[0].length, text: line.slice(0, 300) });
      });
    }
    return out;
  },
  kvGet: (k) => kv.get(k) ?? localStorage.getItem('forge:' + k),
  kvSet: (k, v) => { kv.set(k, v); try { localStorage.setItem('forge:' + k, v); } catch { /* quota */ } },
  importFolder() { alert('Folder import needs the Android app'); },
  exportFolder() { alert('Folder export needs the Android app'); },
  importZip() { alert('ZIP import needs the Android app'); },
  exportZip() { alert('ZIP export needs the Android app'); },
  openExternal() { alert('Open externally needs the Android app'); },
  toast: (m) => console.log('[toast]', m),
  exit: () => undefined,
  keyList: () => [],
  keyCreate: () => { throw new Error('Signing keys need the Android app'); },
  keyDelete() { /* needs Android */ },
  keyExport() { alert('Needs the Android app'); },
  keyExportCert() { alert('Needs the Android app'); },
  keyImport() { alert('Needs the Android app'); },
  signAab() { throw new Error('Signing needs the Android app'); },
  previewOpen: (p, e) => { window.open(mockBridge.assetUrl(`${p}/${e}`), '_blank'); },
  previewReload() { /* desktop mock has no embedded preview */ },
  previewClose() { /* desktop mock has no embedded preview */ },
  keyCheck: () => true,
  ghStatus: () => ({ connected: false, login: '' }),
  ghConnect() { throw new Error('Needs the Android app'); },
  ghDisconnect() { /* needs Android */ },
  ghBuild() { throw new Error('Needs the Android app'); },
  openUrl: (u) => { window.open(u, '_blank'); },
  saveFileAs() { alert('Needs the Android app'); },
  importFile() { alert('Needs the Android app'); },
  assetUrl: (p) => {
    const n = mem.get(norm(p));
    if (!n || n.dir) return '';
    return URL.createObjectURL(new Blob([n.data as BlobPart]));
  },
};

export const bridge: Bridge = window.ForgeNative ? nativeBridge : mockBridge;
if (!window.ForgeNative) (window as any).__forgeMock = mockBridge; // desktop-browser testing hook

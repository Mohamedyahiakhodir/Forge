import { t } from './i18n';

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) el.append(c);
  return el;
}

export function clearAndFill(el: HTMLElement, kids: Child[]): HTMLElement {
  el.replaceChildren(...(kids.filter(Boolean) as (Node | string)[]));
  return el;
}

export function toast(msg: string, ms = 2200): void {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const el = h('div', { class: 'toast' }, msg);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

function overlay(content: HTMLElement, onClose?: () => void): () => void {
  const back = h('div', { class: 'overlay' });
  const box = h('div', { class: 'sheet' }, content);
  back.append(box);
  const close = () => { back.remove(); onClose?.(); };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return close;
}

export interface MenuItem { label: string; icon?: string; danger?: boolean; run: () => void; sep?: boolean }
export function menuSheet(title: string, items: MenuItem[]): void {
  const list = h('div', { class: 'menu-list' });
  const close = overlay(h('div', {}, h('div', { class: 'sheet-title' }, title), list));
  for (const it of items) {
    if (it.sep) { list.append(h('div', { class: 'menu-sep' })); continue; }
    list.append(h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''),
      onclick: () => { close(); setTimeout(it.run, 0); },
    }, it.icon ? h('span', { class: 'mi' }, it.icon) : null, it.label));
  }
}

export function promptText(title: string, value = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', type: 'text', value, placeholder, autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; close(); resolve(v); };
    const close = overlay(
      h('div', { class: 'dialog' },
        h('div', { class: 'sheet-title' }, title), input,
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => finish(null) }, t('cancel')),
          h('button', { class: 'btn primary', onclick: () => finish(input.value.trim()) }, t('ok')))),
      () => { if (!done) { done = true; resolve(null); } },
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function confirmBox(message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (done) return; done = true; close(); resolve(v); };
    const close = overlay(
      h('div', { class: 'dialog' },
        h('div', { class: 'dialog-msg' }, message),
        h('div', { class: 'row end' },
          h('button', { class: 'btn', onclick: () => finish(false) }, t('cancel')),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, t('ok')))),
      () => { if (!done) { done = true; resolve(false); } },
    );
  });
}

export function fullSheet(title: string, body: HTMLElement): { close: () => void } {
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': t('close') }, '✕');
  const wrap = h('div', { class: 'full-sheet' },
    h('div', { class: 'full-head' }, h('div', { class: 'full-title' }, title), closeBtn), body);
  const back = h('div', { class: 'overlay full' }, wrap);
  document.body.append(back);
  const close = () => back.remove();
  closeBtn.addEventListener('click', close);
  return { close };
}

// ----- paths -----
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const joinPath = (a: string, b: string) => (a ? `${a}/${b}` : b);
export const extOf = (p: string) => {
  const n = baseName(p).toLowerCase();
  const i = n.lastIndexOf('.');
  return i <= 0 ? n.startsWith('.') ? n : '' : n.slice(i + 1);
};
export const projectOf = (p: string) => p.split('/')[0] ?? '';

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const ICONS: Record<string, string> = {
  html: '🌐', htm: '🌐', css: '🎨', scss: '🎨', js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🔷', tsx: '🔷', jsx: '🟨', json: '🧾',
  md: '📝', markdown: '📝', xml: '📰', svg: '🖼', yaml: '⚙️', yml: '⚙️', py: '🐍', php: '🐘', sql: '🗄', java: '☕', kt: '🟣',
  c: '🔧', cpp: '🔧', h: '🔧', go: '🐹', rs: '🦀', dart: '🎯', sh: '💲', png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼',
  mp4: '🎬', webm: '🎬', mp3: '🎵', wav: '🎵', ogg: '🎵', pdf: '📕', zip: '📦', txt: '📄',
};
export const fileIcon = (name: string, isDir: boolean, open = false) =>
  isDir ? (open ? '📂' : '📁') : ICONS[extOf(name)] ?? '📄';

export function debounce<A extends any[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: number | undefined;
  let last: A | undefined;
  const d = (...a: A) => { last = a; clearTimeout(timer); timer = window.setTimeout(() => { timer = undefined; fn(...a); }, ms); };
  d.flush = () => { if (timer !== undefined && last) { clearTimeout(timer); timer = undefined; fn(...last); } };
  d.cancel = () => { clearTimeout(timer); timer = undefined; };
  return d;
}

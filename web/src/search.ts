import { bridge, type Match } from './native';
import { h, toast, confirmBox, baseName, debounce } from './ui';
import { t } from './i18n';

export interface SearchHost {
  project: () => string;
  openAt: (path: string, line: number, col: number) => void;
  afterWrite: (paths: string[]) => void;
}

const MAX = 2000;
const DEFAULT_EXCLUDE = 'node_modules/**, .git/**, **/*.min.js';

export function buildSearchPanel(host: SearchHost): HTMLElement {
  const q = h('input', { class: 'field', placeholder: t('search'), autocapitalize: 'off', spellcheck: false });
  const rep = h('input', { class: 'field', placeholder: t('replaceWith'), autocapitalize: 'off', spellcheck: false });
  const inc = h('input', { class: 'field small', placeholder: t('include'), autocapitalize: 'off', spellcheck: false });
  const exc = h('input', { class: 'field small', placeholder: t('exclude'), value: DEFAULT_EXCLUDE, autocapitalize: 'off', spellcheck: false });
  const opts = { regex: false, case: false, word: false };
  const toggle = (key: keyof typeof opts, label: string) => {
    const b = h('button', { class: 'chip', type: 'button' }, label);
    b.addEventListener('click', () => { opts[key] = !opts[key]; b.classList.toggle('on', opts[key]); });
    return b;
  };
  const summary = h('div', { class: 'search-summary' });
  const list = h('div', { class: 'search-results' });
  let last: Match[] = [];

  const buildRegex = (): RegExp | null => {
    let src = opts.regex ? q.value : q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.word) src = `\\b(?:${src})\\b`;
    try { return new RegExp(src, opts.case ? 'g' : 'gi'); } catch { return null; }
  };

  const run = () => {
    list.replaceChildren();
    summary.textContent = '';
    if (!q.value) return;
    const re = buildRegex();
    if (!re) { summary.textContent = t('invalidRegex'); return; }
    try {
      last = bridge.search(host.project(), re.source, opts.case ? '' : 'i', inc.value, exc.value, MAX);
    } catch (e: any) { summary.textContent = String(e.message ?? e); return; }
    renderResults(false);
  };

  const renderResults = (previewReplace: boolean) => {
    list.replaceChildren();
    const byFile = new Map<string, Match[]>();
    for (const m of last) { if (!byFile.has(m.path)) byFile.set(m.path, []); byFile.get(m.path)!.push(m); }
    summary.textContent = last.length ? t('results', last.length, byFile.size) + (last.length >= MAX ? ` — ${t('truncated', MAX)}` : '') : t('noResults');
    const re = buildRegex();
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const [path, ms] of byFile) {
      frag.append(h('div', { class: 'sr-file' }, `${baseName(path)}`, h('span', { class: 'sr-dir' }, ` ${path.split('/').slice(1, -1).join('/')}`)));
      for (const m of ms) {
        if (++shown > 600) break;
        const row = h('div', { class: 'sr-line', onclick: () => host.openAt(path, m.line, m.col) }, h('span', { class: 'sr-no' }, String(m.line)));
        const text = m.text;
        if (previewReplace && re) {
          row.append(h('span', { class: 'sr-old' }, text.trim()), h('span', { class: 'sr-new' }, text.replace(re, rep.value).trim()));
        } else {
          const before = text.slice(Math.max(0, m.col - 30), m.col);
          row.append(h('span', { class: 'sr-text' }, before, h('mark', {}, text.slice(m.col, m.col + m.len)), text.slice(m.col + m.len, m.col + m.len + 80)));
        }
        frag.append(row);
      }
      if (shown > 600) break;
    }
    list.append(frag);
  };

  const apply = async () => {
    if (!last.length) return;
    const re = buildRegex();
    if (!re) return;
    const files = [...new Set(last.map((m) => m.path))];
    if (!(await confirmBox(t('replaceConfirm', files.length, last.length), true))) return;
    const changed: string[] = [];
    for (const p of files) {
      try {
        const src = bridge.readText(p);
        const out = src.replace(re, rep.value);
        if (out !== src) { bridge.writeText(p, out); changed.push(p); }
      } catch { /* skip unreadable file */ }
    }
    toast(t('replaced', changed.length));
    host.afterWrite(changed);
    run();
  };

  const go = debounce(run, 350);
  q.addEventListener('input', go);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  [inc, exc].forEach((i) => i.addEventListener('change', run));

  return h('div', { class: 'search-panel' },
    h('div', { class: 'sp-row' }, q, h('button', { class: 'btn primary', onclick: run }, t('run'))),
    h('div', { class: 'sp-row' }, rep),
    h('div', { class: 'sp-row wrap' }, toggle('regex', '.*'), toggle('case', 'Aa'), toggle('word', '“ab”'),
      h('button', { class: 'btn', onclick: () => renderResults(true) }, t('previewReplace')),
      h('button', { class: 'btn danger', onclick: apply }, t('applyReplace'))),
    h('div', { class: 'sp-row' }, inc, exc),
    summary, list);
}

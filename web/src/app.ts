import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { bridge, onNative } from './native';
import {
  h, toast, menuSheet, promptText, confirmBox, fullSheet, baseName, dirName, joinPath, extOf, fmtSize, fileIcon, debounce,
} from './ui';
import { t } from './i18n';
import { effective, update, subscribe, setProjectOverride, PROJECT_KEYS, type Settings } from './settings';
import { themeById } from './themes';
import * as ed from './editor';
import { IMAGE_EXT, VIDEO_EXT, AUDIO_EXT, KNOWN_BINARY_EXT, PLAIN, langFor } from './languages';
import { FileTree } from './tree';
import { buildKeybar } from './keybar';
import { buildSearchPanel } from './search';
import { openSettings } from './settingsui';
import { TEMPLATES } from './templates';
import { openPublish } from './publish/wizard';
import { openDeviceBrowser } from './devicefiles';
import { isDevicePath } from './native';

const projectLabel = (p: string): string => (p ? (isDevicePath(p) ? '📱 ' : '') + baseName(p) : '');

function openDevice(): void {
  openDeviceBrowser({
    openFile: (p) => { void openFile(p); closeDrawer(); },
    openAsProject: (p) => { void openProject(p); },
    currentProject: () => project,
    onChanged: () => tree.refresh(),
  });
}
import { L } from './publish/config';

type Kind = 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'binary';
interface Tab {
  path: string; kind: Kind; state?: EditorState; dirty: boolean; langId: string; readOnly: boolean;
  large: boolean; scrollTop: number; pendingSel?: number;
}

const LARGE_BYTES = 5 * 1024 * 1024;
const LARGE_PREVIEW = 512 * 1024;

let project = '';
let tabs: Tab[] = [];
let active = -1;
let tree: FileTree;
let keybar: ReturnType<typeof buildKeybar>;
let favorites: string[] = [];
let recents: string[] = [];
let sideMode: 'files' | 'recent' | 'favs' = 'files';
let panelMode: 'console' | 'terminal' | 'search' = 'console';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const logLines: string[] = [];

// ---------- logging (local crash/log screen) ----------
export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${level.toUpperCase()} ${msg}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  const box = document.getElementById('console-out');
  if (box) { box.append(h('div', { class: 'log ' + level }, line)); box.scrollTop = box.scrollHeight; }
}

// ---------- kv helpers ----------
const kvJson = <T,>(key: string, fallback: T): T => {
  try { const r = bridge.kvGet(key); return r ? (JSON.parse(r) as T) : fallback; } catch { return fallback; }
};
const kvSave = (key: string, v: unknown) => { try { bridge.kvSet(key, JSON.stringify(v)); } catch (e: any) { log('error', `kv ${key}: ${e.message}`); } };

// ---------- project helpers ----------
export function listProjects(): string[] {
  try { return bridge.list('').filter((e) => e.isDir && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; }
}

function loadProjectSettings(p: string): void {
  let o: Partial<Settings> = {};
  try {
    if (bridge.stat(`${p}/.forge/settings.json`).exists) {
      const raw = JSON.parse(bridge.readText(`${p}/.forge/settings.json`));
      for (const k of PROJECT_KEYS) if (k in raw) (o as any)[k] = raw[k];
    }
  } catch { o = {}; }
  setProjectOverride(o);
}

async function openProject(p: string, restoreTabs = false): Promise<void> {
  if (p === project && !restoreTabs) return;
  await flushAllSaves();
  tabs = []; active = -1;
  project = p;
  kvSave('currentProject', p);
  loadProjectSettings(p);
  tree.setRoot(p);
  $('project-name').textContent = projectLabel(p) || t('noProject');
  renderTabs();
  await showActive();
  updateGitBranch();
  if (p) refreshEmptyState();
}

// ---------- tabs ----------
const tabOf = (path: string) => tabs.findIndex((x) => x.path === path);

function kindOf(path: string): Kind {
  const e = extOf(path);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (KNOWN_BINARY_EXT.has(e)) return 'binary';
  try { if (bridge.isBinary(path)) return 'binary'; } catch { /* treat as text */ }
  return 'text';
}

export async function openFile(path: string, line = 0, col = 0): Promise<void> {
  let i = tabOf(path);
  if (i < 0) {
    const kind = kindOf(path);
    const tab: Tab = { path, kind, dirty: false, langId: 'plain', readOnly: false, large: false, scrollTop: 0 };
    if (kind === 'text') {
      try {
        const size = bridge.stat(path).size;
        let text: string;
        if (size > LARGE_BYTES) { text = bridge.readTextRange(path, LARGE_PREVIEW); tab.large = true; tab.readOnly = true; }
        else text = bridge.readText(path);
        const { info, ext } = await ed.loadLangExt(path);
        tab.langId = info.id;
        tab.state = ed.makeState(text, path, ext, tab.readOnly);
      } catch (e: any) {
        if (String(e.message ?? e).includes('DEVICE_ACCESS_DENIED')) { toast(L('محتاج إذن الوصول لملفات الجهاز', 'Device file access is needed')); openDevice(); }
        else toast(t('error') + ': ' + (e.message ?? e));
        return;
      }
    }
    tabs.push(tab);
    i = tabs.length - 1;
  }
  pushRecent(path);
  await activate(i);
  if (line > 0 && tabs[i].kind === 'text') {
    const v = ed.getView();
    const ln = v.state.doc.line(Math.min(line, v.state.doc.lines));
    const pos = Math.min(ln.from + col, ln.to);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    v.focus();
  }
}

function stashActive(): void {
  const cur = tabs[active];
  if (cur && cur.kind === 'text') {
    cur.state = ed.getView().state;
    cur.scrollTop = ed.getView().scrollDOM.scrollTop;
  }
}

async function activate(i: number): Promise<void> {
  if (i !== active) stashActive();
  active = i;
  renderTabs();
  await showActive();
  scheduleSession();
}

async function showActive(): Promise<void> {
  const tab = tabs[active];
  const viewer = $('viewer');
  const cm = $('cm');
  viewer.replaceChildren();
  viewer.style.display = 'none';
  $('empty-editor').style.display = tab ? 'none' : '';
  if (!tab) { cm.style.visibility = 'hidden'; updateStatus(); tree.setActive(''); return; }
  tree.setActive(tab.path);
  if (tab.kind === 'text') {
    cm.style.visibility = 'visible';
    ed.getView().setState(tab.state!);
    await ed.applySettings(tab.langId, tab.readOnly);
    ed.getView().scrollDOM.scrollTop = tab.scrollTop;
    renderLargeBanner(tab);
  } else {
    cm.style.visibility = 'hidden';
    viewer.style.display = '';
    renderViewer(tab, viewer);
  }
  updateStatus();
}

function renderLargeBanner(tab: Tab): void {
  const b = $('banner');
  b.replaceChildren();
  b.style.display = 'none';
  if (!tab.large) return;
  b.style.display = '';
  b.append(
    h('span', {}, t('largeFile', fmtSize(bridge.stat(tab.path).size), fmtSize(LARGE_PREVIEW))),
    h('button', { class: 'btn small', onclick: async () => {
      try {
        const text = bridge.readText(tab.path);
        const { ext } = await ed.loadLangExt(tab.path);
        tab.large = false; tab.readOnly = false;
        tab.state = ed.makeState(text, tab.path, ext, false);
        await showActive();
      } catch (e: any) { toast(String(e.message ?? e)); }
    } }, t('openFull')),
  );
}

function renderViewer(tab: Tab, viewer: HTMLElement): void {
  const url = bridge.assetUrl(tab.path);
  const name = baseName(tab.path);
  const info = h('div', { class: 'viewer-info' }, `${name} · ${fmtSize(bridge.stat(tab.path).size)}`);
  const external = h('button', { class: 'btn', onclick: () => bridge.openExternal(tab.path) }, t('openExternal'));
  if (tab.kind === 'image') viewer.append(h('img', { src: url, class: 'viewer-img', alt: name }), info);
  else if (tab.kind === 'video') viewer.append(h('video', { src: url, controls: true, class: 'viewer-media' }), info);
  else if (tab.kind === 'audio') viewer.append(h('div', { class: 'viewer-card' }, h('div', { class: 'big' }, '🎵'), h('audio', { src: url, controls: true })), info);
  else viewer.append(h('div', { class: 'viewer-card' }, h('div', { class: 'big' }, tab.kind === 'pdf' ? '📕' : '📦'), h('div', {}, tab.kind === 'pdf' ? 'PDF' : t('binaryFile')), external), info);
}

async function closeTab(i: number, force = false): Promise<void> {
  const tab = tabs[i];
  if (!tab) return;
  if (i === active) stashActive();
  if (tab.dirty && !force && !(await confirmBox(t('discardChanges', baseName(tab.path)), true))) return;
  tabs.splice(i, 1);
  if (tabs.length === 0) active = -1;
  else if (i < active || active >= tabs.length) active = Math.max(0, Math.min(active - (i <= active ? 1 : 0), tabs.length - 1));
  renderTabs();
  await showActive();
  scheduleSession();
}

function renderTabs(): void {
  const bar = $('tabs');
  bar.replaceChildren(...tabs.map((tb, i) => {
    const el = h('div', { class: 'tab' + (i === active ? ' active' : ''), role: 'tab' },
      h('span', { class: 'ti' }, fileIcon(tb.path, false)),
      h('span', { class: 'tn' }, baseName(tb.path)),
      tb.dirty ? h('span', { class: 'dot', title: t('unsaved') }, '●') : null,
      h('button', { class: 'tx', 'aria-label': t('closeTab'), onclick: (e: Event) => { e.stopPropagation(); void closeTab(i); } }, '✕'));
    el.addEventListener('click', () => void activate(i));
    let timer: number | undefined;
    el.addEventListener('pointerdown', () => { timer = window.setTimeout(() => tabMenu(i), 500); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, () => clearTimeout(timer)));
    return el;
  }));
  const act = bar.children[active] as HTMLElement | undefined;
  act?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  $('save-btn').classList.toggle('dim', !tabs[active]?.dirty);
}

function tabMenu(i: number): void {
  menuSheet(baseName(tabs[i].path), [
    { label: t('closeTab'), run: () => void closeTab(i) },
    { label: t('closeOthers'), run: async () => { for (let k = tabs.length - 1; k >= 0; k--) if (k !== i) await closeTab(k); } },
    { label: t('closeAll'), run: async () => { for (let k = tabs.length - 1; k >= 0; k--) await closeTab(k); } },
  ]);
}

// ---------- preview ----------
let previewOpen = false;
const reloadPreview = debounce(() => { try { bridge.previewReload(); } catch { /* preview closed */ } }, 250);

function findEntryHtml(): string {
  const cur = tabs[active]?.path;
  if (cur && project && cur.startsWith(project + '/') && /\.html?$/i.test(cur)) return cur.slice(project.length + 1);
  if (project && bridge.stat(`${project}/index.html`).exists) return 'index.html';
  try { const first = bridge.list(project).find((e) => !e.isDir && /\.html?$/i.test(e.name)); return first ? first.name : ''; } catch { return ''; }
}

function togglePreview(): void {
  if (!project) return;
  if (previewOpen) { try { bridge.previewClose(); } catch { /* ignore */ } previewOpen = false; $('preview-btn').classList.remove('on'); return; }
  const entry = findEntryHtml();
  if (!entry) { toast(t('noHtml')); return; }
  manualSave(true);
  try {
    bridge.previewOpen(project, entry);
    previewOpen = true;
    $('preview-btn').classList.add('on');
    closeDrawer();
  } catch (e: any) { toast(String(e.message ?? e)); }
}

// ---------- saving ----------
function saveTab(tab: Tab): boolean {
  if (tab.kind !== 'text' || tab.readOnly) return true;
  const state = tab === tabs[active] ? ed.getView().state : tab.state!;
  try {
    bridge.writeText(tab.path, state.doc.toString());
    tab.dirty = false;
    if (previewOpen) reloadPreview();
    return true;
  } catch (e: any) {
    toast(t('saveFailed', e.message ?? e));
    log('error', `save ${tab.path}: ${e.message ?? e}`);
    return false;
  }
}

async function flushAllSaves(): Promise<void> {
  clearTimeout(autosaveHandle);
  for (const tb of tabs) if (tb.dirty) saveTab(tb);
}

let autosaveHandle: number | undefined;
function runAutosaveNow(): void {
  clearTimeout(autosaveHandle);
  let any = false;
  for (const tb of tabs) if (tb.dirty && saveTab(tb)) any = true;
  if (any) renderTabs();
  scheduleSession();
}

function onDocChanged(): void {
  const tab = tabs[active];
  if (!tab || tab.kind !== 'text') return;
  if (!tab.dirty) { tab.dirty = true; renderTabs(); }
  const ms = effective().autosaveMs;
  clearTimeout(autosaveHandle);
  if (ms > 0) autosaveHandle = window.setTimeout(runAutosaveNow, ms);
  scheduleSession();
}
function manualSave(all = false): void {
  const list = all ? tabs : tabs[active] ? [tabs[active]] : [];
  let ok = 0;
  for (const tb of list) if (tb.dirty && saveTab(tb)) ok++;
  renderTabs();
  if (ok) toast(t('saved'));
  scheduleSession();
}

// ---------- session restore ----------
interface SessionTab { path: string; sel: number; scroll: number; unsaved?: string }
interface Session { project: string; active: number; tabs: SessionTab[] }

const saveSession = () => {
  stashActive();
  const s: Session = {
    project, active,
    tabs: tabs.filter((x) => x.kind !== 'binary').map((x) => ({
      path: x.path,
      sel: x.state ? x.state.selection.main.head : 0,
      scroll: x.scrollTop,
      unsaved: x.dirty && x.state ? x.state.doc.toString() : undefined,
    })),
  };
  kvSave('session', s);
};
const scheduleSession = debounce(saveSession, 700);

async function restoreSession(): Promise<void> {
  const s = kvJson<Session | null>('session', null);
  const last = kvJson<string>('currentProject', '');
  const projects = listProjects();
  // A project may be a folder on shared storage ("@device/..."); it is restored only if it is still reachable.
  const usable = (p: string | undefined): boolean => !!p && (projects.includes(p) || (isDevicePath(p) && (() => { try { return bridge.stat(p).isDir; } catch { return false; } })()));
  const proj = usable(s?.project) ? s!.project : usable(last) ? last : projects[0] ?? '';
  if (!proj) { await openProject(''); return; }
  await openProject(proj, true);
  if (s && s.project === proj) {
    for (const st of s.tabs) {
      if (!bridge.stat(st.path).exists) continue;
      await openFile(st.path);
      const i = tabOf(st.path);
      const tab = tabs[i];
      if (tab?.kind === 'text') {
        if (st.unsaved !== undefined && !tab.readOnly) {
          const { ext } = await ed.loadLangExt(st.path);
          tab.state = ed.makeState(st.unsaved, st.path, ext, false);
          tab.dirty = true;
        }
        tab.scrollTop = st.scroll;
        const head = Math.min(st.sel, tab.state!.doc.length);
        tab.state = tab.state!.update({ selection: { anchor: head } }).state;
      }
    }
    if (tabs.length) await activate(Math.min(Math.max(s.active, 0), tabs.length - 1));
  }
  renderTabs();
}

// ---------- recents / favorites ----------
function pushRecent(path: string): void {
  recents = [path, ...recents.filter((x) => x !== path)].slice(0, 30);
  kvSave('recents', recents);
  if (sideMode === 'recent') renderSide();
}
const toggleFav = (path: string) => {
  favorites = favorites.includes(path) ? favorites.filter((x) => x !== path) : [...favorites, path];
  kvSave('favorites', favorites);
  tree.setFavorites(new Set(favorites));
  if (sideMode === 'favs') renderSide();
};

function renderSide(): void {
  document.querySelectorAll('#side-tabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.mode === sideMode));
  $('tree-host').style.display = sideMode === 'files' ? '' : 'none';
  $('side-selectbar').style.display = sideMode === 'files' && tree.selectMode ? '' : 'none';
  const list = $('side-list');
  list.style.display = sideMode === 'files' ? 'none' : '';
  if (sideMode === 'files') return;
  const items = (sideMode === 'recent' ? recents : favorites).filter((p) => bridge.stat(p).exists);
  list.replaceChildren(...(items.length
    ? items.map((p) => h('div', { class: 'side-item', onclick: () => { void openFile(p); closeDrawer(); } },
      h('span', { class: 'ti' }, fileIcon(p, false)), h('div', { class: 'si-text' }, h('div', { class: 'tn' }, baseName(p)), h('div', { class: 'sub' }, dirName(p)))))
    : [h('div', { class: 'empty-note' }, sideMode === 'recent' ? t('emptyRecent') : t('emptyFavs'))]));
}

// ---------- file operations ----------
async function uniqueTarget(dir: string, name: string): Promise<string> {
  let target = joinPath(dir, name);
  if (!bridge.stat(target).exists) return target;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    target = joinPath(dir, `${stem} copy${n > 1 ? ' ' + n : ''}${ext}`);
    if (!bridge.stat(target).exists) return target;
  }
  return target;
}

const invalidName = (n: string) => !n || n.includes('/') || n === '.' || n === '..';

async function newItem(dir: string, isDir: boolean): Promise<void> {
  const name = await promptText(isDir ? t('newFolder') : t('newFile'), '', t('name'));
  if (!name) return;
  if (invalidName(name)) { toast(t('error')); return; }
  const path = joinPath(dir, name);
  if (bridge.stat(path).exists) { toast(t('exists')); return; }
  try {
    if (isDir) bridge.mkdir(path); else bridge.writeText(path, '');
  } catch (e: any) { toast(String(e.message ?? e)); return; }
  tree.refresh(dir); tree.expand(dir);
  if (!isDir) void openFile(path);
}

async function renameItem(path: string): Promise<void> {
  const name = await promptText(t('rename'), baseName(path));
  if (!name || name === baseName(path)) return;
  if (invalidName(name)) { toast(t('error')); return; }
  const to = joinPath(dirName(path), name);
  if (bridge.stat(to).exists) { toast(t('exists')); return; }
  try { bridge.rename(path, to); } catch (e: any) { toast(String(e.message ?? e)); return; }
  retargetTabs(path, to);
  favorites = favorites.map((f) => (f === path || f.startsWith(path + '/') ? to + f.slice(path.length) : f));
  kvSave('favorites', favorites);
  tree.refresh(dirName(path));
}

function retargetTabs(from: string, to: string): void {
  for (const tb of tabs) if (tb.path === from || tb.path.startsWith(from + '/')) tb.path = to + tb.path.slice(from.length);
  renderTabs();
  scheduleSession();
}

async function deleteItems(paths: string[]): Promise<void> {
  const msg = paths.length === 1 ? t('confirmDelete', baseName(paths[0])) : t('confirmDeleteN', paths.length);
  if (!(await confirmBox(msg, true))) return;
  for (const p of paths) {
    try { bridge.remove(p); } catch (e: any) { toast(String(e.message ?? e)); continue; }
    for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].path === p || tabs[i].path.startsWith(p + '/')) await closeTab(i, true);
  }
  favorites = favorites.filter((f) => !paths.some((p) => f === p || f.startsWith(p + '/')));
  kvSave('favorites', favorites);
  tree.setSelectMode(false);
  tree.refresh();
}

async function duplicateItem(path: string): Promise<void> {
  const to = await uniqueTarget(dirName(path), baseName(path));
  try { bridge.copy(path, to); } catch (e: any) { toast(String(e.message ?? e)); return; }
  tree.refresh(dirName(path));
}

function pickFolder(title: string, exclude: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let cur = project;
    const list = h('div', { class: 'menu-list' });
    const head = h('div', { class: 'pick-path' });
    const sheet = fullSheet(title, h('div', { class: 'picker' }, head, list));
    const render = () => {
      head.textContent = cur === project ? t('root') : cur.slice(project.length + 1);
      list.replaceChildren(
        h('button', { class: 'btn primary wide', onclick: () => { sheet.close(); resolve(cur); } }, t('here')),
        cur !== project ? h('button', { class: 'menu-item', onclick: () => { cur = dirName(cur); render(); } }, '⬆ ..') : '',
        ...FileTree.listDirs(cur).filter((d) => !exclude.some((x) => d === x || d.startsWith(x + '/')))
          .map((d) => h('button', { class: 'menu-item', onclick: () => { cur = d; render(); } }, '📁 ' + baseName(d))));
    };
    render();
    const obs = new MutationObserver(() => { if (!document.body.contains(head)) { obs.disconnect(); resolve(null); } });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

async function moveOrCopy(paths: string[], isCopy: boolean, dest?: string): Promise<void> {
  const target = dest ?? (await pickFolder(isCopy ? t('copyTo') : t('moveTo'), isCopy ? [] : paths));
  if (target == null) return;
  for (const p of paths) {
    if (target === p || target.startsWith(p + '/')) { toast(t('error')); continue; }
    if (dirName(p) === target && !isCopy) continue;
    const to = isCopy ? await uniqueTarget(target, baseName(p)) : joinPath(target, baseName(p));
    if (!isCopy && bridge.stat(to).exists) { toast(`${baseName(p)}: ${t('exists')}`); continue; }
    try {
      if (isCopy) bridge.copy(p, to); else { bridge.rename(p, to); retargetTabs(p, to); }
    } catch (e: any) { toast(String(e.message ?? e)); }
  }
  tree.setSelectMode(false);
  tree.refresh();
  tree.expand(target);
}

function itemMenu(path: string, isDir: boolean): void {
  const dir = isDir ? path : dirName(path);
  const items = [
    ...(isDir ? [
      { label: t('newFile'), icon: '📄', run: () => void newItem(path, false) },
      { label: t('newFolder'), icon: '📁', run: () => void newItem(path, true) },
      { label: '', sep: true, run: () => undefined },
    ] : []),
    { label: t('rename'), icon: '✏️', run: () => void renameItem(path) },
    { label: t('duplicate'), icon: '⧉', run: () => void duplicateItem(path) },
    { label: t('moveTo'), icon: '➡️', run: () => void moveOrCopy([path], false) },
    { label: t('copyTo'), icon: '📋', run: () => void moveOrCopy([path], true) },
    ...(!isDir ? [{ label: favorites.includes(path) ? t('removeFav') : t('addFav'), icon: '★', run: () => toggleFav(path) }] : []),
    { label: t('select'), icon: '☑', run: () => { tree.setSelectMode(true); renderSide(); } },
    { label: '', sep: true, run: () => undefined },
    { label: t('delete'), icon: '🗑', danger: true, run: () => void deleteItems([path]) },
  ];
  menuSheet(baseName(path) || dir, items);
}

// ---------- projects ----------
async function createProject(): Promise<void> {
  let tpl = 'html5';
  const sel = h('select', { class: 'field' }, ...TEMPLATES.map((x) => h('option', { value: x.id, selected: x.id === tpl }, t(x.labelKey))));
  sel.addEventListener('change', () => { tpl = sel.value; });
  const name = h('input', { class: 'field', placeholder: t('projectName'), autocapitalize: 'off', spellcheck: false });
  const result = await new Promise<string | null>((resolve) => {
    const sheet = fullSheet(t('newProject'), h('div', { class: 'settings' },
      h('label', { class: 'set-row' }, h('span', {}, t('projectName')), name),
      h('label', { class: 'set-row' }, h('span', {}, t('template')), sel),
      h('button', { class: 'btn primary wide', onclick: () => {
        const n = name.value.trim();
        if (invalidName(n) || n.startsWith('.')) { toast(t('error')); return; }
        if (bridge.stat(n).exists) { toast(t('exists')); return; }
        sheet.close(); resolve(n);
      } }, t('create'))));
    setTimeout(() => name.focus(), 60);
  });
  if (!result) return;
  const template = TEMPLATES.find((x) => x.id === tpl)!;
  try {
    bridge.mkdir(result);
    for (const [f, content] of Object.entries(template.files)) bridge.writeText(joinPath(result, f), content);
  } catch (e: any) { toast(String(e.message ?? e)); return; }
  await openProject(result);
  const first = Object.keys(template.files).find((f) => f.endsWith('.html')) ?? Object.keys(template.files)[0];
  if (first) void openFile(joinPath(result, first));
}

function projectsSheet(): void {
  const body = h('div', { class: 'settings' });
  const sheet = fullSheet(t('openProject'), body);
  const render = () => {
    const ps = listProjects();
    body.replaceChildren(
      h('div', { class: 'row wrap gap' },
        h('button', { class: 'btn primary', onclick: () => { sheet.close(); void createProject(); } }, '＋ ' + t('newProject')),
        h('button', { class: 'btn', onclick: () => { sheet.close(); openDevice(); } }, L('📱 ملفات الجهاز', '📱 Device files')),
        h('button', { class: 'btn', onclick: () => { sheet.close(); bridge.importFolder(); } }, t('importFolder')),
        h('button', { class: 'btn', onclick: () => { sheet.close(); bridge.importZip(); } }, t('importZip'))),
      ...(ps.length ? ps.map((p) => h('div', { class: 'proj-row' + (p === project ? ' current' : '') },
        h('button', { class: 'proj-open', onclick: () => { sheet.close(); void openProject(p); } }, '📁 ' + p),
        h('button', { class: 'icon-btn', 'aria-label': t('more'), onclick: () => menuSheet(p, [
          { label: L('النشر على Google Play', 'Publish to Google Play'), run: () => { sheet.close(); openPublish(p); } },
          { label: t('exportZip'), run: () => bridge.exportZip(p) },
          { label: t('exportFolder'), run: () => bridge.exportFolder(p) },
          { label: t('deleteProject'), danger: true, run: async () => {
            if (!(await confirmBox(t('confirmDelete', p), true))) return;
            bridge.remove(p);
            if (p === project) { await openProject(''); }
            render();
          } },
        ]) }, '⋮'))) : [h('div', { class: 'empty-note' }, t('emptyProjects'))]));
  };
  render();
}

// ---------- status / panels ----------
function updateStatus(): void {
  const tab = tabs[active];
  const el = $('status');
  if (!tab) { el.replaceChildren(h('span', {}, project || t('appName'))); return; }
  const parts: (Node | string)[] = [];
  if (tab.kind === 'text') {
    const v = ed.getView();
    const head = v.state.selection.main.head;
    const ln = v.state.doc.lineAt(head);
    parts.push(h('span', {}, `${t('line')} ${ln.number}, ${t('col')} ${head - ln.from + 1}`));
    const sel = v.state.selection.ranges.length;
    if (sel > 1) parts.push(h('span', {}, `${sel} ⌖`));
    parts.push(h('span', {}, (langFor(tab.path) ?? PLAIN).label), h('span', {}, 'UTF-8'));
  } else parts.push(h('span', {}, tab.kind));
  const branch = gitBranch();
  if (branch) parts.push(h('span', {}, `⎇ ${branch}`));
  el.replaceChildren(...parts);
}

function gitBranch(): string {
  if (!project) return '';
  try {
    const head = bridge.readText(`${project}/.git/HEAD`).trim();
    return head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 7);
  } catch { return ''; }
}
function updateGitBranch(): void { updateStatus(); }

function refreshEmptyState(): void {
  const box = $('empty-editor');
  box.replaceChildren(
    h('div', { class: 'big' }, '⌨️'),
    h('div', { class: 'et' }, project ? t('emptyEditor') : t('welcomeTitle')),
    h('div', { class: 'sub' }, project ? t('emptyEditorSub') : t('welcomeBody')),
    project ? '' : h('button', { class: 'btn primary', onclick: () => void createProject() }, t('startProject')),
    h('button', { class: 'btn', onclick: openDevice }, L('📱 فتح ملف من الجهاز', '📱 Open a file from the device')));
}

function setPanel(mode: typeof panelMode | null): void {
  const panel = $('panel');
  if (mode === null) { panel.style.display = 'none'; return; }
  panelMode = mode;
  panel.style.display = '';
  document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.mode === mode));
  $('console-pane').style.display = mode === 'console' ? '' : 'none';
  $('terminal-pane').style.display = mode === 'terminal' ? '' : 'none';
  $('search-pane').style.display = mode === 'search' ? '' : 'none';
}

function closeDrawer(): void { document.body.classList.remove('drawer'); }

// ---------- editor action menu ----------
function editorMenu(): void {
  const c = ed.commands;
  menuSheet(t('editorActions'), [
    { label: t('findReplace'), icon: '🔎', run: c.find },
    { label: t('searchProject'), icon: '🗂', run: () => { setPanel('search'); } },
    { label: t('goToLine'), icon: '↧', run: c.gotoLine },
    { label: t('toggleComment'), icon: '//', run: c.comment },
    { label: t('moveLineUp'), icon: '▲', run: c.lineUp },
    { label: t('moveLineDown'), icon: '▼', run: c.lineDown },
    { label: t('duplicateLine'), icon: '⧉', run: c.duplicate },
    { label: t('selectNext'), icon: '⌖', run: c.nextOccurrence },
    { label: t('addCursorAbove'), icon: '⇡', run: c.cursorAbove },
    { label: t('addCursorBelow'), icon: '⇣', run: c.cursorBelow },
    { label: t('emmet'), icon: '⚡', run: c.emmet },
    { label: t('foldAll'), icon: '▸', run: c.foldAll },
    { label: t('unfoldAll'), icon: '▾', run: c.unfoldAll },
    { label: t('toggleWrap'), icon: '↩', run: () => update({ wordWrap: !effective().wordWrap }) },
    { label: t('saveAll'), icon: '💾', run: () => manualSave(true) },
    ...(project ? [{ label: L('النشر على Google Play', 'Publish to Google Play'), icon: '🚀', run: () => { manualSave(true); openPublish(project); } }] : []),
  ]);
}

// ---------- chrome theming ----------
function applyChrome(): void {
  const s = effective();
  const info = themeById(s.theme);
  document.documentElement.dataset.dark = info.dark ? '1' : '0';
  document.documentElement.dir = s.lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = s.lang;
  requestAnimationFrame(() => {
    const cm = document.querySelector('.cm-editor') as HTMLElement | null;
    if (!cm) return;
    const cs = getComputedStyle(cm);
    const bg = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : info.dark ? '#1e1e1e' : '#ffffff';
    document.documentElement.style.setProperty('--bg', bg);
    document.documentElement.style.setProperty('--fg', cs.color || (info.dark ? '#ddd' : '#222'));
  });
}

function relabelStatic(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle!); el.setAttribute('aria-label', el.title); });
  $('project-name').textContent = projectLabel(project) || t('noProject');
  refreshEmptyState();
  renderSide();
  keybar.rebuild();
  $('search-pane').replaceChildren(buildSearchPanel(searchHost));
  applyChrome();
}

const searchHost = {
  project: () => project,
  openAt: (p: string, l: number, c: number) => { void openFile(p, l, c); },
  afterWrite: (paths: string[]) => {
    for (const p of paths) {
      const i = tabOf(p);
      if (i < 0 || tabs[i].kind !== 'text') continue;
      const wasActive = i === active;
      tabs.splice(i, 1);
      if (active >= i && active > 0) active--;
      void (async () => { await openFile(p); if (wasActive) renderTabs(); })();
    }
  },
};

// ---------- boot ----------
export async function boot(): Promise<void> {
  const view = ed.createView($('cm'), { onDocChanged, onSelection: updateStatus });
  view.dom.addEventListener('focusin', () => document.body.classList.add('kb-open'));
  view.dom.addEventListener('focusout', () => setTimeout(() => { if (!view.hasFocus) document.body.classList.remove('kb-open'); }, 150));
  ed.enablePinchZoom($('cm'), () => effective().fontSize, (n) => update({ fontSize: n }));

  favorites = kvJson<string[]>('favorites', []);
  recents = kvJson<string[]>('recents', []);

  tree = new FileTree({
    onOpen: (p) => { void openFile(p); if (window.innerWidth < 760) closeDrawer(); },
    onMenu: itemMenu,
    onSelectionChange: (sel) => {
      $('sel-count').textContent = `${sel.size} ${t('selected')}`;
      $('side-selectbar').style.display = tree.selectMode ? '' : 'none';
    },
    onMove: (paths, dest) => { void moveOrCopy(paths, false, dest); },
  });
  $('tree-host').append(tree.el);
  tree.setFavorites(new Set(favorites));

  keybar = buildKeybar(() => ed.getView());
  $('keybar-host').append(keybar.el);

  // static wiring
  $('menu-btn').onclick = () => document.body.classList.toggle('drawer');
  $('scrim').onclick = closeDrawer;
  $('project-btn').onclick = projectsSheet;
  $('save-btn').onclick = () => manualSave(false);
  $('more-btn').onclick = editorMenu;
  $('settings-btn').onclick = () => openSettings(project, relabelStatic);
  $('find-btn').onclick = () => { if (tabs[active]?.kind === 'text') ed.commands.find(); };
  $('preview-btn').onclick = togglePreview;
  $('new-file-btn').onclick = () => { if (project) void newItem(project, false); };
  $('new-folder-btn').onclick = () => { if (project) void newItem(project, true); };
  $('device-btn').onclick = openDevice;
  $('hidden-btn').onclick = () => { update({ showHidden: !effective().showHidden }); };
  $('select-btn').onclick = () => { tree.setSelectMode(!tree.selectMode); renderSide(); };
  $('sel-delete').onclick = () => { if (tree.selected.size) void deleteItems([...tree.selected]); };
  $('sel-move').onclick = () => { if (tree.selected.size) void moveOrCopy([...tree.selected], false); };
  $('sel-copy').onclick = () => { if (tree.selected.size) void moveOrCopy([...tree.selected], true); };
  $('sel-done').onclick = () => { tree.setSelectMode(false); renderSide(); };
  $('empty-new').onclick = () => void createProject();
  document.querySelectorAll<HTMLElement>('#side-tabs button').forEach((b) => b.addEventListener('click', () => { sideMode = b.dataset.mode as typeof sideMode; renderSide(); }));
  document.querySelectorAll<HTMLElement>('#panel-tabs button').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.mode as typeof panelMode)));
  $('panel-close').onclick = () => setPanel(null);
  $('console-clear').onclick = () => { logLines.length = 0; $('console-out').replaceChildren(); };
  $('search-btn').onclick = () => setPanel(panelMode === 'search' && $('panel').style.display !== 'none' ? null : 'search');
  $('terminal-pane').textContent = t('terminalSoon');

  subscribe((_s, changed) => {
    if (changed.includes('showHidden')) tree.refresh();
    if (changed.includes('customKeys')) keybar.rebuild();
    if (changed.includes('lang')) relabelStatic();
    if (tabs[active]?.kind === 'text') void ed.applySettings(tabs[active].langId, tabs[active].readOnly).then(applyChrome);
    else applyChrome();
  });

  // native events
  onNative('importDone', (p: { project: string }) => { toast(t('importDone', p.project)); void openProject(p.project); });
  onNative('importError', (p: { message: string }) => toast(t('importFailed', p.message)));
  onNative('exportDone', () => toast(t('exportDone')));
  onNative('previewConsole', (p: { level: 'info' | 'warn' | 'error'; msg: string; src: string }) => {
    if (p.msg === 'PORT_BUSY') { toast(L('البورت 8080 مشغول. اقفل أي سيرفر تاني وحاول.', 'Port 8080 is busy. Close any other server and retry.')); return; }
    log(p.level, `[preview] ${p.msg}${p.src ? `  (${p.src})` : ''}`);
    if (p.level === 'error') { setPanel('console'); }
  });
  onNative('previewClosed', () => { previewOpen = false; $('preview-btn').classList.remove('on'); });
  window.__forgeBack = () => {
    if (document.querySelector('.overlay')) { document.querySelector('.overlay:last-of-type')?.remove(); return true; }
    if (document.body.classList.contains('drawer')) { closeDrawer(); return true; }
    if ($('panel').style.display !== 'none') { setPanel(null); return true; }
    return false;
  };

  // persistence hooks
  document.addEventListener('visibilitychange', () => { if (document.hidden) { runAutosaveNow(); saveSession(); } });
  window.addEventListener('pagehide', () => { runAutosaveNow(); saveSession(); });
  window.addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('error', `Unhandled: ${String((e.reason && e.reason.message) || e.reason)}`));
  window.visualViewport?.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--vh', `${window.visualViewport!.height}px`);
  });
  document.documentElement.style.setProperty('--vh', `${window.visualViewport?.height ?? window.innerHeight}px`);

  setPanel(null);
  refreshEmptyState();
  relabelStatic();
  renderSide();
  await restoreSession();
  applyChrome();
  log('info', 'Forge ready');
}

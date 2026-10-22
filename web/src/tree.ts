import { bridge, type Entry } from './native';
import { h, fileIcon, joinPath, baseName, dirName } from './ui';
import { effective } from './settings';
import { t } from './i18n';

const ROW_H = 40;
const ALWAYS_HIDDEN = new Set(['.forge']);

export interface TreeHandlers {
  onOpen: (path: string) => void;
  onMenu: (path: string, isDir: boolean) => void;
  onSelectionChange: (selected: Set<string>) => void;
  onMove: (paths: string[], destDir: string) => void;
}

interface Row { path: string; name: string; isDir: boolean; depth: number; size: number }

export class FileTree {
  readonly el: HTMLElement;
  private spacer: HTMLElement;
  private viewport: HTMLElement;
  private empty: HTMLElement;
  private root = '';
  private expanded = new Set<string>();
  private cache = new Map<string, Entry[]>();
  private rows: Row[] = [];
  private favs = new Set<string>();
  selected = new Set<string>();
  selectMode = false;
  activePath = '';

  constructor(private handlers: TreeHandlers) {
    this.spacer = h('div', { class: 'tree-spacer' });
    this.viewport = h('div', { class: 'tree-viewport' });
    this.empty = h('div', { class: 'empty-note' });
    this.spacer.append(this.viewport);
    this.el = h('div', { class: 'tree', role: 'tree' }, this.spacer, this.empty);
    this.el.addEventListener('scroll', () => this.paint(), { passive: true });
    new ResizeObserver(() => this.paint()).observe(this.el);
  }

  setRoot(project: string): void {
    this.root = project;
    this.expanded = new Set([project]);
    this.cache.clear();
    this.selected.clear();
    this.rebuild();
  }

  setFavorites(favs: Set<string>): void { this.favs = favs; this.paint(); }
  setActive(path: string): void { this.activePath = path; this.paint(); }

  setSelectMode(on: boolean): void {
    this.selectMode = on;
    if (!on) this.selected.clear();
    this.handlers.onSelectionChange(this.selected);
    this.paint();
  }

  /** Re-reads the given directory (or everything) from disk. */
  refresh(dir?: string): void {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
    this.rebuild();
  }

  expand(path: string): void {
    let p = path;
    while (p) { this.expanded.add(p); p = dirName(p); }
    this.rebuild();
  }

  private children(dir: string): Entry[] {
    let list = this.cache.get(dir);
    if (!list) {
      try { list = bridge.list(dir); } catch { list = []; }
      const showHidden = effective().showHidden;
      list = list.filter((e) => showHidden || (!e.name.startsWith('.') && !ALWAYS_HIDDEN.has(e.name)));
      list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1));
      this.cache.set(dir, list);
    }
    return list;
  }

  private rebuild(): void {
    this.rows = [];
    if (this.root) this.walk(this.root, 0);
    this.empty.textContent = this.root && this.rows.length === 0 ? t('emptyFolder') : '';
    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    this.paint();
  }

  private walk(dir: string, depth: number): void {
    for (const e of this.children(dir)) {
      const path = joinPath(dir, e.name);
      this.rows.push({ path, name: e.name, isDir: e.isDir, depth, size: e.size });
      if (e.isDir && this.expanded.has(path)) this.walk(path, depth + 1);
    }
  }

  private paint(): void {
    const top = this.el.scrollTop;
    const viewH = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 6);
    const last = Math.min(this.rows.length, Math.ceil((top + viewH) / ROW_H) + 6);
    this.viewport.style.transform = `translateY(${first * ROW_H}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.rowEl(this.rows[i]));
    this.viewport.replaceChildren(frag);
  }

  private rowEl(r: Row): HTMLElement {
    const isOpen = r.isDir && this.expanded.has(r.path);
    const el = h('div', {
      class: 'tree-row' + (r.path === this.activePath ? ' active' : '') + (this.selected.has(r.path) ? ' selected' : ''),
      style: { height: `${ROW_H}px`, paddingInlineStart: `${8 + r.depth * 16}px` },
      draggable: true,
      role: 'treeitem',
    },
      this.selectMode ? h('span', { class: 'chk' }, this.selected.has(r.path) ? '☑' : '☐') : null,
      h('span', { class: 'ti' }, fileIcon(r.name, r.isDir, isOpen)),
      h('span', { class: 'tn' }, r.name),
      this.favs.has(r.path) ? h('span', { class: 'fav' }, '★') : null,
    );

    let pressTimer: number | undefined;
    let longPressed = false;
    let sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => {
      longPressed = false; sx = e.clientX; sy = e.clientY;
      pressTimer = window.setTimeout(() => { longPressed = true; this.handlers.onMenu(r.path, r.isDir); }, 480);
    });
    const cancel = () => clearTimeout(pressTimer);
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    el.addEventListener('click', () => {
      if (longPressed) return;
      if (this.selectMode) { this.toggleSelect(r.path); return; }
      if (r.isDir) {
        if (this.expanded.has(r.path)) this.expanded.delete(r.path); else this.expanded.add(r.path);
        this.rebuild();
      } else this.handlers.onOpen(r.path);
    });

    el.addEventListener('dragstart', (e) => {
      const paths = this.selectMode && this.selected.has(r.path) ? [...this.selected] : [r.path];
      e.dataTransfer?.setData('text/forge-paths', JSON.stringify(paths));
      e.dataTransfer!.effectAllowed = 'move';
    });
    if (r.isDir) {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); el.classList.remove('drop');
        const raw = e.dataTransfer?.getData('text/forge-paths');
        if (raw) this.handlers.onMove(JSON.parse(raw) as string[], r.path);
      });
    }
    return el;
  }

  private toggleSelect(path: string): void {
    if (this.selected.has(path)) this.selected.delete(path); else this.selected.add(path);
    this.handlers.onSelectionChange(this.selected);
    this.paint();
  }

  /** Directories of the current project, for the "move/copy to" picker. */
  static listDirs(dir: string): string[] {
    try {
      return bridge.list(dir).filter((e) => e.isDir && e.name !== '.git').map((e) => joinPath(dir, e.name)).sort();
    } catch { return []; }
  }

  static displayName(path: string): string { return baseName(path); }
}

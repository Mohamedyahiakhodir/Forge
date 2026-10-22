import { bridge, onNative, toDevicePath, fromDevicePath, type DeviceStatus, type Entry, type RecentItem } from './native';
import { h, fullSheet, menuSheet, promptText, confirmBox, toast, fmtSize, fileIcon, baseName, dirName, joinPath, extOf } from './ui';
import { effective } from './settings';

const L = (ar: string, en: string): string => (effective().lang === 'ar' ? ar : en);

export interface DeviceHost {
  openFile: (devicePath: string) => void;
  openAsProject: (devicePath: string) => void;
  currentProject: () => string;
  onChanged: () => void;
}

type SortKey = 'modified' | 'name' | 'size' | 'type';
interface Sort { key: SortKey; desc: boolean }
const PAGE = 200;

const KINDS: Record<string, Set<string>> = {
  code: new Set(['html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'xml', 'md', 'py', 'php', 'java', 'kt', 'go', 'rs', 'dart', 'sh', 'yml', 'yaml', 'sql', 'txt']),
  images: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']),
  docs: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md']),
  media: new Set(['mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']),
};

// Native events are registered once; the open browser swaps these handlers.
let onAccess: ((s: DeviceStatus) => void) | null = null;
let onRecent: ((p: { items?: RecentItem[]; truncated?: boolean; error?: string }) => void) | null = null;
let onImported: (() => void) | null = null;
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  onNative('deviceAccessChanged', (s) => onAccess?.(s));
  onNative('deviceRecent', (p) => onRecent?.(p));
  onNative('filesImported', () => onImported?.());
}

function when(ms: number): string {
  const diff = Date.now() - ms;
  const lang = effective().lang;
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  const min = Math.round(diff / 60000);
  if (min < 1) return rtf.format(0, 'second');
  if (min < 60) return rtf.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (hr < 24) return rtf.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  if (day < 7) return rtf.format(-day, 'day');
  return new Date(ms).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function sortEntries(list: Entry[], s: Sort): Entry[] {
  const dir = s.desc ? -1 : 1;
  const cmp = (a: Entry, b: Entry): number => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always first
    switch (s.key) {
      case 'modified': return (a.mtime - b.mtime) * dir;
      case 'size': return (a.size - b.size) * dir;
      case 'type': return (extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name)) * dir;
      default: return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    }
  };
  return [...list].sort(cmp);
}

const ROOT_ICON: Record<string, string> = { internal: '📱', download: '⬇️', documents: '📄', dcim: '📷', pictures: '🖼', movies: '🎬', music: '🎵' };

export function openDeviceBrowser(host: DeviceHost): void {
  wire();
  let status: DeviceStatus = { granted: false, sdk: 0, roots: [] };
  try { status = bridge.deviceStatus(); } catch { /* not on Android */ }

  let tab: 'browse' | 'recent' = 'browse';
  let cwd = ''; // absolute path like /storage/emulated/0/Download; '' = list of locations
  let filter = '';
  let kind = 'all';
  let shown = PAGE;
  let sort: Sort = { key: 'modified', desc: true };
  try { const raw = bridge.kvGet('devsort'); if (raw) sort = { ...sort, ...JSON.parse(raw) }; } catch { /* default */ }
  let recent: RecentItem[] = [];
  let recentLoading = false;
  let recentTruncated = false;

  const body = h('div', { class: 'devfiles' });
  const sheet = fullSheet(L('ملفات الجهاز', 'Device files'), body);
  const closeObserver = new MutationObserver(() => { if (!document.body.contains(body)) { closeObserver.disconnect(); onAccess = onRecent = onImported = null; } });
  closeObserver.observe(document.body, { childList: true, subtree: true });

  const internal = () => status.roots.find((r) => r.key === 'internal')?.path ?? '/storage/emulated/0';
  const dev = (abs: string) => toDevicePath(abs);

  const finish = (devicePath: string) => { sheet.close(); host.openFile(devicePath); };

  function itemMenu(abs: string, isDir: boolean): void {
    const dpath = dev(abs);
    const name = baseName(abs);
    const project = host.currentProject();
    menuSheet(name, [
      isDir ? { label: L('فتح كمشروع', 'Open as project'), icon: '📂', run: () => { sheet.close(); host.openAsProject(dpath); } }
        : { label: L('فتح في المحرر', 'Open in editor'), icon: '✏️', run: () => finish(dpath) },
      ...(!isDir ? [
        { label: L('فتح بتطبيق آخر', 'Open with another app'), icon: '↗️', run: () => { try { bridge.openExternal(dpath); } catch (e: any) { toast(String(e.message ?? e)); } } },
        { label: L('مشاركة', 'Share'), icon: '📤', run: () => { try { bridge.shareFile(dpath); } catch (e: any) { toast(String(e.message ?? e)); } } },
      ] : []),
      ...(project && !project.startsWith('@device/') ? [{ label: L(`نسخ إلى مشروع "${project}"`, `Copy into project "${project}"`), icon: '📋', run: () => {
        try { bridge.copy(dpath, joinPath(project, name)); toast(L('اتنسخ للمشروع', 'Copied into the project')); host.onChanged(); } catch (e: any) { toast(String(e.message ?? e)); }
      } }] : []),
      { label: L('إعادة تسمية', 'Rename'), icon: '✏️', run: async () => {
        const n = await promptText(L('إعادة تسمية', 'Rename'), name);
        if (!n || n === name || n.includes('/')) return;
        try { bridge.rename(dpath, joinPath(dirName(dpath), n)); draw(); host.onChanged(); } catch (e: any) { toast(String(e.message ?? e)); }
      } },
      { label: L('نسخ المسار', 'Copy path'), icon: '🔗', run: () => { navigator.clipboard?.writeText(abs); toast(L('اتنسخ', 'Copied')); } },
      { label: '', sep: true, run: () => undefined },
      { label: L('حذف', 'Delete'), icon: '🗑', danger: true, run: async () => {
        if (!(await confirmBox(L(`حذف "${name}" نهائيًا من الجهاز؟ مش هتقدر ترجعه.`, `Permanently delete "${name}" from the device? This cannot be undone.`), true))) return;
        try { bridge.remove(dpath); draw(); host.onChanged(); } catch (e: any) { toast(String(e.message ?? e)); }
      } },
    ]);
  }

  function addMenu(): void {
    if (!cwd) { toast(L('افتح مجلد الأول', 'Open a folder first')); return; }
    const dpath = dev(cwd);
    menuSheet(L('إضافة هنا', 'Add here'), [
      { label: L('ملف جديد', 'New file'), icon: '📄', run: async () => {
        const n = await promptText(L('اسم الملف', 'File name'), '', 'index.html');
        if (!n || n.includes('/')) return;
        const target = joinPath(dpath, n);
        try { if (bridge.stat(target).exists) { toast(L('موجود بالفعل', 'Already exists')); return; } bridge.writeText(target, ''); draw(); host.onChanged(); } catch (e: any) { toast(String(e.message ?? e)); }
      } },
      { label: L('مجلد جديد', 'New folder'), icon: '📁', run: async () => {
        const n = await promptText(L('اسم المجلد', 'Folder name'));
        if (!n || n.includes('/')) return;
        try { bridge.mkdir(joinPath(dpath, n)); draw(); host.onChanged(); } catch (e: any) { toast(String(e.message ?? e)); }
      } },
      { label: L('استيراد ملفات من الجهاز…', 'Import files from the phone…'), icon: '📥', run: () => {
        onImported = () => { toast(L('تم الاستيراد', 'Imported')); draw(); host.onChanged(); };
        try { bridge.importFilesInto(dpath); } catch (e: any) { toast(String(e.message ?? e)); }
      } },
    ]);
  }

  function sortMenu(): void {
    const pick = (key: SortKey, desc: boolean) => () => { sort = { key, desc }; try { bridge.kvSet('devsort', JSON.stringify(sort)); } catch { /* ignore */ } shown = PAGE; draw(); };
    const mark = (key: SortKey, desc: boolean) => (sort.key === key && sort.desc === desc ? '✓ ' : '');
    menuSheet(L('الترتيب', 'Sort by'), [
      { label: mark('modified', true) + L('الأحدث تعديلًا', 'Modified — newest first'), icon: '🕘', run: pick('modified', true) },
      { label: mark('modified', false) + L('الأقدم تعديلًا', 'Modified — oldest first'), icon: '🕰', run: pick('modified', false) },
      { label: mark('name', false) + L('الاسم (أ → ي)', 'Name A → Z'), icon: '🔤', run: pick('name', false) },
      { label: mark('name', true) + L('الاسم (ي → أ)', 'Name Z → A'), icon: '🔡', run: pick('name', true) },
      { label: mark('size', true) + L('الأكبر حجمًا', 'Size — largest first'), icon: '📦', run: pick('size', true) },
      { label: mark('size', false) + L('الأصغر حجمًا', 'Size — smallest first'), icon: '🪶', run: pick('size', false) },
      { label: mark('type', false) + L('النوع', 'Type'), icon: '🏷', run: pick('type', false) },
    ]);
  }

  function row(opts: { icon: string; name: string; sub: string; onTap: () => void; onHold?: () => void }): HTMLElement {
    const el = h('div', { class: 'dev-row' },
      h('span', { class: 'ti' }, opts.icon),
      h('div', { class: 'dev-text' }, h('div', { class: 'tn' }, opts.name), h('div', { class: 'sub' }, opts.sub)));
    let timer: number | undefined; let held = false; let sx = 0, sy = 0;
    el.addEventListener('pointerdown', (e) => { held = false; sx = e.clientX; sy = e.clientY; if (opts.onHold) timer = window.setTimeout(() => { held = true; opts.onHold!(); }, 450); });
    const stop = () => clearTimeout(timer);
    el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) stop(); });
    el.addEventListener('pointerup', stop); el.addEventListener('pointercancel', stop);
    el.addEventListener('click', () => { if (!held) opts.onTap(); });
    return el;
  }

  function permissionCard(): HTMLElement {
    return h('div', { class: 'dev-perm' },
      h('div', { class: 'big' }, '🔐'),
      h('div', { class: 'et' }, L('محتاج إذن الوصول لملفات الجهاز', 'Access to device files is needed')),
      h('div', { class: 'sub' }, L(
        status.sdk >= 30
          ? 'علشان تفتح وتعدّل ملفاتك في Download وDocuments وغيرهم، أندرويد بيطلب منك تفعّل "السماح بالوصول لكل الملفات" للتطبيق. هتروح لإعدادات النظام، فعّل المفتاح وارجع.'
          : 'علشان تفتح وتعدّل ملفاتك على الجهاز، اسمح للتطبيق بالوصول للتخزين.',
        status.sdk >= 30
          ? 'To open and edit your files in Download, Documents and other folders, Android asks you to turn on "Allow access to all files" for this app. You will go to system settings; switch it on and come back.'
          : 'To open and edit your files on the device, allow the app to access storage.')),
      h('button', { class: 'btn primary', onclick: () => { try { bridge.deviceRequest(); } catch (e: any) { toast(String(e.message ?? e)); } } }, L('منح الإذن', 'Grant access')),
      h('div', { class: 'sub' }, L('بتقدر تشيله في أي وقت من نفس الإعدادات. التطبيق بيستخدمه فقط لما تفتح ملفاتك.', 'You can remove it any time from the same settings. The app only uses it when you open your files.')));
  }

  function chips(): HTMLElement {
    const defs: [string, string][] = [['all', L('الكل', 'All')], ['code', L('كود', 'Code')], ['images', L('صور', 'Images')], ['docs', L('مستندات', 'Docs')], ['media', L('وسائط', 'Media')]];
    return h('div', { class: 'chips' }, ...defs.map(([k, label]) => h('button', {
      class: 'chip' + (kind === k ? ' on' : ''), onclick: () => { kind = k; shown = PAGE; draw(); },
    }, label)));
  }

  const matches = (name: string): boolean => {
    if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return false;
    if (kind !== 'all' && !KINDS[kind].has(extOf(name))) return false;
    return true;
  };

  function listBlock(rows: HTMLElement[], total: number): HTMLElement {
    const box = h('div', { class: 'dev-list' }, ...rows);
    if (!rows.length) box.append(h('div', { class: 'empty-note' }, L('مفيش ملفات هنا', 'Nothing here')));
    if (total > shown) box.append(h('button', { class: 'btn wide', onclick: () => { shown += PAGE; draw(); } }, L(`عرض المزيد (${total - shown})`, `Show more (${total - shown})`)));
    return box;
  }

  function crumbs(): HTMLElement {
    const bar = h('div', { class: 'crumbs' });
    bar.append(h('button', { class: 'chip', onclick: () => { cwd = ''; shown = PAGE; draw(); } }, '🏠'));
    if (cwd) {
      const base = internal();
      let acc = '';
      const rel = cwd.startsWith(base) ? cwd.slice(base.length).split('/').filter(Boolean) : cwd.split('/').filter(Boolean);
      acc = cwd.startsWith(base) ? base : '';
      if (cwd.startsWith(base)) bar.append(h('button', { class: 'chip', onclick: () => { cwd = base; shown = PAGE; draw(); } }, L('الجهاز', 'Device')));
      for (const part of rel) {
        acc += '/' + part;
        const target = acc;
        bar.append(h('button', { class: 'chip', onclick: () => { cwd = target; shown = PAGE; draw(); } }, part));
      }
    }
    return bar;
  }

  function browseView(): HTMLElement[] {
    if (!cwd) {
      return [h('div', { class: 'dev-list' }, ...status.roots.map((r) => row({
        icon: r.key.startsWith('sd:') ? '💾' : ROOT_ICON[r.key] ?? '📁', name: r.key === 'internal' ? L('التخزين الداخلي', 'Internal storage') : r.name, sub: r.path,
        onTap: () => { cwd = r.path; shown = PAGE; draw(); },
      })))];
    }
    let entries: Entry[] = [];
    let error = '';
    try { entries = bridge.list(dev(cwd)); } catch (e: any) { error = String(e.message ?? e); }
    if (error) return [h('div', { class: 'empty-note' }, error)];
    const list = sortEntries(entries.filter((e) => (showHiddenFiles() || !e.name.startsWith('.')) && (e.isDir ? !filter || e.name.toLowerCase().includes(filter.toLowerCase()) : matches(e.name))), sort);
    const rows = list.slice(0, shown).map((e) => {
      const abs = cwd + '/' + e.name;
      return row({
        icon: fileIcon(e.name, e.isDir), name: e.name,
        sub: e.isDir ? L('مجلد', 'Folder') + ' · ' + when(e.mtime) : `${fmtSize(e.size)} · ${when(e.mtime)}`,
        onTap: () => (e.isDir ? (cwd = abs, shown = PAGE, filter = '', draw()) : finish(dev(abs))),
        onHold: () => itemMenu(abs, e.isDir),
      });
    });
    return [listBlock(rows, list.length)];
  }

  const showHiddenFiles = () => effective().showHidden;

  function recentView(): HTMLElement[] {
    if (recentLoading) return [h('div', { class: 'empty-note' }, L('جارٍ البحث عن أحدث الملفات…', 'Looking for the newest files…'))];
    const list = recent.filter((r) => matches(r.name));
    const rows = list.slice(0, shown).map((r) => row({
      icon: fileIcon(r.name, false), name: r.name, sub: `${when(r.mtime)} · ${fmtSize(r.size)} · ${dirName(r.path).replace(/^\/storage\/emulated\/0/, '') || '/'}`,
      onTap: () => finish(dev(r.path)), onHold: () => itemMenu(r.path, false),
    }));
    const out = [listBlock(rows, list.length)];
    if (recentTruncated) out.push(h('div', { class: 'sub pub-note' }, L('التخزين كبير، فالقائمة بتعرض أحدث ما لقيته في الوقت المتاح.', 'Storage is large, so this shows the newest files found in the time available.')));
    return out;
  }

  function loadRecent(): void {
    recentLoading = true; draw();
    onRecent = (p) => {
      recentLoading = false;
      if (p.error) toast(p.error);
      recent = (p.items ?? []).map((i) => ({ ...i }));
      recentTruncated = !!p.truncated;
      if (tab === 'recent') draw();
    };
    try { bridge.deviceRecent(dev(internal()), 120); } catch (e: any) { recentLoading = false; toast(String(e.message ?? e)); draw(); }
  }

  function draw(): void {
    body.replaceChildren();
    if (!status.granted) { body.append(permissionCard()); return; }

    body.append(h('div', { class: 'seg' },
      h('button', { class: tab === 'browse' ? 'on' : '', onclick: () => { tab = 'browse'; shown = PAGE; draw(); } }, L('التصفح', 'Browse')),
      h('button', { class: tab === 'recent' ? 'on' : '', onclick: () => { tab = 'recent'; shown = PAGE; loadRecent(); } }, L('الأحدث تعديلًا', 'Recently modified'))));

    if (tab === 'browse') body.append(crumbs());

    const search = h('input', { class: 'field small', type: 'search', placeholder: L('تصفية بالاسم…', 'Filter by name…'), value: filter, autocapitalize: 'off', spellcheck: false });
    search.addEventListener('input', () => { filter = search.value; shown = PAGE; redrawList(); });
    body.append(h('div', { class: 'dev-tools' }, search,
      tab === 'browse' ? h('button', { class: 'icon-btn', 'aria-label': L('الترتيب', 'Sort'), onclick: sortMenu }, '⇅') : '',
      tab === 'browse' ? h('button', { class: 'icon-btn', 'aria-label': L('إضافة', 'Add'), onclick: addMenu }, '＋') : ''));
    body.append(chips());
    listHost = h('div', {});
    body.append(listHost);
    redrawList();
  }

  let listHost: HTMLElement = h('div', {});
  function redrawList(): void { listHost.replaceChildren(...(tab === 'browse' ? browseView() : recentView())); }

  onAccess = (s) => { const was = status.granted; status = s; if (s.granted !== was || !s.granted) { if (s.granted && !cwd) cwd = ''; draw(); } };
  draw();
}

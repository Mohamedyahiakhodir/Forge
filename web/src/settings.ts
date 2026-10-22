import { bridge } from './native';

export interface Settings {
  lang: 'ar' | 'en';
  theme: string;
  font: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  useTabs: boolean;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoCloseTags: boolean;
  formatOnSave: boolean;
  autosaveMs: number; // 0 = off
  keymap: 'default' | 'vim';
  rtl: boolean;
  showHidden: boolean;
  customKeys: string;
}

export const DEFAULTS: Settings = {
  lang: 'ar',
  theme: 'dracula',
  font: 'jetbrains',
  fontSize: 14,
  lineHeight: 1.5,
  tabSize: 2,
  useTabs: false,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  autoCloseTags: true,
  formatOnSave: false,
  autosaveMs: 1000,
  keymap: 'default',
  rtl: false,
  showHidden: false,
  customKeys: '=> `` ${} </ /> ?. ...',
};

export const FONTS: Record<string, { label: string; css: string }> = {
  jetbrains: { label: 'JetBrains Mono', css: "'JetBrains Mono', monospace" },
  fira: { label: 'Fira Code', css: "'Fira Code', monospace" },
  monospace: { label: 'System monospace', css: 'monospace' },
  serifmono: { label: 'Serif monospace', css: 'serif-monospace, monospace' },
};

let current: Settings = { ...DEFAULTS };
let projectOverride: Partial<Settings> = {};
const subs = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();

export function loadSettings(): Settings {
  try {
    const raw = bridge.kvGet('settings');
    if (raw) current = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* corrupt settings fall back to defaults */ }
  return effective();
}

export function effective(): Settings {
  return { ...current, ...projectOverride };
}

export function globalSettings(): Settings {
  return current;
}

export function setProjectOverride(o: Partial<Settings>): void {
  const before = effective();
  projectOverride = o;
  emit(before);
}

export function update(patch: Partial<Settings>): void {
  const before = effective();
  current = { ...current, ...patch };
  try { bridge.kvSet('settings', JSON.stringify(current)); } catch { /* ignore */ }
  emit(before);
}

function emit(before: Settings): void {
  const after = effective();
  const changed = (Object.keys(after) as (keyof Settings)[]).filter((k) => after[k] !== before[k]);
  if (changed.length) subs.forEach((f) => f(after, changed));
}

export function subscribe(fn: (s: Settings, changed: (keyof Settings)[]) => void): void {
  subs.add(fn);
}

export const PROJECT_KEYS: (keyof Settings)[] = ['tabSize', 'useTabs', 'wordWrap', 'formatOnSave', 'autoCloseTags', 'lineHeight'];

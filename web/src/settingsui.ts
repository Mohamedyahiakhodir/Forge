import { h, fullSheet, toast } from './ui';
import { t } from './i18n';
import { effective, globalSettings, update, FONTS, PROJECT_KEYS, type Settings } from './settings';
import { THEMES } from './themes';
import { bridge } from './native';

export function openSettings(project: string, relabel: () => void): void {
  const body = h('div', { class: 'settings' });
  const sheet = fullSheet(t('settings'), body);

  const section = (title: string) => body.append(h('div', { class: 'set-section' }, title));
  const row = (label: string, control: HTMLElement) => body.append(h('label', { class: 'set-row' }, h('span', {}, label), control));

  const select = <K extends keyof Settings>(key: K, options: [string, string][], after?: () => void) => {
    const s = h('select', { class: 'field' });
    for (const [v, l] of options) s.append(h('option', { value: v, selected: String(globalSettings()[key]) === v }, l));
    s.addEventListener('change', () => { update({ [key]: s.value } as Partial<Settings>); after?.(); });
    return s;
  };
  const num = <K extends keyof Settings>(key: K, min: number, max: number, step = 1) => {
    const i = h('input', { class: 'field num', type: 'number', min, max, step, value: String(globalSettings()[key]) });
    i.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(i.value) || min));
      i.value = String(v);
      update({ [key]: v } as Partial<Settings>);
    });
    return i;
  };
  const bool = <K extends keyof Settings>(key: K) => {
    const i = h('input', { type: 'checkbox', class: 'switch', checked: !!globalSettings()[key] });
    i.addEventListener('change', () => update({ [key]: i.checked } as Partial<Settings>));
    return i;
  };

  section(t('appearance'));
  row(t('language'), select('lang', [['ar', 'العربية'], ['en', 'English']], () => { relabel(); sheet.close(); openSettings(project, relabel); }));
  row(t('theme'), select('theme', THEMES.map((x) => [x.id, x.label])));
  row(t('font'), select('font', Object.entries(FONTS).map(([k, v]) => [k, v.label])));
  row(t('fontSize'), num('fontSize', 8, 32));
  row(t('lineHeight'), num('lineHeight', 1, 2.4, 0.1));

  section(t('editor'));
  row(t('tabSize'), num('tabSize', 1, 8));
  row(t('useTabs'), bool('useTabs'));
  row(t('wordWrap'), bool('wordWrap'));
  row(t('lineNumbers'), bool('lineNumbers'));
  row(t('minimap'), bool('minimap'));
  row(t('autoCloseTags'), bool('autoCloseTags'));
  row(t('formatOnSave'), bool('formatOnSave'));
  row(t('rtl'), bool('rtl'));
  row(t('autosave'), select('autosaveMs', [['0', t('autosaveOff')], ['500', '0.5 s'], ['1000', '1 s'], ['2000', '2 s'], ['5000', '5 s']]));
  row(t('keymap'), select('keymap', [['default', 'Default'], ['vim', 'Vim']]));
  const keys = h('input', { class: 'field', value: globalSettings().customKeys, autocapitalize: 'off', spellcheck: false, placeholder: t('customKeysHint') });
  keys.addEventListener('change', () => update({ customKeys: keys.value }));
  row(t('customKeys'), keys);

  // autosaveMs is stored as a number
  body.querySelectorAll('select').forEach((s) => {
    if ([...s.options].some((o) => o.value === '500')) {
      s.addEventListener('change', () => update({ autosaveMs: Number(s.value) }));
    }
  });

  if (project) {
    section(t('projectSettings'));
    body.append(h('button', {
      class: 'btn wide',
      onclick: () => {
        const eff = effective();
        const out: Record<string, unknown> = {};
        for (const k of PROJECT_KEYS) out[k] = eff[k];
        try {
          bridge.writeText(`${project}/.forge/settings.json`, JSON.stringify(out, null, 2) + '\n');
          toast(t('savedForProject'));
        } catch (e: any) { toast(String(e.message ?? e)); }
      },
    }, t('saveForProject')));
  }
}

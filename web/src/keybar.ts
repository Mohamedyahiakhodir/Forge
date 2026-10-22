import { indentMore, indentLess, undo, redo, cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown, cursorLineBoundaryBackward, cursorLineBoundaryForward } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { h } from './ui';
import { effective } from './settings';

const SYMBOLS = ['{', '}', '(', ')', '[', ']', '<', '>', ';', ':', '"', "'", '=', '/', '\\', '|', '&', '!', '#', '$', '%'];

type Run = (v: EditorView) => void;

/**
 * Keyboard helper bar. Buttons use pointerdown + preventDefault so the editor never loses focus
 * (and the soft keyboard stays open) while they are tapped.
 */
export function buildKeybar(getView: () => EditorView): { el: HTMLElement; rebuild: () => void } {
  const row1 = h('div', { class: 'kb-row' });
  const row2 = h('div', { class: 'kb-row custom' });
  const el = h('div', { class: 'keybar', id: 'keybar' }, row1, row2);

  const btn = (label: string, run: Run, cls = '') => {
    const b = h('button', { class: 'kb ' + cls, type: 'button', tabIndex: -1 }, label);
    const fire = (e: Event) => { e.preventDefault(); const v = getView(); run(v); v.focus(); };
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', fire);
    return b;
  };
  const ins = (s: string): Run => (v) => v.dispatch(v.state.replaceSelection(s), { scrollIntoView: true, userEvent: 'input' });

  const rebuild = () => {
    row1.replaceChildren(
      btn('Tab', indentMore, 'wide'),
      btn('⇤', indentLess),
      btn('↶', (v) => undo(v)),
      btn('↷', (v) => redo(v)),
      btn('←', (v) => cursorCharLeft(v)),
      btn('↑', (v) => cursorLineUp(v)),
      btn('↓', (v) => cursorLineDown(v)),
      btn('→', (v) => cursorCharRight(v)),
      btn('Home', (v) => cursorLineBoundaryBackward(v), 'wide'),
      btn('End', (v) => cursorLineBoundaryForward(v), 'wide'),
      ...SYMBOLS.map((s) => btn(s, ins(s))),
    );
    const custom = effective().customKeys.split(/\s+/).filter(Boolean);
    row2.replaceChildren(...custom.map((k) => btn(k, ins(k), 'wide')));
    row2.style.display = custom.length ? '' : 'none';
  };
  rebuild();
  return { el, rebuild };
}

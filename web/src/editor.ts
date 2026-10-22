import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor,
  rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, indentMore, toggleComment, moveLineUp, moveLineDown,
  copyLineDown, addCursorAbove, addCursorBelow,
} from '@codemirror/commands';
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, foldAll, unfoldAll,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, snippetCompletion, completeFromList } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, selectNextOccurrence, openSearchPanel, gotoLine } from '@codemirror/search';
import { linter, lintKeymap, lintGutter, type Diagnostic } from '@codemirror/lint';
import { expandAbbreviation } from '@emmetio/codemirror6-plugin';
import { showMinimap } from '@replit/codemirror-minimap';
import { effective, FONTS, type Settings } from './settings';
import { langFor, type LangInfo } from './languages';
import { themeById } from './themes';

// One set of compartments shared by every tab state; they are re-applied on each tab switch.
const C = {
  theme: new Compartment(), font: new Compartment(), tab: new Compartment(), wrap: new Compartment(),
  nums: new Compartment(), lang: new Compartment(), keys: new Compartment(), mini: new Compartment(),
  ro: new Compartment(), dir: new Compartment(), lint: new Compartment(),
};

let view: EditorView;
let lintWorker: Worker | undefined;
let lintSeq = 0;
const lintWaiters = new Map<number, (d: Diagnostic[]) => void>();

function getLintWorker(): Worker | undefined {
  if (lintWorker) return lintWorker;
  try {
    lintWorker = new Worker('lint.worker.js');
    lintWorker.onmessage = (e) => { lintWaiters.get(e.data.id)?.(e.data.diagnostics.map((d: any) => ({ ...d, severity: 'error' }))); lintWaiters.delete(e.data.id); };
    lintWorker.onerror = () => { lintWorker = undefined; };
  } catch { lintWorker = undefined; }
  return lintWorker;
}

const jsLinter = linter(async (v) => {
  const w = getLintWorker();
  if (!w) return [];
  const code = v.state.doc.toString();
  if (code.length > 400_000) return [];
  const id = ++lintSeq;
  const result = await new Promise<Diagnostic[]>((res) => { lintWaiters.set(id, res); w.postMessage({ id, code }); setTimeout(() => res([]), 4000); });
  return result.map((d) => ({ ...d, from: Math.min(d.from, code.length), to: Math.min(Math.max(d.to, d.from), code.length) }));
}, { delay: 600 });

async function lintFor(lang: LangInfo): Promise<Extension> {
  if (lang.id === 'json') {
    const { jsonParseLinter } = await import('@codemirror/lang-json');
    return [linter(jsonParseLinter(), { delay: 500 }), lintGutter()];
  }
  if (lang.id === 'javascript') return [jsLinter, lintGutter()];
  return [];
}

const SNIPPETS = [
  snippetCompletion('console.log(${1})', { label: 'log', detail: 'console.log', type: 'text' }),
  snippetCompletion('function ${name}(${args}) {\n\t${}\n}', { label: 'fn', detail: 'function', type: 'text' }),
  snippetCompletion('const ${name} = (${args}) => {\n\t${}\n};', { label: 'afn', detail: 'arrow function', type: 'text' }),
  snippetCompletion('for (let ${i} = 0; ${i} < ${n}; ${i}++) {\n\t${}\n}', { label: 'for', detail: 'for loop', type: 'text' }),
  snippetCompletion('if (${cond}) {\n\t${}\n}', { label: 'if', detail: 'if', type: 'text' }),
  snippetCompletion('async function ${name}(${args}) {\n\ttry {\n\t\t${}\n\t} catch (e) {\n\t\tconsole.error(e);\n\t}\n}', { label: 'afunc', detail: 'async + try/catch', type: 'text' }),
  snippetCompletion('document.querySelector(\'${sel}\')', { label: 'qs', detail: 'querySelector', type: 'text' }),
  snippetCompletion('addEventListener(\'${click}\', (e) => {\n\t${}\n});', { label: 'ael', detail: 'addEventListener', type: 'text' }),
  snippetCompletion('fetch(\'${url}\')\n\t.then((r) => r.json())\n\t.then((data) => {\n\t\t${}\n\t});', { label: 'fetch', detail: 'fetch json', type: 'text' }),
  snippetCompletion('def ${name}(${args}):\n\t${pass}', { label: 'def', detail: 'python def', type: 'text' }),
  snippetCompletion('<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1">\n\t<title>${Document}</title>\n</head>\n<body>\n\t${}\n</body>\n</html>', { label: 'html5', detail: 'HTML5 boilerplate', type: 'text' }),
];

function fontTheme(s: Settings): Extension {
  return EditorView.theme({
    '&': { fontSize: `${s.fontSize}px` },
    '.cm-scroller': { fontFamily: (FONTS[s.font] ?? FONTS.jetbrains).css, lineHeight: String(s.lineHeight) },
    '.cm-gutters': { fontSize: `${Math.max(10, s.fontSize - 2)}px` },
  });
}

const tabKeymap = (getLang: () => string) => keymap.of([{
  key: 'Tab',
  run: (v) => {
    const id = getLang();
    if (id === 'html' || id === 'css' || id === 'scss') {
      if (v.state.selection.main.empty && expandAbbreviation({ state: v.state, dispatch: v.dispatch })) return true;
    }
    return indentMore(v);
  },
}, indentWithTab]);

function minimapExt(on: boolean): Extension {
  return showMinimap.compute(['doc'], () => (on ? { create: () => ({ dom: document.createElement('div') }), displayText: 'blocks', showOverlay: 'always' } : null));
}

function keymapExt(s: Settings): Promise<Extension> {
  if (s.keymap === 'vim') return import('@replit/codemirror-vim').then((m) => m.vim());
  return Promise.resolve([]);
}

export interface EditorCallbacks {
  onDocChanged: () => void;
  onSelection: () => void;
}

let currentLangId = 'plain';
let callbacks: EditorCallbacks;

export function createView(parent: HTMLElement, cb: EditorCallbacks): EditorView {
  callbacks = cb;
  view = new EditorView({ parent, state: makeState('', 'untitled.txt', []) });
  return view;
}

export function getView(): EditorView { return view; }

export function makeState(doc: string, path: string, langExt: Extension, readOnly = false): EditorState {
  const s = effective();
  return EditorState.create({
    doc,
    extensions: [
      C.lang.of(langExt),
      C.theme.of(themeById(s.theme).ext),
      C.font.of(fontTheme(s)),
      C.tab.of([EditorState.tabSize.of(s.tabSize), indentUnit.of(s.useTabs ? '\t' : ' '.repeat(s.tabSize))]),
      C.wrap.of(s.wordWrap ? EditorView.lineWrapping : []),
      C.nums.of(s.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
      C.keys.of([]),
      C.mini.of(minimapExt(s.minimap)),
      C.ro.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      C.dir.of(s.rtl ? EditorView.contentAttributes.of({ dir: 'rtl' }) : []),
      C.lint.of([]),
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, override: undefined }),
      EditorState.languageData.of(() => [{ autocomplete: completeFromList(SNIPPETS) }]),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      EditorView.perLineTextDirection.of(true),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-path': path }),
      tabKeymap(() => currentLangId),
      keymap.of([
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) callbacks.onDocChanged();
        if (u.selectionSet || u.docChanged) callbacks.onSelection();
      }),
    ],
  });
}

export async function loadLangExt(path: string): Promise<{ info: LangInfo; ext: Extension }> {
  const info = langFor(path);
  let ext: Extension = [];
  try { ext = await info.load(); } catch { /* language failed to load: plain text */ }
  return { info, ext };
}

/** Re-applies every setting-driven compartment to the state currently shown in the view. */
export async function applySettings(langId: string, readOnly = false): Promise<void> {
  const s = effective();
  currentLangId = langId;
  const lint = await lintFor({ id: langId, label: '', load: async () => [] });
  const keys = await keymapExt(s);
  view.dispatch({
    effects: [
      C.theme.reconfigure(themeById(s.theme).ext),
      C.font.reconfigure(fontTheme(s)),
      C.tab.reconfigure([EditorState.tabSize.of(s.tabSize), indentUnit.of(s.useTabs ? '\t' : ' '.repeat(s.tabSize))]),
      C.wrap.reconfigure(s.wordWrap ? EditorView.lineWrapping : []),
      C.nums.reconfigure(s.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : []),
      C.keys.reconfigure(keys),
      C.mini.reconfigure(minimapExt(s.minimap)),
      C.ro.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      C.dir.reconfigure(s.rtl ? EditorView.contentAttributes.of({ dir: 'rtl' }) : []),
      C.lint.reconfigure(lint),
    ],
  });
}

export function setLanguage(ext: Extension): void {
  view.dispatch({ effects: C.lang.reconfigure(ext) });
}

export function insertText(text: string): void {
  view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

export const commands = {
  find: () => openSearchPanel(view),
  gotoLine: () => gotoLine(view),
  comment: () => toggleComment(view),
  lineUp: () => moveLineUp(view),
  lineDown: () => moveLineDown(view),
  duplicate: () => copyLineDown(view),
  nextOccurrence: () => selectNextOccurrence(view),
  cursorAbove: () => addCursorAbove(view),
  cursorBelow: () => addCursorBelow(view),
  foldAll: () => foldAll(view),
  unfoldAll: () => unfoldAll(view),
  emmet: () => expandAbbreviation({ state: view.state, dispatch: view.dispatch }),
};

/** Pinch-to-zoom: reports a scale factor relative to the gesture start. */
export function enablePinchZoom(el: HTMLElement, getSize: () => number, setSize: (n: number) => void): void {
  let startDist = 0;
  let startSize = 0;
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { startDist = dist(e); startSize = getSize(); }
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) {
      e.preventDefault();
      setSize(Math.round(Math.min(32, Math.max(8, startSize * (dist(e) / startDist)))));
    }
  }, { passive: false });
  el.addEventListener('touchend', (e) => { if (e.touches.length < 2) startDist = 0; }, { passive: true });
}

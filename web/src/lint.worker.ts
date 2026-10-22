// Syntax-error linting for JavaScript, run off the main thread.
import { parse } from 'acorn';

interface Req { id: number; code: string }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, code } = e.data;
  const out: { from: number; to: number; message: string }[] = [];
  try {
    parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
  } catch (err: any) {
    const pos: number = typeof err.pos === 'number' ? err.pos : 0;
    out.push({ from: pos, to: Math.min(code.length, pos + 1), message: String(err.message).replace(/\s*\(\d+:\d+\)$/, '') });
  }
  (self as unknown as Worker).postMessage({ id, diagnostics: out });
};

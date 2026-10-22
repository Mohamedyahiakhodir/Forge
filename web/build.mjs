// Bundles the editor web app. Usage: node build.mjs [--out <dir>]
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argIdx = process.argv.indexOf('--out');
const out = resolve(here, argIdx > 0 ? process.argv[argIdx + 1] : 'dist');
const watch = process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: true,
  target: ['chrome100'],
  minify: !watch,
  sourcemap: false,
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  logLevel: 'info',
});

await build({
  entryPoints: { 'lint.worker': resolve(here, 'src/lint.worker.ts') },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: ['chrome100'],
  minify: !watch,
  logLevel: 'info',
});

copyFileSync(resolve(here, 'src/index.html'), resolve(out, 'index.html'));
copyFileSync(resolve(here, 'src/style.css'), resolve(out, 'style.css'));

// DevTools injected into the preview page on demand (served to the preview WebView only).
const eruda = resolve(here, 'node_modules/eruda/eruda.js');
if (existsSync(eruda)) copyFileSync(eruda, resolve(out, 'eruda.js'));

mkdirSync(resolve(out, 'fonts'), { recursive: true });
const fontFiles = [
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono.woff2'],
  ['@fontsource/fira-code/files/fira-code-latin-400-normal.woff2', 'fira-code.woff2'],
];
for (const [src, dst] of fontFiles) {
  const p = resolve(here, 'node_modules', src);
  if (existsSync(p)) copyFileSync(p, resolve(out, 'fonts', dst));
}
console.log('web build ->', out);

import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';
import { extOf, baseName } from './ui';

export interface LangInfo { id: string; label: string; load: () => Promise<Extension> }

const stream = async (p: Promise<any>, key: string): Promise<Extension> => StreamLanguage.define((await p)[key]);

const LANGS: Record<string, LangInfo> = {
  html: { id: 'html', label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html({ autoCloseTags: true }) },
  css: { id: 'css', label: 'CSS', load: async () => (await import('@codemirror/lang-css')).css() },
  scss: { id: 'scss', label: 'SCSS', load: async () => (await import('@codemirror/lang-css')).css() },
  javascript: { id: 'javascript', label: 'JavaScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }) },
  typescript: { id: 'typescript', label: 'TypeScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }) },
  json: { id: 'json', label: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() },
  markdown: { id: 'markdown', label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() },
  xml: { id: 'xml', label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() },
  yaml: { id: 'yaml', label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() },
  python: { id: 'python', label: 'Python', load: async () => (await import('@codemirror/lang-python')).python() },
  php: { id: 'php', label: 'PHP', load: async () => (await import('@codemirror/lang-php')).php() },
  sql: { id: 'sql', label: 'SQL', load: async () => (await import('@codemirror/lang-sql')).sql() },
  java: { id: 'java', label: 'Java', load: async () => (await import('@codemirror/lang-java')).java() },
  cpp: { id: 'cpp', label: 'C/C++', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  go: { id: 'go', label: 'Go', load: async () => (await import('@codemirror/lang-go')).go() },
  rust: { id: 'rust', label: 'Rust', load: async () => (await import('@codemirror/lang-rust')).rust() },
  kotlin: { id: 'kotlin', label: 'Kotlin', load: () => stream(import('@codemirror/legacy-modes/mode/clike'), 'kotlin') },
  dart: { id: 'dart', label: 'Dart', load: () => stream(import('@codemirror/legacy-modes/mode/clike'), 'dart') },
  shell: { id: 'shell', label: 'Shell', load: () => stream(import('@codemirror/legacy-modes/mode/shell'), 'shell') },
};

const EXT: Record<string, string> = {
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', css: 'css', scss: 'scss', less: 'css',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  json: 'json', map: 'json', webmanifest: 'json', md: 'markdown', markdown: 'markdown', xml: 'xml', svg: 'xml', xsd: 'xml', plist: 'xml',
  yaml: 'yaml', yml: 'yaml', py: 'python', pyw: 'python', php: 'php', sql: 'sql', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cxx: 'cpp', go: 'go', rs: 'rust', dart: 'dart',
  sh: 'shell', bash: 'shell', zsh: 'shell', env: 'shell',
};

export const PLAIN: LangInfo = { id: 'plain', label: 'Plain text', load: async () => [] };

export function langFor(path: string): LangInfo {
  const name = baseName(path).toLowerCase();
  if (name === 'dockerfile' || name === '.bashrc' || name === '.profile') return LANGS.shell;
  return LANGS[EXT[extOf(path)]] ?? PLAIN;
}

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', '3gp']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
export const KNOWN_BINARY_EXT = new Set(['zip', 'apk', 'jar', 'so', 'dex', 'class', 'exe', 'bin', 'ttf', 'otf', 'woff', 'woff2', 'gz', 'tar', '7z', 'rar']);

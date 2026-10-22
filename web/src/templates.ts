export interface Template { id: string; labelKey: string; files: Record<string, string> }

const htmlPage = (title: string, head: string, body: string) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
${head}
</head>
<body>
${body}
</body>
</html>
`;

const html5: Record<string, string> = {
  'index.html': htmlPage('My Page', '  <link rel="stylesheet" href="style.css">', '  <h1>Hello, Forge!</h1>\n  <script src="script.js"></script>'),
  'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n  padding: 2rem;\n}\n',
  'script.js': "console.log('Hello from Forge');\n",
};

export const TEMPLATES: Template[] = [
  { id: 'blank', labelKey: 'tplBlank', files: { 'README.md': '# New project\n' } },
  { id: 'html5', labelKey: 'tplHtml5', files: html5 },
  {
    id: 'bootstrap', labelKey: 'tplBootstrap',
    files: {
      'index.html': htmlPage('Bootstrap', '  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">',
        '  <div class="container py-5">\n    <h1 class="display-5">Hello, Bootstrap</h1>\n    <button class="btn btn-primary mt-3" id="btn">Click me</button>\n  </div>\n  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>\n  <script src="script.js"></script>'),
      'script.js': "document.getElementById('btn').onclick = () => alert('Hi!');\n",
    },
  },
  {
    id: 'tailwind', labelKey: 'tplTailwind',
    files: {
      'index.html': htmlPage('Tailwind', '  <script src="https://cdn.tailwindcss.com"></script>',
        '  <main class="min-h-screen grid place-items-center bg-slate-900 text-white">\n    <h1 class="text-4xl font-bold">Hello, Tailwind</h1>\n  </main>'),
    },
  },
  {
    id: 'react', labelKey: 'tplReact',
    files: {
      'index.html': htmlPage('React', '', '  <div id="root"></div>\n  <script type="module" src="app.js"></script>'),
      'app.js': "import React, { useState } from 'https://esm.sh/react@18';\nimport { createRoot } from 'https://esm.sh/react-dom@18/client';\n\nfunction App() {\n  const [n, setN] = useState(0);\n  return React.createElement('button', { onClick: () => setN(n + 1) }, `Clicked ${n} times`);\n}\n\ncreateRoot(document.getElementById('root')).render(React.createElement(App));\n",
    },
  },
  {
    id: 'vue', labelKey: 'tplVue',
    files: {
      'index.html': htmlPage('Vue', '  <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>',
        '  <div id="app">\n    <button @click="count++">Clicked {{ count }} times</button>\n  </div>\n  <script src="app.js"></script>'),
      'app.js': "Vue.createApp({ data: () => ({ count: 0 }) }).mount('#app');\n",
    },
  },
  {
    id: 'node', labelKey: 'tplNode',
    files: {
      'package.json': '{\n  "name": "express-app",\n  "version": "1.0.0",\n  "main": "server.js",\n  "scripts": { "start": "node server.js" },\n  "dependencies": { "express": "^4.19.2" }\n}\n',
      'server.js': "const express = require('express');\nconst app = express();\n\napp.get('/', (req, res) => res.send('Hello from Express'));\n\napp.listen(3000, () => console.log('Listening on http://localhost:3000'));\n",
      '.gitignore': 'node_modules\n',
    },
  },
  {
    id: 'pwa', labelKey: 'tplPwa',
    files: {
      'index.html': htmlPage('PWA', '  <link rel="manifest" href="manifest.webmanifest">\n  <link rel="stylesheet" href="style.css">',
        '  <h1>My PWA</h1>\n  <script>\n    if (\'serviceWorker\' in navigator) navigator.serviceWorker.register(\'sw.js\');\n  </script>'),
      'style.css': html5['style.css'],
      'manifest.webmanifest': '{\n  "name": "My PWA",\n  "short_name": "PWA",\n  "start_url": "./index.html",\n  "display": "standalone",\n  "background_color": "#ffffff",\n  "theme_color": "#1e88e5",\n  "icons": []\n}\n',
      'sw.js': "const CACHE = 'v1';\nconst FILES = ['./', './index.html', './style.css'];\n\nself.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))));\nself.addEventListener('fetch', (e) => e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request))));\n",
    },
  },
];

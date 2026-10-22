import { loadSettings } from './settings';
import { boot } from './app';

loadSettings();
boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('empty-editor');
  if (el) el.textContent = 'Startup error: ' + String(e?.message ?? e);
});

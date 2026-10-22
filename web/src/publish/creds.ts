import { bridge } from '../native';
import { h, toast, extOf } from '../ui';
import { L, saveConfig, type PublishConfig } from './config';
import { classify, inspectGoogleServices } from './creds-logic';
import { pickFileIntoProject } from './keys';

function copy(text: string): void {
  const done = () => toast(L('اتنسخ', 'Copied'));
  if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done, () => fallback()); return; }
  fallback();
  function fallback() {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast(text); }
    ta.remove();
  }
}

const details = (title: string, body: string) =>
  h('details', { class: 'help' }, h('summary', {}, title), h('div', { class: 'help-body' }, body));

export function renderCredsSection(box: HTMLElement, project: string, cfg: PublishConfig, onChange: () => void): void {
  const gsPath = `${project}/.forge/google-services.json`;

  const draw = () => {
    box.replaceChildren();
    const status = h('div', { class: 'sub pub-status' });

    box.append(h('div', { class: 'pub-note' }, L(
      'اختياري — محتاجه لو تطبيقك فيه تسجيل دخول بجوجل أو إشعارات Firebase. الصق أي حاجة من اللي الأداة بتطلبها (ملف JSON، Client ID، بصمة SHA) والأداة تعرف نوعها وتحطها في مكانها الصح.',
      'Optional — needed if your app uses Google sign-in or Firebase notifications. Paste anything the tool asks for (JSON file text, Client ID, SHA fingerprint) and it will recognise it and put it in the right place.')));

    const paste = h('textarea', { class: 'field paste', rows: 4, placeholder: L('الصق هنا: محتوى google-services.json، أو Client ID، أو بصمة SHA-1/SHA-256', 'Paste here: google-services.json content, a Client ID, or an SHA-1/SHA-256 fingerprint'), spellcheck: false, autocapitalize: 'off' });
    const apply = (text: string) => {
      const p = classify(text);
      switch (p.kind) {
        case 'google-services': {
          const insp = inspectGoogleServices(p.json, cfg.packageId.trim());
          bridge.writeText(gsPath, JSON.stringify(p.json, null, 2) + '\n');
          if (!cfg.googleClientId && insp.webClientId) cfg.googleClientId = insp.webClientId;
          status.textContent = insp.matchesPackage
            ? L(`✅ اتحفظ ملف Firebase (${insp.projectId}) واتسحب الـWeb Client ID منه.`, `✅ Firebase file saved (${insp.projectId}) and the Web Client ID was taken from it.`)
            : L(`⚠️ اتحفظ الملف بس هو لتطبيق مختلف (${insp.packages.join('، ')}). شوف الفحص تحت.`, `⚠️ Saved, but it is for a different app (${insp.packages.join(', ')}). See the checks below.`);
          break;
        }
        case 'client-id': cfg.googleClientId = p.value; status.textContent = L('✅ اتحفظ Google Client ID.', '✅ Google Client ID saved.'); break;
        case 'sha1': cfg.playSha1 = p.value; status.textContent = L('✅ اتحفظت بصمة SHA-1 الخاصة بتوقيع Google Play.', '✅ Google Play signing SHA-1 saved.'); break;
        case 'sha256': cfg.playSha256 = p.value; status.textContent = L('✅ اتحفظت بصمة SHA-256 الخاصة بتوقيع Google Play.', '✅ Google Play signing SHA-256 saved.'); break;
        default:
          status.textContent = L('❌ مقدرتش أتعرّف على النص. المدعوم: محتوى ملف google-services.json كامل، أو Client ID بشكل 123-abc.apps.googleusercontent.com، أو بصمة SHA-1 (20 بايت) أو SHA-256 (32 بايت).',
            '❌ I could not recognise the text. Supported: the full google-services.json content, a Client ID like 123-abc.apps.googleusercontent.com, or an SHA-1 (20 bytes) / SHA-256 (32 bytes) fingerprint.');
          return;
      }
      saveConfig(project, cfg);
      onChange();
      const msg = status.textContent;
      draw();
      box.querySelector('.pub-status')!.textContent = msg;
    };

    box.append(paste,
      h('div', { class: 'row wrap gap' },
        h('button', { class: 'btn primary', onclick: () => { if (paste.value.trim()) apply(paste.value); else status.textContent = L('الصق نص الأول.', 'Paste some text first.'); } }, L('تحليل وحفظ', 'Analyse and save')),
        h('button', { class: 'btn', onclick: () => pickFileIntoProject(project, (path) => {
          if (extOf(path) !== 'json') { try { bridge.remove(path); } catch { /* ignore */ } status.textContent = L('الملف مش .json. اختار google-services.json.', 'That is not a .json file. Choose google-services.json.'); return; }
          let text = '';
          try { text = bridge.readText(path); } finally { try { bridge.remove(path); } catch { /* ignore */ } }
          apply(text);
        }, (m) => { status.textContent = '❌ ' + m; }) }, L('رفع ملف JSON', 'Upload a JSON file'))),
      status);

    // ---- current state ----
    const has = bridge.stat(gsPath).exists;
    const rows: HTMLElement[] = [];
    const row = (label: string, value: string, copyable = false) => rows.push(h('div', { class: 'cred-row' },
      h('div', { class: 'cred-label' }, label),
      h('div', { class: 'cred-value' + (value ? '' : ' empty') }, value || L('— لسه', '— not yet')),
      copyable && value ? h('button', { class: 'btn small', onclick: () => copy(value) }, L('نسخ', 'Copy')) : ''));

    row('google-services.json', has ? L('✅ موجود', '✅ present') : '');
    row('Web Client ID', cfg.googleClientId, true);
    row(L('SHA-1 توقيع Google Play', 'Google Play signing SHA-1'), cfg.playSha1, true);
    row(L('SHA-256 توقيع Google Play', 'Google Play signing SHA-256'), cfg.playSha256, true);
    let key: { sha1: string; sha256: string } | undefined;
    try { key = bridge.keyList()[0]; } catch { key = undefined; }
    if (key) {
      row(L('SHA-1 مفتاح الرفع (بتاعك)', 'Upload key SHA-1 (yours)'), key.sha1, true);
      row(L('SHA-256 مفتاح الرفع (بتاعك)', 'Upload key SHA-256 (yours)'), key.sha256, true);
    }
    box.append(h('div', { class: 'cred-list' }, ...rows));

    box.append(
      details(L('فين ألاقي google-services.json؟', 'Where do I find google-services.json?'), L(
        '1) افتح console.firebase.google.com واعمل مشروع (أو افتح مشروعك).\n2) Project settings ← Your apps ← Add app ← أندرويد.\n3) اكتب اسم الحزمة بالظبط زي ما هو في الفحص (package id)، واضغط Register.\n4) نزّل google-services.json والصق محتواه هنا أو ارفعه بالزرار.',
        '1) Open console.firebase.google.com and create (or open) your project.\n2) Project settings → Your apps → Add app → Android.\n3) Enter the exact package id shown in the checks, then Register.\n4) Download google-services.json and paste its content here or upload it with the button.')),
      details(L('فين ألاقي Client ID؟', 'Where do I find the Client ID?'), L(
        'بيتسحب تلقائي من google-services.json. أو: console.cloud.google.com ← APIs & Services ← Credentials ← OAuth 2.0 Client IDs ← "Web client" وانسخ الـClient ID.',
        'It is taken automatically from google-services.json. Or: console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client IDs → "Web client" and copy the Client ID.')),
      details(L('فين ألاقي بصمة Google Play؟', 'Where do I find the Google Play fingerprint?'), L(
        'بعد أول رفع للتطبيق على Play: Play Console ← تطبيقك ← Test and release ← Setup ← App signing. انسخ SHA-1 (وSHA-256) من "App signing key certificate" والصقهم هنا. وبعدين ضيفهم في Firebase (Add fingerprint) ونزّل google-services.json الجديد.',
        'After your first upload to Play: Play Console → your app → Test and release → Setup → App signing. Copy the SHA-1 (and SHA-256) of the "App signing key certificate" and paste them here. Then add them in Firebase (Add fingerprint) and download the new google-services.json.')),
      details(L('بصمة مفتاح الرفع بتاعي', 'My upload key fingerprint'), L(
        'بصمات مفتاح الرفع بتظهر فوق بعد ما تنشئ المفتاح. ضيفها في Firebase كمان عشان الدخول بجوجل يشتغل وانت بتجرّب نسخة موقّعة بمفتاحك.',
        'Your upload-key fingerprints are shown above once the key exists. Add them in Firebase too so Google sign-in works while you test a build signed with your key.')));
  };

  draw();
}

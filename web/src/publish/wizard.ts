import { bridge } from '../native';
import { h, fullSheet, toast, debounce, joinPath, extOf } from '../ui';
import { L, loadConfig, saveConfig, slug, type PublishConfig } from './config';
import { renderKeySection } from './keys';
import { renderBuildSection } from './build';
import { renderCredsSection } from './creds';
import { runPreflight, hasErrors, type Check } from './preflight';
import { generateProject, androidDir } from './generate';

function findImages(dir: string, depth = 0, out: string[] = []): string[] {
  try {
    for (const e of bridge.list(dir)) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = joinPath(dir, e.name);
      if (e.isDir) { if (depth < 3) findImages(p, depth + 1, out); }
      else if (['png', 'jpg', 'jpeg', 'webp'].includes(extOf(e.name))) out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}

function findHtml(dir: string, depth = 0, out: string[] = []): string[] {
  try {
    for (const e of bridge.list(dir)) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = joinPath(dir, e.name);
      if (e.isDir) { if (depth < 3) findHtml(p, depth + 1, out); }
      else if (['html', 'htm'].includes(extOf(e.name))) out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}

export function openPublish(project: string): void {
  const cfg: PublishConfig = loadConfig(project);
  const body = h('div', { class: 'settings' });
  fullSheet(L('النشر على Google Play', 'Publish to Google Play'), body);

  const checksBox = h('div', { class: 'checks' });
  const genBtn = h('button', { class: 'btn primary wide' }, L('① تجهيز مشروع أندرويد', '① Generate Android project'));
  const status = h('div', { class: 'sub pub-status' });

  const save = debounce(() => { saveConfig(project, cfg); void refresh(); }, 400);
  const field = <K extends keyof PublishConfig>(label: string, key: K, opts: { type?: string; hint?: string; num?: boolean } = {}) => {
    const input = h('input', { class: 'field', type: opts.type ?? 'text', value: String(cfg[key]), autocapitalize: 'off', spellcheck: false });
    input.addEventListener('input', () => {
      (cfg as any)[key] = opts.num ? Number(input.value) : input.value;
      save();
    });
    body.append(h('label', { class: 'set-row stack' }, h('span', {}, label), input, opts.hint ? h('small', { class: 'sub' }, opts.hint) : null));
  };
  const select = <K extends keyof PublishConfig>(label: string, key: K, options: [string, string][], hint?: string) => {
    const s = h('select', { class: 'field' });
    for (const [v, l] of options) s.append(h('option', { value: v, selected: String(cfg[key]) === v }, l));
    s.addEventListener('change', () => { (cfg as any)[key] = s.value; render(); save(); });
    body.append(h('label', { class: 'set-row stack' }, h('span', {}, label), s, hint ? h('small', { class: 'sub' }, hint) : null));
  };
  const check = <K extends keyof PublishConfig>(label: string, key: K) => {
    const i = h('input', { type: 'checkbox', class: 'switch', checked: !!cfg[key] });
    i.addEventListener('change', () => { (cfg as any)[key] = i.checked; save(); });
    body.append(h('label', { class: 'set-row' }, h('span', {}, label), i));
  };
  const section = (t: string) => body.append(h('div', { class: 'set-section' }, t));

  function render(): void {
    body.replaceChildren();
    body.append(h('div', { class: 'pub-intro' }, L(
      'جهّز بيانات تطبيقك هنا. كل ما تغيّر حاجة، الفحص بيتحدّث تحت ويقولك بالظبط إيه المطلوب تصلحه قبل الرفع على Google Play.',
      'Fill in your app details. The checks below update as you type and tell you exactly what to fix before uploading to Google Play.')));

    section(L('بيانات التطبيق', 'App details'));
    field(L('اسم التطبيق (حتى 30 حرف)', 'App name (max 30 chars)'), 'appName');
    field(L('معرّف الحزمة (package id)', 'Package id'), 'packageId', { hint: L('فريد ومينفعش يتغيّر بعد النشر. مثال: com.ahmed.myshop', 'Unique and cannot change after publishing. Example: com.ahmed.myshop') });
    field(L('اسم الإصدار', 'Version name'), 'versionName', { hint: '1.0.0' });
    field(L('رقم الإصدار (versionCode)', 'Version code'), 'versionCode', { type: 'number', num: true, hint: L('كل رفع جديد على Play لازم يكون رقمه أكبر من اللي قبله.', 'Every new upload to Play must be higher than the previous one.') });

    section(L('المحتوى', 'Content'));
    select(L('مصدر المحتوى', 'Content source'), 'source', [['local', L('ملفات المشروع (أوفلاين) — موصى به', 'Project files (offline) — recommended')], ['url', L('رابط موقع', 'Website URL')]]);
    if (cfg.source === 'local') {
      const htmls = findHtml(project).map((p) => p.slice(project.length + 1));
      if (htmls.length && !htmls.includes(cfg.entryFile)) { cfg.entryFile = htmls.includes('index.html') ? 'index.html' : htmls[0]; }
      select(L('الصفحة الرئيسية', 'Entry page'), 'entryFile', (htmls.length ? htmls : [cfg.entryFile]).map((x) => [x, x]));
    } else field(L('رابط الموقع (https)', 'Website URL (https)'), 'url', { hint: 'https://example.com' });

    section(L('الشكل', 'Look'));
    const imgs = findImages(project);
    if (!cfg.iconPath && imgs.length) cfg.iconPath = imgs.find((p) => /icon|logo/i.test(p)) ?? '';
    select(L('الأيقونة', 'Icon'), 'iconPath', [['', L('— اختار صورة —', '— choose an image —')], ...imgs.map((p): [string, string] => [p, p.slice(project.length + 1)])],
      L('صورة مربعة 512×512 أو أكبر. حطها في المشروع عشان تظهر هنا.', 'Square image, 512×512 or larger. Put it in the project so it shows here.'));
    field(L('لون التطبيق (شريط الحالة والخلفية)', 'Theme color'), 'themeColor', { type: 'color' });
    select(L('اتجاه الشاشة', 'Orientation'), 'orientation', [['unspecified', L('تلقائي', 'Auto')], ['portrait', L('طولي', 'Portrait')], ['landscape', L('عرضي', 'Landscape')]]);

    section(L('الصلاحيات', 'Permissions'));
    check(L('الإنترنت', 'Internet'), 'internet');
    check(L('الاهتزاز', 'Vibration'), 'vibrate');
    body.append(h('div', { class: 'sub pub-note' }, L('كل صلاحية زيادة بتتطلب شرح في Google Play، فالأفضل تفعّل اللي محتاجه بس. (الكاميرا والموقع والميكروفون هتتضاف في خطوة لاحقة.)', 'Every extra permission needs a justification in Google Play, so enable only what you need. (Camera, location and microphone arrive in a later step.)')));

    section(L('الخصوصية', 'Privacy'));
    field(L('رابط سياسة الخصوصية (https)', 'Privacy policy URL (https)'), 'privacyUrl');

    section(L('مفتاح التوقيع', 'Signing key'));
    const keyBox = h('div', {});
    body.append(keyBox);
    renderKeySection(keyBox, project, () => slug(cfg.appName), () => cfg.versionCode, () => { void refresh(); });

    section(L('الملفات والبصمات (اختياري)', 'Files and fingerprints (optional)'));
    const credsBox = h('div', {});
    body.append(credsBox);
    renderCredsSection(credsBox, project, cfg, () => { void refresh(); });

    section(L('البناء والتوقيع', 'Build and sign'));
    const buildBox = h('div', {});
    body.append(buildBox);
    renderBuildSection(buildBox, project, cfg, () => { try { return bridge.keyList().length > 0; } catch { return false; } }, () => { cfg.versionCode += 1; saveConfig(project, cfg); render(); });

    section(L('الفحص قبل النشر', 'Pre-publish checks'));
    body.append(checksBox, genBtn, status);
    body.append(h('div', { class: 'sub pub-note' }, L('الخطوات الجاية (التوقيع، البناء على GitHub، تنزيل ملف AAB) هتتضاف بعد ما تجرّب الخطوة دي.', 'Next steps (signing, GitHub build, downloading the AAB) arrive after you test this step.')));
    void refresh();
  }

  async function refresh(): Promise<void> {
    const cs = await runPreflight(project, cfg);
    paint(cs);
  }

  function paint(cs: Check[]): void {
    const icon = { ok: '✅', warn: '⚠️', error: '❌' } as const;
    const sorted = [...cs].sort((a, b) => ({ error: 0, warn: 1, ok: 2 }[a.level] - { error: 0, warn: 1, ok: 2 }[b.level]));
    checksBox.replaceChildren(...sorted.map((c) => h('div', { class: `check ${c.level}` },
      h('div', { class: 'ct' }, `${icon[c.level]} ${c.title}`), c.fix ? h('div', { class: 'cf' }, c.fix) : null)));
    const bad = hasErrors(cs);
    genBtn.disabled = bad;
    genBtn.classList.toggle('dim', bad);
    status.textContent = bad ? L('صلّح الأخطاء ❌ الأول، وبعدين الزرار هيشتغل.', 'Fix the ❌ errors first, then the button unlocks.') : '';
  }

  genBtn.addEventListener('click', async () => {
    genBtn.disabled = true;
    status.textContent = L('جارٍ التجهيز…', 'Generating…');
    try {
      saveConfig(project, cfg);
      const r = await generateProject(project, cfg);
      status.textContent = L(`تم ✓ اتولّد مشروع أندرويد (${r.files} عنصر) في ${androidDir(project)}`, `Done ✓ Android project generated (${r.files} items) in ${androidDir(project)}`);
      toast(L('تم تجهيز المشروع', 'Project generated'));
    } catch (e: any) {
      status.textContent = L('فشل التجهيز: ', 'Generation failed: ') + String(e.message ?? e);
    } finally { genBtn.disabled = false; }
  });

  render();
}

import { bridge } from '../native';
import { dirName, joinPath, extOf } from '../ui';
import { L, TARGET_SDK, type PublishConfig } from './config';

export interface Check { level: 'ok' | 'warn' | 'error'; title: string; fix?: string }

const KEYWORDS = new Set(['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'try', 'void', 'volatile', 'while', 'true', 'false', 'null', 'fun', 'val', 'var', 'in', 'is', 'object', 'when']);

const ok = (title: string): Check => ({ level: 'ok', title });
const warn = (title: string, fix: string): Check => ({ level: 'warn', title, fix });
const err = (title: string, fix: string): Check => ({ level: 'error', title, fix });

function imageSize(project: string, path: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = bridge.assetUrl(path);
    void project;
  });
}

function dirSize(dir: string, depth = 0): number {
  let total = 0;
  try {
    for (const e of bridge.list(dir)) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      total += e.isDir ? (depth < 8 ? dirSize(joinPath(dir, e.name), depth + 1) : 0) : e.size;
    }
  } catch { /* unreadable folder counts as 0 */ }
  return total;
}

function scanHtml(project: string, entry: string): Check[] {
  const out: Check[] = [];
  let html = '';
  try { html = bridge.readTextRange(joinPath(project, entry), 2_000_000); } catch { return out; }
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    out.push(warn(L('الصفحة بدون وسم viewport', 'Page has no viewport meta tag'),
      L('ضيف داخل <head>: <meta name="viewport" content="width=device-width, initial-scale=1"> وإلا هتظهر مصغّرة على الموبايل.',
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside <head> or the page will look tiny.')));
  }
  const missing: string[] = [];
  let http = 0, remote = 0;
  const base = dirName(entry);
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = m[1].trim();
    if (!ref || ref.startsWith('#') || /^(data:|mailto:|tel:|javascript:|blob:)/i.test(ref)) continue;
    if (/^http:\/\//i.test(ref)) { http++; continue; }
    if (/^(https:)?\/\//i.test(ref)) { if (/\.(js|css|woff2?|png|jpe?g|svg)(\?|$)/i.test(ref)) remote++; continue; }
    const clean = ref.split(/[?#]/)[0];
    if (!clean) continue;
    const target = clean.startsWith('/') ? clean.slice(1) : joinPath(base, clean);
    try { if (!bridge.stat(joinPath(project, target)).exists && !missing.includes(clean)) missing.push(clean); } catch { /* ignore */ }
  }
  if (missing.length) {
    out.push(err(L(`ملفات مرتبطة في الصفحة مش موجودة (${missing.length})`, `Files referenced by the page are missing (${missing.length})`),
      L(`أنشئ أو صحّح المسارات دي في المشروع: ${missing.slice(0, 5).join('، ')}`, `Create or fix these paths: ${missing.slice(0, 5).join(', ')}`)));
  }
  if (http) {
    out.push(err(L(`روابط http:// غير مشفّرة (${http})`, `Insecure http:// links (${http})`),
      L('غيّرها لـ https:// — أندرويد بيمنعها داخل التطبيق وهتظهر الصفحة ناقصة.', 'Change them to https:// — Android blocks them inside the app so parts of the page will not load.')));
  }
  if (remote) {
    out.push(warn(L(`الصفحة بتحمّل ${remote} ملف من الإنترنت (CDN)`, `Page loads ${remote} files from the internet (CDN)`),
      L('التطبيق مش هيشتغل أوفلاين كامل. لو عايزه أوفلاين نزّل الملفات دي جوه المشروع.', 'The app will not be fully offline. Download those files into the project for offline use.')));
  }
  return out;
}

export async function runPreflight(project: string, c: PublishConfig): Promise<Check[]> {
  const r: Check[] = [];

  // --- name ---
  const name = c.appName.trim();
  if (!name) r.push(err(L('اسم التطبيق فاضي', 'App name is empty'), L('اكتب اسم للتطبيق (حتى 30 حرف).', 'Enter an app name (up to 30 characters).')));
  else if (name.length > 30) r.push(err(L('اسم التطبيق أطول من 30 حرف', 'App name is longer than 30 characters'), L('Google Play بيرفض الأسماء الأطول من 30 حرف. اختصره.', 'Google Play rejects names over 30 characters. Shorten it.')));
  else r.push(ok(L('اسم التطبيق مناسب', 'App name is fine')));

  // --- package id ---
  const pkg = c.packageId.trim();
  const segs = pkg.split('.');
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg)) {
    r.push(err(L('معرّف الحزمة (package id) غير صالح', 'Package id is invalid'),
      L('لازم يكون حروف إنجليزية صغيرة وأرقام و_ على الأقل جزئين بينهم نقطة، وكل جزء يبدأ بحرف. مثال: com.ahmed.myshop', 'Use lowercase letters, digits and _, at least two parts separated by dots, each starting with a letter. Example: com.ahmed.myshop')));
  } else if (segs.some((s) => KEYWORDS.has(s))) {
    r.push(err(L('معرّف الحزمة فيه كلمة محجوزة', 'Package id contains a reserved word'), L(`غيّر الجزء: ${segs.filter((s) => KEYWORDS.has(s)).join('، ')}`, `Change: ${segs.filter((s) => KEYWORDS.has(s)).join(', ')}`)));
  } else if (/^com\.(example|yourname|test)\b/.test(pkg) || pkg.startsWith('com.android') || pkg.startsWith('com.google')) {
    r.push(err(L('معرّف الحزمة مثال/محجوز ومش هيتقبل في Play', 'Package id is a placeholder/reserved and Play will reject it'),
      L('استبدل الجزء الثاني باسمك أو اسم شركتك، مثال: com.ahmed.myshop. ولازم يكون فريد ومينفعش تغيّره بعد النشر.', 'Replace the second part with your name or company, e.g. com.ahmed.myshop. It must be unique and cannot change after publishing.')));
  } else r.push(ok(L('معرّف الحزمة صالح', 'Package id is valid')));

  // --- version ---
  if (!Number.isInteger(c.versionCode) || c.versionCode < 1 || c.versionCode > 2_100_000_000) {
    r.push(err(L('versionCode غير صالح', 'versionCode is invalid'), L('لازم يكون رقم صحيح من 1 لـ 2100000000، وكل رفع جديد لازم يكون أكبر من اللي قبله.', 'Must be an integer from 1 to 2100000000 and larger than the previous upload.')));
  } else r.push(ok(L(`رقم الإصدار (versionCode) = ${c.versionCode}`, `versionCode = ${c.versionCode}`)));
  if (!c.versionName.trim()) r.push(err(L('اسم الإصدار فاضي', 'versionName is empty'), L('اكتب مثلًا 1.0.0', 'Enter e.g. 1.0.0')));

  // --- content ---
  if (c.source === 'local') {
    const entry = c.entryFile.trim();
    const full = joinPath(project, entry);
    let exists = false;
    try { exists = !!entry && bridge.stat(full).exists && !bridge.stat(full).isDir; } catch { exists = false; }
    if (!exists || !/^html?$/.test(extOf(entry))) {
      r.push(err(L('ملف الصفحة الرئيسية مش موجود', 'Entry HTML file not found'), L(`أنشئ الملف "${entry || 'index.html'}" في المشروع أو اختار ملف HTML موجود.`, `Create "${entry || 'index.html'}" in the project or pick an existing HTML file.`)));
    } else {
      r.push(ok(L('الصفحة الرئيسية موجودة', 'Entry page found')));
      r.push(...scanHtml(project, entry));
    }
    const mb = dirSize(project) / 1048576;
    if (mb > 150) r.push(err(L(`حجم المحتوى كبير (${mb.toFixed(0)} MB)`, `Content is too large (${mb.toFixed(0)} MB)`), L('Google Play حده 200 MB للتطبيق. قلّل حجم الصور والفيديوهات.', 'Google Play limits the base app to 200 MB. Reduce image/video sizes.')));
    else if (mb > 50) r.push(warn(L(`حجم المحتوى ${mb.toFixed(0)} MB`, `Content size ${mb.toFixed(0)} MB`), L('كبير نسبيًا على التحميل. ضغط الصور هيفرق.', 'Fairly large to download. Compressing images will help.')));
  } else {
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(c.url.trim())) {
      r.push(err(L('رابط الموقع غير صالح', 'Website URL is invalid'), L('لازم يبدأ بـ https:// مثال: https://example.com — الروابط http غير مقبولة.', 'Must start with https:// e.g. https://example.com — plain http is not accepted.')));
    } else {
      r.push(ok(L('رابط الموقع صالح', 'Website URL is valid')));
      r.push(warn(L('تطبيق يعرض موقع فقط', 'App only displays a website'),
        L('Google Play بيرفض أحيانًا التطبيقات اللي مفيهاش غير موقع. الأفضل تحط الملفات جوه التطبيق (وضع الملفات المحلية) وتضيف ميزات تفيد المستخدم.', 'Google Play sometimes rejects apps that only wrap a website. Prefer bundling files locally and adding value beyond the site.')));
    }
    if (!c.internet) r.push(err(L('الموقع محتاج صلاحية الإنترنت', 'A website needs the Internet permission'), L('فعّل خيار الإنترنت.', 'Enable the Internet option.')));
  }

  // --- icon ---
  if (!c.iconPath) {
    r.push(err(L('لم تختر أيقونة', 'No icon selected'), L('حط صورة مربعة PNG (512×512 أو أكبر) في المشروع واختارها.', 'Put a square PNG (512×512 or larger) in the project and select it.')));
  } else {
    const s = await imageSize(project, c.iconPath);
    if (!s) r.push(err(L('تعذّر قراءة الأيقونة', 'Cannot read the icon'), L('اختار صورة PNG أو JPG سليمة.', 'Choose a valid PNG or JPG image.')));
    else if (s.w !== s.h) r.push(err(L(`الأيقونة مش مربعة (${s.w}×${s.h})`, `Icon is not square (${s.w}×${s.h})`), L('اقصّها لمربع. Google Play بيطلب 512×512.', 'Crop it to a square. Google Play needs 512×512.')));
    else if (s.w < 512) r.push(err(L(`الأيقونة صغيرة (${s.w}px)`, `Icon is too small (${s.w}px)`), L('استخدم صورة 512×512 على الأقل عشان تطلع واضحة ومقبولة.', 'Use at least 512×512 so it is sharp and accepted.')));
    else r.push(ok(L(`الأيقونة سليمة (${s.w}×${s.h})`, `Icon is good (${s.w}×${s.h})`)));
  }

  // --- privacy ---
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(c.privacyUrl.trim())) {
    r.push(warn(L('مفيش رابط سياسة خصوصية', 'No privacy policy URL'), L('Google Play بيطلبه (وإلزامي لو التطبيق بيجمع بيانات أو بيستخدم الإنترنت). ارفع صفحة سياسة الخصوصية على موقعك وحط رابطها https.', 'Google Play asks for it (mandatory if the app collects data or uses the Internet). Host a privacy page and enter its https link.')));
  } else r.push(ok(L('رابط سياسة الخصوصية موجود', 'Privacy policy URL set')));

  // --- signing key ---
  let hasKey = false;
  try { hasKey = bridge.keyList().length > 0; } catch { hasKey = false; }
  if (!hasKey) r.push(warn(L('لسه مفيش مفتاح توقيع', 'No signing key yet'), L('أنشئ مفتاح التوقيع من قسم "مفتاح التوقيع" تحت. من غيره مش هتقدر توقّع ملف الـAAB.', 'Create the key in the "Signing key" section below. Without it you cannot sign the AAB.')));
  else r.push(ok(L('مفتاح التوقيع موجود', 'Signing key is present')));

  r.push(ok(L(`مستوى الـ API المستهدف = ${TARGET_SDK} (مطابق لمتطلبات Play)`, `Target API = ${TARGET_SDK} (meets Play requirements)`)));
  return r;
}

export const hasErrors = (cs: Check[]): boolean => cs.some((c) => c.level === 'error');

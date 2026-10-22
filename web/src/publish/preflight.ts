import { bridge } from '../native';
import { dirName, joinPath, extOf } from '../ui';
import { L, TARGET_SDK, type PublishConfig } from './config';
import { inspectGoogleServices, isClientId } from './creds-logic';

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

  // --- Firebase / Google sign-in files (optional) ---
  const gsPath = `${project}/.forge/google-services.json`;
  if (bridge.stat(`${project}/google-services.json`).exists) {
    r.push(warn(L('ملف google-services.json جوه ملفات الموقع', 'google-services.json is inside the site files'),
      L('الملف ده فيه مفاتيح ومينفعش يبقى في ملفات الموقع. هيتم تجاهله في التطبيق. ارفعه من قسم "الملفات والبصمات" بدل كده وامسحه من هنا.', 'This file holds keys and must not sit in the site files. It is ignored in the app. Upload it from the "Files and fingerprints" section instead and delete it here.')));
  }
  if (bridge.stat(gsPath).exists) {
    try {
      const insp = inspectGoogleServices(JSON.parse(bridge.readText(gsPath)), pkg);
      if (!insp.matchesPackage) {
        r.push(err(L('google-services.json لا يطابق معرّف الحزمة', 'google-services.json does not match the package id'),
          L(`الملف مسجّل لـ: ${insp.packages.join('، ') || '—'} وتطبيقك ${pkg}. في Firebase أضف تطبيق أندرويد باسم الحزمة ${pkg} ونزّل الملف تاني، أو غيّر معرّف الحزمة هنا.`,
            `The file is for: ${insp.packages.join(', ') || '—'} but your app is ${pkg}. In Firebase add an Android app with package ${pkg} and download the file again, or change the package id here.`)));
      } else {
        r.push(ok(L(`ملف Firebase سليم (${insp.projectId})`, `Firebase file is valid (${insp.projectId})`)));
        const keyOk = (label: string, sha: string) => {
          if (!sha) return;
          if (insp.registeredSha1.includes(sha)) r.push(ok(L(`بصمة ${label} مسجّلة في Firebase`, `${label} fingerprint is registered in Firebase`)));
          else r.push(warn(L(`بصمة ${label} غير مسجّلة في Firebase`, `${label} fingerprint is not registered in Firebase`),
            L(`Firebase Console ← إعدادات المشروع ← تطبيقك ← Add fingerprint، والصق: ${sha} ثم نزّل google-services.json الجديد وارفعه هنا. من غير كده تسجيل الدخول بجوجل مش هيشتغل.`,
              `Firebase Console → Project settings → your app → Add fingerprint, paste: ${sha}, then download the new google-services.json and upload it here. Without this Google sign-in will not work.`)));
        };
        let uploadSha1 = '';
        try { uploadSha1 = bridge.keyList()[0]?.sha1 ?? ''; } catch { uploadSha1 = ''; }
        keyOk(L('مفتاح الرفع', 'upload key'), uploadSha1);
        keyOk(L('توقيع Google Play', 'Google Play signing'), c.playSha1);
        if (!c.playSha1) r.push(warn(L('بصمة توقيع Google Play مش مضافة', 'Google Play signing fingerprint not added'),
          L('بعد أول رفع على Play، افتح Play Console ← Setup ← App signing وانسخ SHA-1 للـ"App signing key certificate" والصقه في "الملفات والبصمات". الدخول بجوجل في التطبيق المنشور بيعتمد عليها.',
            'After the first Play upload, open Play Console → Setup → App signing, copy the SHA-1 of the "App signing key certificate" and paste it in "Files and fingerprints". Google sign-in in the published app depends on it.')));
      }
    } catch {
      r.push(err(L('ملف google-services.json تالف', 'google-services.json is corrupt'), L('نزّله من Firebase تاني وارفعه من جديد.', 'Download it from Firebase again and re-upload.')));
    }
  }
  const sensitive: [boolean, string, string][] = [
    [c.camera, 'الكاميرا', 'camera'], [c.microphone, 'الميكروفون', 'microphone'], [c.location, 'الموقع', 'location'], [c.notifications || c.push, 'الإشعارات', 'notifications'],
  ];
  const on = sensitive.filter((s) => s[0]);
  if (on.length) {
    r.push(warn(L(`صلاحيات حسّاسة مفعّلة: ${on.map((s) => s[1]).join('، ')}`, `Sensitive permissions enabled: ${on.map((s) => s[2]).join(', ')}`),
      L('Google Play بيطلب منك: (1) تصريح في نموذج Data safety بإيه البيانات اللي بتجمعها، (2) سياسة خصوصية بتذكرها، (3) استخدام حقيقي لها داخل التطبيق. لو مش بتستخدمها فعلًا ألغِ تفعيلها لأن ده من أشهر أسباب الرفض.',
        'Google Play requires: (1) Data safety disclosures for what you collect, (2) a privacy policy that mentions it, (3) real use inside the app. If you do not actually use a permission, turn it off; unused permissions are a common rejection reason.')));
    if (!/^https:\/\//i.test(c.privacyUrl.trim())) {
      r.push(err(L('الصلاحيات الحسّاسة تتطلب رابط سياسة خصوصية', 'Sensitive permissions require a privacy policy URL'), L('أضف رابط سياسة الخصوصية (https) في قسم الخصوصية.', 'Add your privacy policy URL (https) in the Privacy section.')));
    }
  }
  if ((c.camera || c.microphone || c.location || c.notifications) && c.source === 'url' && !c.internet) {
    r.push(err(L('الصلاحيات دي محتاجة الإنترنت', 'These permissions need the Internet permission'), L('فعّل خيار الإنترنت.', 'Enable the Internet option.')));
  }
  if (c.push) {
    if (!bridge.stat(gsPath).exists) {
      r.push(err(L('الإشعارات البعيدة (FCM) محتاجة google-services.json', 'Push notifications (FCM) need google-services.json'),
        L('اعمل مشروع Firebase وضيف تطبيق أندرويد باسم الحزمة بتاعك، ونزّل google-services.json والصقه في "الملفات والبصمات".', 'Create a Firebase project, add an Android app with your package id, download google-services.json and paste it in "Files and fingerprints".')));
    }
    r.push(warn(L('الإشعارات البعيدة محتاجة سيرفر يبعت', 'Push needs a server to send messages'),
      L('التطبيق بيستقبل الإشعارات، لكن لازم تبعتها من Firebase Console (Messaging) أو من سيرفرك بـ FCM HTTP v1. خد الـtoken من Forge.pushToken() واحفظه عندك.',
        'The app receives pushes, but you must send them from Firebase Console (Messaging) or your server via FCM HTTP v1. Get the token from Forge.pushToken() and store it on your side.')));
  }
  if (c.oauth) {
    const scheme = c.oauthScheme.trim();
    if (!/^[a-z][a-z0-9+.-]{2,60}$/.test(scheme) || ['http', 'https', 'file', 'content', 'intent', 'javascript', 'data', 'tel', 'mailto', 'sms'].includes(scheme)) {
      r.push(err(L('الـscheme بتاع تسجيل الدخول غير صالح', 'OAuth redirect scheme is invalid'),
        L('استخدم حروف إنجليزية صغيرة وأرقام ونقط، مثال: com.ahmed.shop. ومينفعش يبقى http أو https أو غيرهم من المحجوزة.', 'Use lowercase letters, digits and dots, e.g. com.ahmed.shop. It cannot be http, https or other reserved schemes.')));
    } else {
      r.push(ok(L(`رابط الرجوع (redirect URI) = ${scheme}://oauth`, `Redirect URI = ${scheme}://oauth`)));
      r.push(warn(L('سجّل رابط الرجوع عند مزوّد تسجيل الدخول', 'Register the redirect URI with your provider'),
        L(`في إعدادات التطبيق عند المزوّد (GitHub / Facebook / Microsoft...) أضف ${scheme}://oauth كـ redirect URI، وفي كودك استخدم Forge.redirectUri.`, `In your provider's app settings (GitHub / Facebook / Microsoft...) add ${scheme}://oauth as a redirect URI and use Forge.redirectUri in your code.`)));
    }
  }
  if (c.googleSignIn) {
    if (!c.googleClientId.trim()) {
      r.push(err(L('تسجيل الدخول بجوجل مفعّل من غير Client ID', 'Google sign-in is on but there is no Client ID'),
        L('الصق الـWeb Client ID في "الملفات والبصمات" (بيتسحب تلقائي من google-services.json).', 'Paste the Web Client ID in "Files and fingerprints" (it is taken automatically from google-services.json).')));
    } else {
      r.push(warn(L('تأكد من إعداد Google Cloud لتسجيل الدخول', 'Check your Google Cloud setup for sign-in'),
        L(`في Google Cloud Console ← Credentials لازم يكون عندك OAuth client من نوع Android باسم الحزمة ${pkg} وبصمة SHA-1 (مفتاح الرفع للتجربة، وبصمة توقيع Google Play للنسخة المنشورة)، وبجانبه الـWeb client اللي الصقته. من غيرهم النافذة هتفشل.`,
          `In Google Cloud Console → Credentials you need an OAuth client of type Android with package ${pkg} and the SHA-1 (upload key for testing, Google Play signing key for the published app), next to the Web client you pasted. Without them the sign-in sheet will fail.`)));
    }
    if (c.source === 'url' && !/^https:\/\//i.test(c.url.trim())) r.push(err(L('الجسر يحتاج موقع https', 'The bridge needs an https site'), L('استخدم رابط https.', 'Use an https URL.')));
  }
  if (c.googleClientId.trim() && !isClientId(c.googleClientId)) {
    r.push(err(L('Google Client ID شكله غلط', 'Google Client ID looks wrong'), L('لازم يبقى شكله 123456789-abc.apps.googleusercontent.com. انسخه كامل من Google Cloud Console ← Credentials ← Web client.', 'It should look like 123456789-abc.apps.googleusercontent.com. Copy it fully from Google Cloud Console → Credentials → Web client.')));
  }

  r.push(ok(L(`مستوى الـ API المستهدف = ${TARGET_SDK} (مطابق لمتطلبات Play)`, `Target API = ${TARGET_SDK} (meets Play requirements)`)));
  return r;
}

export const hasErrors = (cs: Check[]): boolean => cs.some((c) => c.level === 'error');

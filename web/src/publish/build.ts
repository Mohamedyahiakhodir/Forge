import { bridge, onNative } from '../native';
import { h, toast, promptText } from '../ui';
import { L, slug, type PublishConfig } from './config';
import { hasErrors, runPreflight } from './preflight';
import { generateProject } from './generate';
import { signWithHandlers, explainError } from './keys';

interface Progress { stage: string; msg: string; done: number; total: number }
interface Failure { message: string; detail?: string; step?: string; excerpt?: string; url?: string }

let wired = false;
let onProgress: ((p: Progress) => void) | null = null;
let onDone: ((p: { path: string; size: number; url: string }) => void) | null = null;
let onFail: ((f: Failure) => void) | null = null;
let onConnected: ((p: { login: string }) => void) | null = null;
let onGhError: ((f: Failure) => void) | null = null;
function wire(): void {
  if (wired) return;
  wired = true;
  onNative('buildProgress', (p) => onProgress?.(p));
  onNative('buildDone', (p) => onDone?.(p));
  onNative('buildFailed', (f) => onFail?.(f));
  onNative('ghConnected', (p) => onConnected?.(p));
  onNative('ghError', (f) => onGhError?.(f));
}

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Forge';

/** Turns an API/code failure into a plain instruction in the user's language. */
function explainGh(f: Failure): string {
  const d = f.detail ?? '';
  switch (f.message) {
    case 'BAD_TOKEN': return L('الـToken غلط أو منتهي. أنشئ واحد جديد من الزرار وانسخه كامل.', 'The token is wrong or expired. Create a new one with the button and copy it fully.');
    case 'MISSING_SCOPES': return L(`الـToken ناقصه صلاحيات. لازم يكون فيه "repo" و"workflow" (الموجود: ${d}). أنشئ Token جديد من الزرار وسيب الصلاحيتين متعلّم عليهم.`, `The token lacks permissions. It needs "repo" and "workflow" (has: ${d}). Create a new one with the button and keep both ticked.`);
    case 'NETWORK': return L('مفيش اتصال بالإنترنت أو GitHub مش بيرد. اتأكد من النت وحاول تاني.', 'No internet connection or GitHub is not responding. Check your connection and retry.');
    case 'RATE_LIMIT': return L('GitHub حدّد عدد الطلبات مؤقتًا. استنى دقايق وحاول تاني.', 'GitHub temporarily limited requests. Wait a few minutes and retry.');
    case 'NO_TOKEN': return L('لازم تربط حساب GitHub الأول.', 'Connect your GitHub account first.');
    case 'WORKFLOW_NOT_STARTED': return L('الكود اترفع بس GitHub ما بدأش البناء. افتح الـrepo على GitHub ← تاب Actions وفعّل الـworkflows لو طالب، وتأكد إن الـToken فيه صلاحية "workflow".', 'The code was uploaded but GitHub did not start the build. Open the repo → Actions tab and enable workflows if asked, and make sure the token has the "workflow" permission.');
    case 'BUILD_TIMEOUT': return L('البناء أخد أكتر من 30 دقيقة. افتح تاب Actions في الـrepo وشوف حالته.', 'The build took over 30 minutes. Check the Actions tab of the repo.');
    case 'NO_ARTIFACT': return L('البناء نجح بس ملف الـAAB مش موجود. حاول تاني.', 'The build succeeded but the AAB file is missing. Retry.');
    case 'FILE_TOO_LARGE': return L(`الملف ${d} أكبر من 40MB. صغّره أو شيله من المشروع.`, `The file ${d} is larger than 40 MB. Shrink or remove it.`);
    default:
      if (/API_createRepo/.test(f.message) && /422/.test(d)) return L('تعذّر إنشاء الـrepo (الاسم موجود أو الـToken ملوش صلاحية). جرّب تعديل الـpackage id أو تأكد من الصلاحيات.', 'Could not create the repo (name taken or missing permission). Try another package id or check permissions.');
      if (/API_/.test(f.message) && /(403|404)/.test(d)) return L('GitHub رفض الطلب. غالبًا الـToken ملوش صلاحية على الـrepo. أنشئ Token جديد بصلاحية "repo" و"workflow".', 'GitHub refused the request. The token probably lacks access. Create a new one with "repo" and "workflow".');
      return L(`حصل خطأ غير متوقع: ${f.message} ${d}`, `Unexpected error: ${f.message} ${d}`);
  }
}

/** Matches common Gradle/Android failures to a concrete fix. */
export function explainBuild(step: string, excerpt: string): { title: string; fix: string } {
  const t = excerpt;
  if (/Manifest merger|processReleaseMainManifest|AndroidManifest/i.test(t))
    return { title: L('مشكلة في ملف manifest', 'Manifest problem'), fix: L('غالبًا الـpackage id أو الصلاحيات. تأكد إن الـpackage id حروف إنجليزية صغيرة وأجزاء مفصولة بنقط، ثم أعد البناء.', 'Usually the package id or permissions. Make sure the package id is lowercase letters in dot-separated parts, then rebuild.') };
  if (/AAPT|aapt2|resource.*(not found|linking)|mipmap|drawable/i.test(t))
    return { title: L('مشكلة في الأيقونة أو الموارد', 'Icon/resource problem'), fix: L('اختار صورة أيقونة PNG سليمة مربعة 512×512 أو أكبر، ثم اضغط "تجهيز مشروع أندرويد" وأعد البناء.', 'Choose a valid square PNG icon of at least 512×512, press "Generate Android project" and rebuild.') };
  if (/Could not (resolve|find|download)|Connection (reset|refused)|timed out|Read timed out/i.test(t))
    return { title: L('تعذّر تنزيل مكتبات البناء', 'Could not download build libraries'), fix: L('مشكلة مؤقتة في الشبكة عند GitHub. أعد البناء بعد دقيقة.', 'A temporary network issue on the build machine. Rebuild in a minute.') };
  if (/SDK|platform;android|license|Failed to install/i.test(t))
    return { title: L('أدوات أندرويد ناقصة على جهاز البناء', 'Android tools missing on the build machine'), fix: L('أعد البناء. لو اتكرر، ابعتلي النص اللي تحت علشان نحدّث إصدار الـSDK.', 'Rebuild. If it repeats, send me the text below so we can update the SDK version.') };
  if (/Duplicate class|Dex|D8|R8/i.test(t))
    return { title: L('تعارض مكتبات', 'Library conflict'), fix: L('ابعتلي النص اللي تحت وأنا أعدّل القالب.', 'Send me the text below and I will adjust the template.') };
  if (/Unsupported class file|JDK|Java/i.test(t))
    return { title: L('إصدار Java غير متوافق', 'Java version mismatch'), fix: L('مشكلة في القالب مش في مشروعك. ابعتلي النص اللي تحت.', 'A template issue, not your project. Send me the text below.') };
  return { title: L(`فشلت الخطوة: ${step || '—'}`, `Step failed: ${step || '—'}`), fix: L('مفيش حل جاهز لخطأ زي ده. ابعتلي لقطة للنص اللي تحت وأنا أصلحه.', 'No ready-made fix for this error. Send me a screenshot of the text below and I will fix it.') };
}

const STAGE = (p: Progress): string => {
  switch (p.stage) {
    case 'repo': return L('① تجهيز مستودع GitHub…', '① Preparing the GitHub repository…');
    case 'upload': return L(`② رفع الملفات ${p.done}/${p.total}`, `② Uploading files ${p.done}/${p.total}`);
    case 'wait': return L('③ استنى GitHub يبدأ البناء…', '③ Waiting for GitHub to start the build…');
    case 'building': return L(`④ جارٍ البناء — ${p.msg || '…'} (بياخد 2–5 دقايق)`, `④ Building — ${p.msg || '…'} (takes 2–5 minutes)`);
    case 'download': return L('⑤ تنزيل ملف الـAAB…', '⑤ Downloading the AAB…');
    default: return p.stage;
  }
};

export function renderBuildSection(
  box: HTMLElement, project: string, cfg: PublishConfig, hasKey: () => boolean, bumpVersion: () => void,
): void {
  wire();
  const draw = () => {
    box.replaceChildren();
    let st = { connected: false, login: '' };
    try { st = bridge.ghStatus(); } catch { /* not on Android */ }
    if (!st.connected) drawConnect(); else drawBuild(st.login);
  };

  function drawConnect(): void {
    const token = h('input', { class: 'field', type: 'password', placeholder: 'ghp_…', autocapitalize: 'off', spellcheck: false });
    const status = h('div', { class: 'sub pub-status' });
    box.append(
      h('div', { class: 'pub-note' }, L(
        'ملف الـAAB بيتبني على GitHub (مجانًا) لأن التليفون مينفعش يبنيه. محتاج تربط حسابك مرة واحدة: اضغط الزرار، وفي صفحة GitHub انزل لآخرها واضغط "Generate token"، وانسخ الـToken والصقه هنا. بيتخزن مشفّر على جهازك.',
        'The AAB is built on GitHub (free) because a phone cannot build it. Connect your account once: tap the button, scroll to the bottom of the GitHub page and tap "Generate token", then copy the token and paste it here. It is stored encrypted on this device.')),
      h('button', { class: 'btn wide', onclick: () => { try { bridge.openUrl(TOKEN_URL); } catch (e: any) { status.textContent = String(e.message ?? e); } } }, L('① افتح صفحة إنشاء الـToken', '① Open the token page')),
      h('label', { class: 'set-row stack' }, h('span', {}, L('الصق الـToken هنا', 'Paste the token here')), token),
      h('button', { class: 'btn primary wide', onclick: (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        if (!token.value.trim()) { status.textContent = L('الصق الـToken الأول.', 'Paste the token first.'); return; }
        btn.disabled = true; status.textContent = L('جارٍ التحقق…', 'Verifying…');
        onConnected = (p) => { toast(L(`تم الربط بحساب ${p.login}`, `Connected as ${p.login}`)); draw(); };
        onGhError = (f) => { status.textContent = '❌ ' + explainGh(f); btn.disabled = false; };
        try { bridge.ghConnect(token.value); } catch (err: any) { status.textContent = String(err.message ?? err); btn.disabled = false; }
      } }, L('ربط حساب GitHub', 'Connect GitHub')),
      status);
  }

  function drawBuild(login: string): void {
    const log = h('div', { class: 'build-log' });
    const out = h('div', { class: 'pub-status' });
    const buildBtn = h('button', { class: 'btn primary wide' }, L('④ ابنِ ووقّع ملف AAB', '④ Build and sign the AAB'));
    const repo = `forge-${cfg.packageId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    box.append(
      h('div', { class: 'check' }, h('div', { class: 'ct' }, L(`✅ مربوط بحساب GitHub: ${login}`, `✅ Connected to GitHub: ${login}`)),
        h('div', { class: 'cf' }, L(`الـrepo الخاص: ${repo} (private)`, `Private repo: ${repo}`))),
      buildBtn, log, out,
      h('button', { class: 'btn small', style: { marginTop: '10px' }, onclick: () => { bridge.ghDisconnect(); draw(); } }, L('فك الربط', 'Disconnect')));

    const setLog = (t: string) => { log.textContent = t; };
    const fail = (m: string) => { out.replaceChildren(h('div', { class: 'check error' }, h('div', { class: 'ct' }, '❌ ' + m))); buildBtn.disabled = false; };

    buildBtn.addEventListener('click', async () => {
      out.replaceChildren();
      const checks = await runPreflight(project, cfg);
      if (hasErrors(checks)) return fail(L('فيه أخطاء ❌ في الفحص فوق. صلّحها الأول.', 'There are ❌ errors in the checks above. Fix them first.'));
      if (!hasKey()) return fail(L('أنشئ مفتاح التوقيع الأول (قسم "مفتاح التوقيع").', 'Create the signing key first ("Signing key" section).'));
      const pw = await promptText(L('كلمة سر مفتاح التوقيع', 'Signing key password'), '', '', 'password');
      if (!pw) return;
      try { bridge.keyCheck('upload', pw); } catch (e: any) { return fail(explainError(String(e.message ?? e))); }

      buildBtn.disabled = true;
      setLog(L('جارٍ تجهيز المشروع…', 'Preparing the project…'));
      try { await generateProject(project, cfg); } catch (e: any) { return fail(L('فشل تجهيز المشروع: ', 'Project generation failed: ') + String(e.message ?? e)); }

      onProgress = (p) => setLog(STAGE(p));
      onFail = (f) => {
        setLog('');
        if (f.message === 'BUILD_FAILED') {
          const ex = explainBuild(f.step ?? '', f.excerpt ?? '');
          out.replaceChildren(
            h('div', { class: 'check error' }, h('div', { class: 'ct' }, '❌ ' + ex.title), h('div', { class: 'cf' }, ex.fix)),
            f.excerpt ? h('pre', { class: 'build-excerpt' }, f.excerpt) : '',
            f.url ? h('a', { class: 'sub', href: f.url, target: '_blank' }, f.url) : '');
          buildBtn.disabled = false;
        } else fail(explainGh(f));
      };
      onDone = (r) => {
        setLog(L('⑥ البناء نجح. جارٍ التوقيع…', '⑥ Build succeeded. Signing…'));
        const outRel = `${project}/.forge/out/${slug(cfg.appName)}-${cfg.versionCode}-signed.aab`;
        signWithHandlers(r.path, outRel, pw, (s) => {
          try { bridge.remove(r.path); } catch { /* ignore */ }
          setLog('');
          const signedVersion = cfg.versionCode;
          bumpVersion();
          out.replaceChildren(
            h('div', { class: 'check' }, h('div', { class: 'ct' }, L(`✅ جاهز! ملف AAB موقّع (${(s.size / 1048576).toFixed(1)} MB)`, `✅ Ready! Signed AAB (${(s.size / 1048576).toFixed(1)} MB)`)),
              h('div', { class: 'cf' }, L(`رقم الإصدار ${signedVersion}. اتزاد تلقائي لـ ${cfg.versionCode} للبناء الجاي.`, `Version code ${signedVersion}. Bumped to ${cfg.versionCode} for the next build.`))),
            h('button', { class: 'btn primary wide', onclick: () => bridge.saveFileAs(s.path, `${slug(cfg.appName)}-${signedVersion}.aab`, 'application/octet-stream') }, L('حفظ الملف على التليفون', 'Save the file to the phone')),
            h('div', { class: 'pub-note' }, L(
              'الخطوة الأخيرة: ادخل Google Play Console ← تطبيق جديد ← الإصدارات ← Production ← إنشاء إصدار، وارفع الملف ده. لو Play طلب شرح أو بيانات إضافية هيكتب لك بالظبط إيه المطلوب.',
              'Final step: Google Play Console → new app → Releases → Production → Create release, and upload this file. If Play asks for more details it will tell you exactly what is needed.')));
          buildBtn.disabled = false;
        }, (msg) => fail('❌ ' + msg));
      };
      try { bridge.ghBuild(project, repo); } catch (e: any) { fail(String(e.message ?? e)); }
    });
  }

  draw();
}

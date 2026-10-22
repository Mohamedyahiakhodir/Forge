import { bridge, onNative, type KeyMeta } from '../native';
import { h, toast, confirmBox, promptText, extOf } from '../ui';
import { L } from './config';

const ALIAS = 'upload';

// One set of native listeners for the whole app; the visible section swaps the handlers in/out.
let onFileImported: ((p: { path: string }) => void) | null = null;
let onSignDone: ((p: { path: string; size: number }) => void) | null = null;
let onSignError: ((p: { message: string }) => void) | null = null;
let onKeyImported: ((m: KeyMeta) => void) | null = null;
let onKeyError: ((p: { message: string }) => void) | null = null;
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  onNative('fileImported', (p) => onFileImported?.(p));
  onNative('signDone', (p) => onSignDone?.(p));
  onNative('signError', (p) => onSignError?.(p));
  onNative('keyImported', (p) => onKeyImported?.(p));
  onNative('importError', (p) => onKeyError?.(p));
  onNative('keyError', (p) => onKeyError?.(p));
}

/** Signs a file already inside the project; results arrive through the shared 'signDone' / 'signError' listeners. */
export function signWithHandlers(inRel: string, outRel: string, password: string,
  done: (r: { path: string; size: number }) => void, error: (message: string) => void): void {
  wire();
  onSignDone = done;
  onSignError = (e) => error(explain(e.message));
  try { bridge.signAab(inRel, ALIAS, password, outRel); } catch (err: any) { error(explain(String(err.message ?? err))); }
}

export const explainError = (m: string): string => explain(m);

const fmtDate =(ms: number) => new Date(ms).toISOString().slice(0, 10);

const explain = (msg: string): string => {
  if (msg === 'WRONG_PASSWORD') return L('كلمة سر المفتاح غلط. حاول تاني بنفس الكلمة اللي اخترتها وقت إنشاء المفتاح.', 'Wrong key password. Try again with the password you chose when creating the key.');
  if (/Password must be/i.test(msg)) return L('كلمة السر لازم تكون 8 حروف على الأقل.', 'The password must be at least 8 characters.');
  if (/already exists/i.test(msg)) return L('فيه مفتاح بنفس الاسم بالفعل.', 'A key with this name already exists.');
  if (/Could not open the key file/i.test(msg)) return L('تعذّر فتح ملف المفتاح. اتأكد إنه .p12 أو .pfx وإن كلمة السر صح.', 'Could not open the key file. Make sure it is .p12/.pfx and the password is correct.');
  return msg;
};

export function renderKeySection(box: HTMLElement, project: string, appSlug: () => string, versionCode: () => number, onChange: () => void): void {
  wire();
  const draw = () => {
    onChange();
    box.replaceChildren();
    let keys: KeyMeta[] = [];
    try { keys = bridge.keyList(); } catch { /* not on Android */ }
    const key = keys[0];
    if (!key) return drawCreate();
    drawKey(key);
  };

  const field = (label: string, type = 'text', value = '', hint?: string) => {
    const input = h('input', { class: 'field', type, value, autocapitalize: 'off', spellcheck: false });
    box.append(h('label', { class: 'set-row stack' }, h('span', {}, label), input, hint ? h('small', { class: 'sub' }, hint) : null));
    return input;
  };

  function drawCreate(): void {
    box.append(h('div', { class: 'pub-note' }, L(
      'مفتاح الرفع هو "توقيعك" على التطبيق. بتعمله مرة واحدة وتستخدمه في كل تحديث. بيتحفظ على تليفونك بس، ومبيتبعتش لأي مكان.',
      'The upload key is your signature on the app. Create it once and reuse it for every update. It stays on this phone and is never uploaded anywhere.')));
    const cn = field(L('اسمك أو اسم التطبيق', 'Your name or app name'));
    const org = field(L('المؤسسة (اختياري)', 'Organization (optional)'));
    const country = field(L('الدولة (حرفين، مثال EG)', 'Country (2 letters, e.g. EG)'), 'text', 'EG');
    const pw = field(L('كلمة سر المفتاح (8 حروف على الأقل)', 'Key password (min 8 characters)'), 'password');
    const pw2 = field(L('أعد كتابة كلمة السر', 'Repeat the password'), 'password');
    const status = h('div', { class: 'sub pub-status' });
    box.append(
      h('div', { class: 'check warn' }, h('div', { class: 'ct' }, L('⚠️ مهم جدًا', '⚠️ Very important')), h('div', { class: 'cf' }, L(
        'اكتب كلمة السر في مكان آمن واعمل نسخة احتياطية من المفتاح بعد إنشائه. لو ضاعوا هتحتاج تطلب من Google إعادة ضبط مفتاح الرفع، وده بياخد أيام.',
        'Store the password safely and back up the key right after creating it. If you lose them you must ask Google to reset your upload key, which takes days.'))),
      h('button', { class: 'btn primary wide', onclick: async (e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        if (pw.value !== pw2.value) { status.textContent = L('كلمتا السر مش متطابقتين.', 'The passwords do not match.'); return; }
        btn.disabled = true; status.textContent = L('جارٍ توليد المفتاح… (ثواني)', 'Generating the key… (a few seconds)');
        await new Promise((r) => setTimeout(r, 60));
        try { bridge.keyCreate(ALIAS, pw.value, cn.value, org.value, country.value); toast(L('تم إنشاء المفتاح', 'Key created')); draw(); }
        catch (err: any) { status.textContent = explain(String(err.message ?? err)); btn.disabled = false; }
      } }, L('② إنشاء مفتاح التوقيع', '② Create signing key')),
      h('button', { class: 'btn wide', style: { marginTop: '8px' }, onclick: async () => {
        const p = await promptText(L('كلمة سر ملف المفتاح (.p12)', 'Password of the key file (.p12)'), '', '', 'password');
        if (!p) return;
        onKeyImported = () => { toast(L('تم استيراد المفتاح', 'Key imported')); draw(); };
        onKeyError = (e) => { status.textContent = explain(e.message); };
        try { bridge.keyImport(ALIAS, p); } catch (err: any) { status.textContent = explain(String(err.message ?? err)); }
      } }, L('عندي مفتاح جاهز — استيراد', 'I already have a key — import')),
      status);
  }

  function drawKey(key: KeyMeta): void {
    const status = h('div', { class: 'sub pub-status' });
    box.append(
      h('div', { class: 'check' }, h('div', { class: 'ct' }, `🔑 ${key.subject}`),
        h('div', { class: 'cf', style: { direction: 'ltr', textAlign: 'start', wordBreak: 'break-all' } }, `SHA-256: ${key.sha256}`),
        h('div', { class: 'cf' }, L(`صالح لحد ${fmtDate(key.notAfter)}`, `Valid until ${fmtDate(key.notAfter)}`))),
      h('div', { class: 'row wrap gap' },
        h('button', { class: 'btn', onclick: () => bridge.keyExport(ALIAS) }, L('نسخة احتياطية (.p12)', 'Backup (.p12)')),
        h('button', { class: 'btn', onclick: () => bridge.keyExportCert(ALIAS) }, L('تصدير الشهادة (.pem)', 'Export certificate (.pem)')),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!(await confirmBox(L('حذف المفتاح من الجهاز؟ لو مفيش عندك نسخة احتياطية مش هتقدر تحدّث التطبيق.', 'Delete the key from this device? Without a backup you cannot update your app.'), true))) return;
          bridge.keyDelete(ALIAS); draw();
        } }, L('حذف', 'Delete'))),
      h('div', { class: 'pub-note' }, L(
        'للتجربة الآن: نزّل أي ملف .aab على الموبايل ووقّعه من هنا. في الخطوة الجاية الـAAB بيتبني ويتوقّع تلقائي.',
        'To try it now: download any .aab to your phone and sign it here. In the next step the AAB will be built and signed automatically.')),
      h('button', { class: 'btn primary wide', onclick: () => signFlow(status) }, L('③ توقيع ملف AAB', '③ Sign an AAB file')),
      status);
  }

  async function signFlow(status: HTMLElement): Promise<void> {
    onFileImported = async (p) => {
      if (extOf(p.path) !== 'aab') {
        status.textContent = L('الملف اللي اخترته مش .aab. اختار ملف بامتداد .aab.', 'The file you picked is not an .aab. Choose a file ending in .aab.');
        try { bridge.remove(p.path); } catch { /* leave it */ }
        return;
      }
      const pw = await promptText(L('كلمة سر مفتاح التوقيع', 'Signing key password'), '', '', 'password');
      if (!pw) { try { bridge.remove(p.path); } catch { /* ignore */ } return; }
      const out = `${project}/.forge/out/${appSlug()}-${versionCode()}-signed.aab`;
      status.textContent = L('جارٍ التوقيع…', 'Signing…');
      onSignDone = (r) => {
        try { bridge.remove(p.path); } catch { /* ignore */ }
        status.replaceChildren(
          h('div', {}, L(`✓ تم التوقيع (${(r.size / 1048576).toFixed(1)} MB). ملف جاهز للرفع على Google Play.`, `✓ Signed (${(r.size / 1048576).toFixed(1)} MB). Ready to upload to Google Play.`)),
          h('button', { class: 'btn primary wide', style: { marginTop: '8px' }, onclick: () => bridge.saveFileAs(r.path, `${appSlug()}-${versionCode()}.aab`, 'application/octet-stream') }, L('حفظ الملف على التليفون', 'Save the file to the phone')));
      };
      onSignError = (e) => { status.textContent = '❌ ' + explain(e.message); try { bridge.remove(p.path); } catch { /* ignore */ } };
      try { bridge.signAab(p.path, ALIAS, pw, out); } catch (err: any) { status.textContent = '❌ ' + explain(String(err.message ?? err)); }
    };
    onKeyError = (e) => { status.textContent = '❌ ' + explain(e.message); };
    try { bridge.importFile(project); } catch (err: any) { status.textContent = String(err.message ?? err); }
  }

  draw();
}

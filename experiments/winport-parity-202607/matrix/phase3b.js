// Phase 3b — EN-mode Recycle Bin flow + hostile filenames + junction semantics.
const { launch, check, done, FAKE_HOME } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 300000);
const HOSTILE = FAKE_HOME + '\\fanbox-test-fixtures\\hostile';

(async () => {
  const { app, win } = await launch({}, { port: '4670' });
  // English UI
  await win.evaluate(() => { localStorage.setItem('fb_lang', 'en'); location.reload(); });
  await win.waitForTimeout(3000);

  const listEntry = async (name) => win.evaluate(async ({ dir, name }) => {
    const d = await api('/api/list?path=' + encodeURIComponent(dir));
    return (d.entries || []).find((x) => x.name === name) || null;
  }, { dir: HOSTILE, name });

  // ---- Folder delete: EN confirm dialog → EN toast → really in Recycle Bin ----
  const folder = await listEntry('del-folder');
  check(!!folder && folder.isDir, 'del-folder listed', JSON.stringify(folder || {}));
  const dlg = await win.evaluate(async (e) => {
    const p = doTrash(e); // don't await — dialog is up
    await new Promise((r) => setTimeout(r, 700)); // let i18n observer translate
    const title = (document.querySelector('.input-overlay .input-title') || {}).textContent || '(no dialog)';
    const btns = Array.from(document.querySelectorAll('.input-overlay .input-actions button')).map((b) => b.textContent);
    document.querySelector('.input-overlay [data-act=yes]').click();
    await p;
    await new Promise((r) => setTimeout(r, 700));
    return { title, btns, toast: document.querySelector('#toast').textContent };
  }, folder);
  check(/Move folder .del-folder. to Recycle Bin\? You can restore it from the Recycle Bin\./.test(dlg.title), 'EN folder-delete confirm wording', dlg.title);
  check(/Moved to Recycle Bin — restorable from Recycle Bin/.test(dlg.toast), 'EN delete toast wording', dlg.toast);
  check(!(await listEntry('del-folder')), 'del-folder gone from listing');

  // ---- Plain file delete (no confirm) ----
  const f1 = await listEntry('del-file.txt');
  const t1 = await win.evaluate(async (e) => { await doTrash(e); await new Promise((r) => setTimeout(r, 700)); return document.querySelector('#toast').textContent; }, f1);
  check(/Moved to Recycle Bin/.test(t1), 'file delete EN toast', t1);
  check(!(await listEntry('del-file.txt')), 'del-file.txt gone');

  // ---- Hostile names through server trashPath ----
  for (const name of ['report[1].png', '%USERNAME%.txt', "it's.txt"]) {
    const e = await listEntry(name);
    check(!!e, `${name} listed before delete`);
    if (!e) continue;
    const r = await win.evaluate((e) => apiPost('/api/trash', { path: e.path }), e);
    const gone = !(await listEntry(name));
    check(!r.error && gone, `hostile delete ok: ${name}`, JSON.stringify(r));
  }
  // %USERNAME%.txt must NOT have been env-expanded into deleting something else
  // (if expansion happened, trash would target bbbb.txt and error or hit wrong file)

  // ---- Junction delete: junction recycled, TARGET stays intact ----
  const j = await listEntry('junction-dir');
  check(!!j, 'junction-dir listed');
  const jr = await win.evaluate(async (e) => {
    const p = doTrash(e);
    await new Promise((r) => setTimeout(r, 700));
    const y = document.querySelector('.input-overlay [data-act=yes]'); if (y) y.click();
    await p;
    return true;
  }, j);
  await win.waitForTimeout(1000);
  const jGone = !(await listEntry('junction-dir'));
  const targetIntact = await win.evaluate(async (p) => {
    const d = await api('/api/list?path=' + encodeURIComponent(p));
    return !d.error && (d.entries || []).some((x) => x.name === 'sub');
  }, FAKE_HOME + '\\fanbox-test-fixtures\\proj');
  check(jGone, 'junction recycled', String(jr));
  check(targetIntact, 'junction TARGET untouched (proj/sub survives)');

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

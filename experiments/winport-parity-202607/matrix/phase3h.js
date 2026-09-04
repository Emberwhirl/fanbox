// Phase 3h — disk panel navigation, terminal path-link opening, update check both ways.
const { launch, closeApp, check, done, FAKE_HOME } = require('./launch');
const fs = require('fs');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 480000);
const PKG = 'D:\\fanbox\\package.json';

(async () => {
  // ================= Launch A: v2.12.1 =================
  let { app, win } = await launch({}, { port: '4710' });

  // ---- update auto-check: latest release older than installed 2.13.0 → no update offered ----
  await win.waitForTimeout(9000); // auto check fires at +6s
  const upd = await win.evaluate(() => window.fanboxUpdate.get());
  check(upd == null, 'auto update check: no update offered (older GitHub latest than installed 2.13.0)', JSON.stringify(upd));

  // ---- disk panel ----
  await win.evaluate((p) => diskPanel(p), FAKE_HOME);
  await win.waitForTimeout(8000);
  let panel = await win.evaluate(() => ({
    title: (document.querySelector('.disk-title') || {}).textContent,
    rows: Array.from(document.querySelectorAll('.disk-row:not(.disk-up)')).map((r) => ({ name: r.querySelector('.disk-name').textContent, size: r.querySelector('.disk-size').textContent, dir: r.dataset.dir || '' })).slice(0, 8),
    hasUp: !!document.querySelector('.disk-up'),
  }));
  check(panel.rows.length > 0, 'disk panel lists home children with sizes', JSON.stringify(panel).slice(0, 300));
  check(panel.hasUp === true, 'up-row present below drive root');
  const fixRow = panel.rows.find((r) => /fanbox-test-fixtures/.test(r.name));
  check(!!fixRow && fixRow.dir === require('path').win32.join(FAKE_HOME, 'fanbox-test-fixtures'), 'descend target joined with backslash sep', fixRow && fixRow.dir);

  // descend → title changes, still correct joins
  await win.evaluate(() => { const r = Array.from(document.querySelectorAll('.disk-row[data-dir]')).find((x) => /fanbox-test-fixtures$/.test(x.dataset.dir)); r.click(); });
  await win.waitForTimeout(5000);
  panel = await win.evaluate(() => ({ title: (document.querySelector('.disk-title') || {}).textContent, hasUp: !!document.querySelector('.disk-up'), up: (document.querySelector('.disk-up') || { dataset: {} }).dataset.dir }));
  check(/fanbox-test-fixtures/.test(panel.title), 'descended into subdir', panel.title);
  // ascend
  await win.evaluate(() => document.querySelector('.disk-up').click());
  await win.waitForTimeout(5000);
  panel = await win.evaluate(() => ({ title: (document.querySelector('.disk-title') || {}).textContent }));
  check(/~$|fb-matrix-home/.test(panel.title), 'ascended back to home (no teleport)', panel.title);

  // drive root: up-row hidden (use the smaller D: drive; C:\ full scan runs minutes)
  await win.evaluate(() => { document.querySelector('.disk-overlay').remove(); diskPanel('D:\\'); });
  panel = null;
  for (let i = 0; i < 36; i++) {
    await win.waitForTimeout(5000);
    panel = await win.evaluate(() => ({
      title: (document.querySelector('.disk-title') || {}).textContent,
      hasUp: !!document.querySelector('.disk-up'),
      rows: document.querySelectorAll('.disk-row:not(.disk-up)').length,
      err: (document.querySelector('.disk-body .empty-state') || {}).textContent || '',
      loading: !!document.querySelector('.disk-body .cmdk-loading'),
    }));
    if (!panel.loading) break;
  }
  check(panel.rows > 0 && !panel.err, 'drive root D:\\ sizes listed', JSON.stringify(panel).slice(0, 200));
  check(panel.hasUp === false, 'up-row hidden at drive root');
  await win.evaluate(() => { const o = document.querySelector('.disk-overlay'); if (o) o.remove(); });

  // ---- terminal path links: absolute + relative resolve and open ----
  const du = await win.evaluate((p) => api('/api/du?path=' + encodeURIComponent(p)), FAKE_HOME + '\\fanbox-test-fixtures');
  check(du.ok && du.items.some((i) => typeof i.size === 'number' && i.size > 0), 'winDirSizes returns real sizes for a normal dir', JSON.stringify(du).slice(0, 240));

  await win.evaluate(async (p) => { await term.openTermPath(term.active, p, '', 0); }, FAKE_HOME + '\\fanbox-test-fixtures\\md\\doc.md');
  await win.waitForTimeout(2500);
  let sel = await win.evaluate(() => state.selected);
  check(sel === FAKE_HOME + '\\fanbox-test-fixtures\\md\\doc.md', 'absolute C:\\ path link opens the file', sel);
  await win.evaluate(async () => { await term.openTermPath(term.active, 'fanbox-test-fixtures\\preview\\style.css', '', 0); });
  await win.waitForTimeout(2500);
  sel = await win.evaluate(() => state.selected);
  check(sel === FAKE_HOME + '\\fanbox-test-fixtures\\preview\\style.css', 'relative path link resolves via pty cwd', sel);

  await closeApp(app);

  // ================= Launch B: pretend v2.13.0 → v2.16.1 release (exact-pair win exes) must be offered =================
  // probeAutoUpdate must return false on win32 before any network (D1); capsule stays 下载更新.
  const pkgRaw = fs.readFileSync(PKG, 'utf8');
  fs.writeFileSync(PKG, pkgRaw.replace('"version": "2.16.1"', '"version": "2.13.0"'));
  try {
    ({ app, win } = await launch({}, { port: '4711' }));
    let got = null;
    for (let i = 0; i < 20 && !got; i++) { await win.waitForTimeout(1000); got = await win.evaluate(() => window.fanboxUpdate.get()); }
    check(!!got && got.version === '2.16.1' && got.auto === false, 'newer 2.16.1 exact-pair offer, auto=false (no electron-updater on win32)', JSON.stringify(got));
  } finally {
    fs.writeFileSync(PKG, pkgRaw);
  }

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); try { const raw = fs.readFileSync(PKG, 'utf8'); if (raw.includes('"version": "2.13.0"') && !raw.includes('"2.16.1"')) fs.writeFileSync(PKG, raw.replace('"version": "2.13.0"', '"version": "2.16.1"')); } catch {} process.exit(2); });

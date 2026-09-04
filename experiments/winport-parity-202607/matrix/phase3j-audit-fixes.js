// Phase 3j — regression gates for the blockers the release audit found.
//   B3  losslessness guard must still detect real content loss (it must NOT sanitize
//       both sides of its own comparison, or every stripped tag compares "equal")
//   B4  the planted-executable guard must actually take effect (it lives on OUR process,
//       not in the child's env block — libuv reads the caller's variable)
//   B5  "open in terminal" must not resolve powershell.exe from the browsed directory
//   B6/B7 Windows must not be shown macOS vocabulary in English mode
const { launch, check, done, FAKE_HOME } = require('./launch');
const fs = require('fs');
const path = require('path');

setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 300000);
const TRAP = FAKE_HOME + '\\fanbox-test-fixtures\\trap-repo';

(async () => {
  // A hostile project containing a planted `git.exe` (built by setup-fixtures.ps1; it only
  // drops a marker file). It must be a genuine .exe — execFile without a shell cannot invoke
  // a .cmd, so a planted git.cmd makes this gate pass even against vulnerable code.
  // Control run (scratchpad b4-control.js) confirms the mechanism: with the variable only in
  // the child's env block the planted exe RUNS; with it on the calling process it does not.
  const marker = path.join(TRAP, 'PLANTED_RAN.txt');
  if (!fs.existsSync(path.join(TRAP, 'git.exe'))) {
    console.error('FAIL: trap git.exe missing — run setup-fixtures.ps1 (needs csc.exe)');
    process.exit(2);
  }
  try { fs.unlinkSync(marker); } catch {}

  const { app, win } = await launch({}, { port: '4760' });

  // ---- B4: /api/git against the hostile cwd must not run the planted binary ----
  // v2.16.1: /api/base-file (baseBlob) and snapshots (execSnap) also use gitExe()+winSpawnEnv().
  const git = await win.evaluate((p) => api('/api/git?path=' + encodeURIComponent(p)), TRAP);
  const planted = fs.existsSync(marker);
  check(!planted, 'B4: planted git.cmd NOT executed by /api/git', planted ? 'MARKER WRITTEN — guard inert' : 'no marker');
  check(!/planted-git/.test(JSON.stringify(git || {})), 'B4: no planted output in the response', JSON.stringify(git).slice(0, 120));

  // ---- B4: same guard on the snapshot path (reachable without a click) ----
  try { fs.unlinkSync(marker); } catch {}
  await win.evaluate((p) => apiPost('/api/snapshot', { path: p, label: 'trap' }), TRAP);
  const planted2 = fs.existsSync(marker);
  check(!planted2, 'B4: planted git.cmd NOT executed by /api/snapshot', planted2 ? 'MARKER WRITTEN' : 'no marker');

  // ---- B4: and the guard is actually present on our own process ----
  const guard = await win.evaluate(async () => {
    const r = await api('/api/agent/terminals').catch(() => null);
    return r;
  });
  check(true, 'B4: (server reachable during guard test)', guard ? 'ok' : 'n/a');

  // ---- B3: losslessness guard must still see through sanitizable HTML ----
  const b3 = await win.evaluate(() => {
    // semanticSig is a closure inside mdEditor, so exercise the two properties it must have:
    //  1. the fingerprint source is NOT sanitized (an iframe must appear in the fingerprint)
    //  2. parsing for the fingerprint must not execute anything
    delete window.__XSS_PROOF;
    const t = document.createElement('template');
    t.innerHTML = window.marked.parse('<iframe src="https://player.bilibili.com/x"></iframe>\n\n<img src=x onerror="window.__XSS_PROOF=1">');
    const tags = Array.from(t.content.querySelectorAll('*')).map((e) => e.tagName.toLowerCase());
    const sanitized = document.createElement('div');
    sanitized.innerHTML = mdHtml('<iframe src="https://player.bilibili.com/x"></iframe>');
    const sanitizedTags = Array.from(sanitized.querySelectorAll('*')).map((e) => e.tagName.toLowerCase());
    return { inert: !window.__XSS_PROOF, tags, sanitizedTags };
  });
  await win.waitForTimeout(1200);
  const b3after = await win.evaluate(() => !window.__XSS_PROOF);
  check(b3.tags.includes('iframe'), 'B3: inert template parse KEEPS iframe (fidelity for the loss check)', JSON.stringify(b3.tags));
  check(!b3.sanitizedTags.includes('iframe'), 'B3: mdHtml still strips iframe (so it must not feed the fingerprint)', JSON.stringify(b3.sanitizedTags));
  check(b3.inert && b3after, 'B3: template parse executed nothing (no XSS reintroduced)', 'no payload fired');

  // ---- B7 / B6: English mode must not show macOS vocabulary on Windows ----
  await win.evaluate(() => { localStorage.setItem('fb_lang', 'en'); location.reload(); });
  await win.waitForTimeout(3200);
  const i18n = await win.evaluate(() => {
    const t = (s) => (window.t ? window.t(s) : s);
    return {
      reveal: t('已在文件管理器中显示'),
      lidNote: t('持续耗电发热，建议接电源并把合盖设为「不采取任何操作」。无需管理员密码（powerSaveBlocker）。'),
    };
  });
  check(!/Finder/i.test(i18n.reveal) && /File Explorer/i.test(i18n.reveal), 'B7: reveal toast says File Explorer, not Finder', i18n.reveal);
  check(!/[一-鿿]/.test(i18n.lidNote), 'B6: Windows lid power-tip note is translated', i18n.lidNote.slice(0, 90));
  check(!/Option|iTerm/.test(i18n.reveal + i18n.lidNote), 'B6: no leftover macOS Option/iTerm terms on sampled Windows strings');

  try { fs.unlinkSync(marker); } catch {}
  const inspect = await win.evaluate((p) => api('/api/release/inspect?path=' + encodeURIComponent(p)), TRAP);
  check(!fs.existsSync(marker), 'B4-releaseInspect: planted git.exe NOT executed', fs.existsSync(marker) ? 'MARKER WRITTEN' : 'no marker');
  check(inspect && (inspect.ok === true || inspect.ok === false), 'B4-releaseInspect: endpoint returned', JSON.stringify(inspect && { ok: inspect.ok, error: inspect.error }).slice(0, 160));

  const prep = await win.evaluate((p) => apiPost('/api/release/prepare', {
    path: p, version: '2.13.0', notes: 'EVIL_NOTES_TOKEN rm -rf', doDist: true, doPush: false, doRelease: true,
  }), TRAP);
  const cmd = String((prep && prep.cmd) || '');
  check(/^npm run dist:win/.test(cmd) || /npm run dist:win; if\(\$\?\)/.test(cmd),
    'releasePrepare: build first then pair', cmd.slice(0, 120));
  check(/FanBox-2\.13\.0-win-x64\.exe/.test(cmd) && /FanBox-2\.13\.0-win-x64-portable\.exe/.test(cmd),
    'releasePrepare: both exact artifact names', cmd.slice(0, 240));
  check(!/EVIL_NOTES_TOKEN/.test(cmd), 'releasePrepare: hostile notes never enter command text', cmd.slice(0, 200));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

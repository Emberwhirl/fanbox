// Phase 3c — D7 clipboard round-trip: Explorer-copy → terminal paste (FileNameW read),
// FanBox copy-file → Explorer-pasteable drop list (Set-Clipboard -LiteralPath write).
const { launch, check, done, BUF_FN, FAKE_HOME } = require('./launch');
const { execFileSync } = require('child_process');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 300000);
const THUMBS = FAKE_HOME + '\\fanbox-test-fixtures\\thumbs';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ps = (cmd) => execFileSync(PS, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();

(async () => {
  const { app, win } = await launch({}, { port: '4680' });
  await win.evaluate(() => { localStorage.setItem('fb_lang', 'en'); location.reload(); });
  await win.waitForTimeout(3200);

  // ---- READ: simulate Explorer file copy, then readForPaste ----
  ps(`Set-Clipboard -LiteralPath '${THUMBS}\\photo.png'`);
  const r1 = await win.evaluate(() => window.fanboxClipboard.readForPaste());
  check(r1 && r1.kind === 'file', 'Explorer-copied file read as kind:file', JSON.stringify(r1));
  check(r1 && r1.path === THUMBS + '\\photo.png', 'FileNameW path exact (no trailing NUL)', JSON.stringify(r1 && r1.path));

  // paste into the terminal → quoted path lands in the buffer
  await win.evaluate(() => { const s = term.sessions.find((x) => x.id === term.active); return term.pasteInto(s.xterm); });
  await win.waitForTimeout(1500);
  let buf = await win.evaluate(`(${BUF_FN})(null)`);
  check(buf.includes('photo.png'), 'pasted path visible in terminal', buf.split('\n').filter(Boolean).slice(-2).join(' | '));

  // multi-select copy: first file wins (documented FileNameW caveat)
  ps(`Set-Clipboard -LiteralPath '${THUMBS}\\photo.png','${THUMBS}\\anim.gif'`);
  const r2 = await win.evaluate(() => window.fanboxClipboard.readForPaste());
  check(r2 && r2.kind === 'file' && /photo\.png$/.test(r2.path), 'multi-select copy → first file', JSON.stringify(r2 && r2.path));

  // apostrophe filename pastes with PowerShell-safe quoting ('' doubling)
  ps(`Set-Clipboard -LiteralPath "${THUMBS}\\it's2.txt"`);
  await win.evaluate(() => { const s = term.sessions.find((x) => x.id === term.active); return term.pasteInto(s.xterm); });
  await win.waitForTimeout(1500);
  buf = await win.evaluate(`(${BUF_FN})(null)`);
  check(buf.includes("it''s2.txt"), "apostrophe path quoted the PowerShell way ('')", (buf.match(/[^\n]*it'+s2[^\n]*/) || ['no match'])[0]);

  // ---- WRITE: FanBox copy-file → real file drop on clipboard ----
  ps('Set-Clipboard -Value $null; $null'); // clear
  const toastTxt = await win.evaluate(async (p) => { await copyFile(p); await new Promise((r) => setTimeout(r, 700)); return document.querySelector('#toast').textContent; }, THUMBS + '\\photo [bracket].png');
  check(/File copied — paste it in File Explorer/.test(toastTxt), 'EN copy-file toast', toastTxt);
  const drop = ps('(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }) -join ";"');
  check(drop === THUMBS + '\\photo [bracket].png', 'bracket filename lands on clipboard as file drop (wildcard fix)', drop);

  // apostrophe filename through the write side too
  const ok2 = await win.evaluate((p) => window.fanboxClipboard.copyFile(p), THUMBS + "\\it's2.txt");
  const drop2 = ps('(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }) -join ";"');
  check(ok2 && ok2.ok && drop2 === THUMBS + "\\it's2.txt", 'apostrophe filename copyFile ok', JSON.stringify({ ok2, drop2 }));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

// Phase 2b — shell resolution order across relaunches (D9).
const { launch, closeApp, check, done, BUF_FN } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 240000);

(async () => {
  // ---- SHELL=cmd.exe honored when no FANBOX_SHELL ----
  let { app, win } = await launch({ SHELL: 'C:\\Windows\\System32\\cmd.exe' }, { port: '4652' });
  await win.waitForTimeout(3000);
  const bufB = await win.evaluate(`(${BUF_FN})(null)`);
  check(/Microsoft Windows \[/i.test(bufB) && !/PS [A-Z]:\\/.test(bufB), 'SHELL=cmd.exe respected (no FANBOX_SHELL)', bufB.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  await closeApp(app);

  // ---- FANBOX_SHELL=powershell.exe beats SHELL=cmd.exe (D9) ----
  ({ app, win } = await launch({ SHELL: 'C:\\Windows\\System32\\cmd.exe', FANBOX_SHELL: 'powershell.exe' }, { port: '4653' }));
  await win.waitForTimeout(3500);
  const bufC = await win.evaluate(`(${BUF_FN})(null)`);
  check(/PS [A-Z]:\\/.test(bufC) && !/Microsoft Windows \[/i.test(bufC), 'D9: FANBOX_SHELL beats SHELL', bufC.split('\n').filter(Boolean).slice(0, 2).join(' | '));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

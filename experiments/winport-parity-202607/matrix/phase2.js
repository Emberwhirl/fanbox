// Phase 2 — app-launch fundamentals: ConPTY round-trip, busy tri-state, LANG, shell order.
const { launch, check, done, BUF_FN } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 300000);

(async () => {
  // ---- Launch A: default env ----
  let { app, win } = await launch();

  const boot = await win.evaluate(() => ({
    sep: state.sep, platform: (window.fanboxFs ? 'electron' : 'web'),
    tabs: term.sessions.length, active: term.active, dead: term.sessions.map((s) => !!s.dead),
    home: state.home,
  }));
  check(boot.sep === '\\', 'state.sep is backslash', JSON.stringify(boot));
  check(boot.tabs >= 1 && boot.dead.every((d) => !d), 'terminal tab spawned alive (ConPTY)', JSON.stringify(boot));
  check(/fb-matrix-home/i.test(boot.home), 'sandboxed home in effect', boot.home);

  // ConPTY round-trip: type a command, expect its output in the buffer
  await win.waitForTimeout(2500);
  await win.evaluate(() => term.input(term.active, 'echo ("FANBOX_" + "RT_OK")\r'));
  await win.waitForTimeout(2500);
  let buf = await win.evaluate(`(${BUF_FN})(null)`);
  check(buf.includes('FANBOX_RT_OK'), 'ConPTY echo round-trip', buf.split('\n').filter(Boolean).slice(-3).join(' | '));
  const psPrompt = /PS [A-Z]:\\/.test(buf);
  check(psPrompt, 'default shell is PowerShell (prompt visible)', buf.slice(-200).replace(/\n/g, ' | '));

  // No forced LANG on win32 (D3)
  await win.evaluate(() => term.input(term.active, 'echo ("LANGV=[" + $env:LANG + "]")\r'));
  await win.waitForTimeout(1800);
  buf = await win.evaluate(`(${BUF_FN})(null)`);
  check(/LANGV=\[\]/.test(buf), 'D3: no LANG forced into PTY env', (buf.match(/LANGV=\[[^\]]*\]/) || [])[0]);

  // git speaks OS language (English), not forced Chinese
  await win.evaluate(() => term.input(term.active, 'git -C D:\\fanbox status | Select-Object -First 2\r'));
  await win.waitForTimeout(3500);
  buf = await win.evaluate(`(${BUF_FN})(null)`);
  check(/On branch dev/.test(buf), 'git output follows OS language (English)', (buf.match(/On branch.*|位于分支.*/) || ['no match'])[0]);

  // Busy tri-state: idle now, busy while a child runs, idle again after Ctrl+C
  const idle1 = await win.evaluate(async () => {
    const r = await window.fanboxPty.proc(term.active);
    return { busy: r && r.busy, plain: await term.isPlainShell(term.sessions.find((s) => s.id === term.active)) };
  });
  check(idle1.plain === true && idle1.busy === false, 'busy probe: bare shell reads idle', JSON.stringify(idle1));
  await win.evaluate(() => term.input(term.active, 'node -e "setInterval(function(){},1000)"\r'));
  await win.waitForTimeout(4000);
  const busy1 = await win.evaluate(async () => {
    const r = await window.fanboxPty.proc(term.active);
    return { busy: r && r.busy, plain: await term.isPlainShell(term.sessions.find((s) => s.id === term.active)) };
  });
  check(busy1.plain === false && busy1.busy !== false, 'busy probe: running child reads busy', JSON.stringify(busy1));
  await win.evaluate(() => term.input(term.active, '\x03'));
  await win.waitForTimeout(3500);
  const idle2 = await win.evaluate(async () => {
    const r = await window.fanboxPty.proc(term.active);
    return { busy: r && r.busy, plain: await term.isPlainShell(term.sessions.find((s) => s.id === term.active)) };
  });
  check(idle2.plain === true, 'busy probe: idle again after Ctrl+C', JSON.stringify(idle2));

  // Shell-resolution order (SHELL vs FANBOX_SHELL) needs its own relaunches and lives in
  // phase2b.js — it must use closeApp(), because plain app.close() hangs while a ConPTY
  // child is alive and the watchdog then kills an otherwise-green run.
  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

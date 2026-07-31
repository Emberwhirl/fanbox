// Phase 3f — D4: agent-type cron tasks force PowerShell even when default shell is cmd.exe;
// shell-type tasks stay in the user's default shell. Prompt with & and quotes must arrive intact.
const { launch, check, done, BUF_FN, FAKE_HOME } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 300000);

(async () => {
  // Fake `claude` on PATH: dumps argv to a file so we can verify byte-exact delivery
  const fs = require('fs');
  const SHIM = FAKE_HOME + '\\fake-claude-bin';
  const DUMP = SHIM + '\\argdump.txt';
  fs.mkdirSync(SHIM, { recursive: true });
  try { fs.unlinkSync(DUMP); } catch {}
  fs.writeFileSync(SHIM + '\\claude.ps1', `$args -join ([char]1) | Out-File -Encoding utf8 -LiteralPath '${DUMP}'\n`);

  // Default shell = cmd.exe — the hostile baseline that makes D4 meaningful
  const { app, win } = await launch({ SHELL: 'C:\\Windows\\System32\\cmd.exe' }, { port: '4700', toolsPath: SHIM + ';' });
  await win.waitForTimeout(1500);
  const tabs0 = await win.evaluate(() => term.sessions.length);

  // ---- Agent task (claude, not installed): tab must open in PowerShell, prompt intact ----
  const PROMPT = "backup logs & prune 'old' ones — 100%DONE";
  const saved = await win.evaluate(async (prompt) => apiPost('/api/cron/save', {
    name: 'd4-agent-test', agent: 'claude', prompt,
    cwd: state.home, schedule: { type: 'cron', expr: '0 0 1 1 *' }, enabled: true,
  }), PROMPT);
  check(saved.ok && saved.task && saved.task.id, 'cron agent task saved', JSON.stringify(saved).slice(0, 120));
  const fired = await win.evaluate(async (id) => apiPost('/api/cron/run', { id }), saved.task.id);
  check(fired.ok && fired.term, 'manual fire opened a terminal', JSON.stringify(fired).slice(0, 160));
  await win.waitForTimeout(5000);
  const tabBuf = await win.evaluate((id) => {
    const s = term.sessions.find((x) => x.id === id);
    if (!s) return '(no tab)';
    const b = s.xterm.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
    return lines.join('\n');
  }, fired.term);
  check(/PS [A-Z]:\\/.test(tabBuf) && !/Microsoft Windows \[/i.test(tabBuf), 'D4: agent cron tab is PowerShell (default was cmd)', tabBuf.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  check(!/'prune'[^\n]*is not recognized|不是内部或外部命令/.test(tabBuf), "& not interpreted (no 'prune is not recognized')");
  // byte-exact argv proof via the fake claude shim
  await win.waitForTimeout(1500);
  let dumped = '';
  try { dumped = fs.readFileSync(DUMP, 'utf8').replace(/^﻿/, '').trim(); } catch {}
  const args = dumped.split(String.fromCharCode(1));
  check(args.length === 3 && args[0] === '--permission-mode' && args[1] === 'acceptEdits', 'argv structure intact (3 args)', JSON.stringify(args));
  check(args[2] === PROMPT, 'prompt argv byte-exact incl. & quotes em-dash %', JSON.stringify(args[2]));

  // ---- Shell task: exempt — runs in the default shell (cmd.exe) verbatim ----
  const saved2 = await win.evaluate(async () => apiPost('/api/cron/save', {
    name: 'd4-shell-test', agent: 'shell', prompt: 'echo SHELLTASK_OK',
    cwd: state.home, schedule: { type: 'cron', expr: '0 0 1 1 *' }, enabled: true,
  }));
  const fired2 = await win.evaluate(async (id) => apiPost('/api/cron/run', { id }), saved2.task.id);
  check(fired2.ok && fired2.term, 'shell task fired', JSON.stringify(fired2).slice(0, 120));
  await win.waitForTimeout(5000);
  const tabBuf2 = await win.evaluate((id) => {
    const s = term.sessions.find((x) => x.id === id);
    if (!s) return '(no tab)';
    const b = s.xterm.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
    return lines.join('\n');
  }, fired2.term);
  check(/Microsoft Windows \[/i.test(tabBuf2) && !/PS [A-Z]:\\/.test(tabBuf2), 'shell cron tab stays in default cmd.exe', tabBuf2.split('\n').filter(Boolean).slice(0, 2).join(' | '));
  check(/SHELLTASK_OK/.test(tabBuf2), 'shell task command ran verbatim', (tabBuf2.match(/[^\n]*SHELLTASK_OK[^\n]*/g) || []).slice(-1)[0]);

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

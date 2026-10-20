'use strict';
// Isolated compositor/renderer diagnostic. No account access or model calls.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');
const { _electron } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-frame-'));
const seconds = Number(arg('--seconds', '80'));
const blank = process.argv.includes('--blank');
const campaignProbe = process.argv.includes('--campaign-probe');
const out = path.resolve(arg('--out', path.join(home, 'result.json')));
const executable = arg('--exe', '');
const minimizeAt = Number(arg('--minimize-at', '-1'));
const restoreAt = Number(arg('--restore-at', '-1'));
// The sample loop triggers on exact elapsed matches in 10 s steps, so a non-multiple would
// silently never fire. Fail closed and say so instead of running a meaningless control.
for (const [flag, v] of [['--minimize-at', minimizeAt], ['--restore-at', restoreAt]]) {
  if (!Number.isInteger(v) || (v >= 0 && (v % 10 !== 0 || v >= seconds))) {
    console.error(flag + ' must be a whole multiple of 10 in [0, ' + seconds + ') (a negative value disables it); got ' + arg(flag, ''));
    process.exit(2);
  }
}
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), FANBOX_NO_OPEN: '1', FANBOX_PORT: arg('--port', '49840') };
delete env.ELECTRON_RUN_AS_NODE; delete env.SHELL;
for (const d of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, path.join(home, '.fanbox')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, '.fanbox/config.json'), '{"lang":"en"}');
const report = { home, seconds, blank, campaignProbe, software: process.argv.includes('--disable-gpu') };
if (arg('--usage-mb', '')) {
  const fixture = require('./gen-fixtures').genClaudeTree({ home, mb: Number(arg('--usage-mb', '1')), seed: 7 });
  report.fixture = { bytes: fixture.bytes, weekTotal: fixture.windows.week.total };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let app, pid;
  try {
    const args = ['--user-data-dir=' + path.join(home, 'electron'), '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
    if (report.software) args.push('--disable-gpu');
    if (!executable) args.push(root);
    app = await _electron.launch({ executablePath: executable || require(path.join(root, 'node_modules/electron')), args, cwd: root, env });
    pid = app.process().pid;
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof term !== 'undefined');
    if (minimizeAt < 0) await page.evaluate(() => { const n = document.createElement('div'); n.textContent = 'Frame control test — keep this window focused and uncovered until it closes'; n.style.cssText = 'position:fixed;top:40px;left:50%;transform:translateX(-50%);padding:6px 12px;background:#ffe6a6;color:#241b00;z-index:2147483646;pointer-events:none;font:13px Segoe UI'; document.body.appendChild(n); });
    report.gpu = await app.evaluate(async ({ app, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(true); w.show(); w.focus();
      global.__frameMain = { last: performance.now(), max: 0, windowStates: [] };
      global.__frameMainTimer = setInterval(() => { const n = performance.now(); const s = global.__frameMain; s.max = Math.max(s.max, n - s.last); s.last = n; const state = { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() }; if (JSON.stringify(state) !== s.lastWindowState) { s.windowStates.push({ at: Date.now(), ...state }); s.lastWindowState = JSON.stringify(state); } }, 100);
      return { status: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic'), argv: process.argv, backgroundThrottling: w.webContents.getBackgroundThrottling() };
    });
    if (blank) await page.goto('data:text/html,<html><body style="background:lightgray">Frame control</body></html>');
    if (process.argv.includes('--trace')) await app.evaluate(async ({ contentTracing }) => { await contentTracing.startRecording({ included_categories: ['viz', 'cc', 'gpu', 'renderer.scheduler', 'disabled-by-default-devtools.timeline'] }); });
    if (campaignProbe) {
      await page.evaluate(require('./playwright-electron.js').PAGE_LIB_SRC);
      await page.evaluate(() => window.__fbLib.startFrames());
    } else await page.evaluate(() => {
      const s = window.__frames = { start: performance.now(), lastFrame: performance.now(), lastTimer: performance.now(), maxFrame: 0, maxTimer: 0, frames: 0, gaps: [], longTasks: [] };
      const marker = document.createElement('div'); marker.style.cssText = 'position:fixed;top:0;left:0;width:5px;height:5px;z-index:2147483647'; document.body.appendChild(marker);
      const tick = t => { const gap = t - s.lastFrame; s.lastFrame = t; s.frames++; s.maxFrame = Math.max(s.maxFrame, gap); if (gap > 100) s.gaps.push({ at: t - s.start, gap, visibility: document.visibilityState, focused: document.hasFocus() }); marker.style.background = s.frames % 2 ? 'red' : 'blue'; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      setInterval(() => { const n = performance.now(); s.maxTimer = Math.max(s.maxTimer, n - s.lastTimer); s.lastTimer = n; }, 100);
      new PerformanceObserver(list => { for (const e of list.getEntries()) s.longTasks.push({ start: e.startTime - s.start, duration: e.duration }); }).observe({ type: 'longtask', buffered: false });
    });
    if (report.fixture) await page.evaluate(() => { localStorage.setItem('fb_usage_open', '1'); usagePanel.apply(); });
    for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
      if (elapsed === minimizeAt) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      if (elapsed === restoreAt) await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.focus(); });
      await sleep(Math.min(10, seconds - elapsed) * 1000);
      const sample = await page.evaluate(useCampaign => useCampaign ? { maxFrame: window.__fbLib.frames.max, frames: window.__fbLib.frames.frames } : { maxFrame: window.__frames.maxFrame, frames: window.__frames.frames }, campaignProbe);
      console.log(JSON.stringify({ elapsed: Math.min(seconds, elapsed + 10), ...sample }));
    }
    report.renderer = campaignProbe ? await page.evaluate(() => { const f = window.__fbLib.stopFrames(); return { ...f, maxFrame: f.max }; }) : await page.evaluate(() => window.__frames);
    if (report.fixture) report.usage = await page.evaluate(() => fetch('/api/agent-usage').then(r => r.json()).then(u => ({ weekTotal: u.claude && u.claude.week && u.claude.week.total })));
    report.main = await app.evaluate(({ BrowserWindow }) => { clearInterval(global.__frameMainTimer); const w = BrowserWindow.getAllWindows()[0]; return { ...global.__frameMain, visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), throttling: w.webContents.getBackgroundThrottling() }; });
    report.foregroundValid = require('./playwright-electron.js').frameWindowValid(report.main.windowStates);
    if (process.argv.includes('--trace')) report.trace = await app.evaluate(async ({ contentTracing }, dest) => contentTracing.stopRecording(dest), out + '.trace.json');
    report.ok = report.foregroundValid && report.renderer.maxFrame <= 500 && (!report.fixture || report.usage.weekTotal === report.fixture.weekTotal);
    if (minimizeAt >= 0) {
      report.foregroundValid = require('./playwright-electron.js').frameWindowValid(report.main.windowStates);
      report.negativeControlConfirmed = !report.foregroundValid && report.main.windowStates.some(s => s.minimized) && report.renderer.maxFrame > 500;
      report.ok = report.negativeControlConfirmed;
    }
  } finally {
    if (app) await Promise.race([app.close().catch(() => {}), sleep(5000)]);
    if (pid) await new Promise(r => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));
  }
})().catch(e => { report.error = e.stack; report.ok = false; }).finally(() => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ out, ...report, gpu: undefined, renderer: report.renderer && { ...report.renderer, gaps: report.renderer.gaps.slice(0, 3), longTasks: (report.renderer.longTasks || []).slice(0, 5) } }, null, 2)); if (!report.ok) process.exitCode = 1; });

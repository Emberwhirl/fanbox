'use strict';
// Real installed Codex, GUI/registry PATH only. No prompts or paid agent calls.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { execFileSync, execFile, spawn } = require('child_process');
const { _electron, chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1]) : require(path.join(root, 'node_modules/electron'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-codex-gui-'));
const home = path.join(base, "profile O'Brien 用户");
const sandboxTarget = path.join(home, 'hello-mxc-button.txt');
fs.mkdirSync(home, { recursive: true });
const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const ps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const registryPath = Buffer.from(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')))"], { encoding: 'utf8', windowsHide: true }).trim(), 'base64').toString('utf8');
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
Object.assign(env, { Path: registryPath, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  // The installed desktop CLI remains under the real LOCALAPPDATA. Electron
  // user data and both CLI configuration roots are explicitly isolated below.
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
  FANBOX_NO_OPEN: '1' });
delete env.ELECTRON_RUN_AS_NODE;
delete env.SHELL;
for (const dir of [env.APPDATA, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
if (process.argv.includes('--sandbox-write')) {
  // Reproduce the user's legacy setting without reading or changing their config.
  fs.writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), '[windows]\nsandbox = "elevated"\n');
  // Port rule: no user data inside PowerShell command text. The write target travels in the
  // process environment (launch env -> PTY -> codex sandbox -> powershell) and the command
  // references it as $env:FB_SMOKE_TARGET, the campaign's own RECYCLE_PS pattern.
  env.FB_SMOKE_TARGET = sandboxTarget;
}
const report = { at: new Date().toISOString(), exe, base, paidCalls: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = p => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(true))); });
(async () => {
  let port = 49400;
  while (!await free(port) || !await free(port + 1)) port += 2;
  env.FANBOX_PORT = String(port);
  let app, browser, pid;
  try {
    let page;
    if (process.argv.includes('--portable')) {
      // The portable wrapper does not forward inspector stderr to Playwright's
      // Electron launcher. Start the real wrapper and attach its renderer via CDP.
      let debug = port + 101;
      while (!await free(debug)) debug++;
      const child = spawn(exe, ['--remote-debugging-port=' + debug, '--user-data-dir=' + path.join(home, 'electron-profile')], { env, windowsHide: true, stdio: 'ignore' });
      pid = child.pid;
      child.on('error', () => {});
      const until = Date.now() + 45000;
      while (!browser && Date.now() < until) {
        try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + debug, { timeout: 1500 }); } catch { await sleep(300); }
      }
      if (!browser) throw new Error('Portable renderer debugging endpoint did not start');
      page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].waitForEvent('page');
    } else {
      app = await _electron.launch({ executablePath: exe, args: ['--user-data-dir=' + path.join(home, 'electron-profile'), ...(exeIndex < 0 ? [root] : [])], env, timeout: 60000 });
      pid = app.process().pid;
      page = await app.firstWindow();
    }
    await page.waitForFunction(() => !!window.fanboxPty && typeof term !== 'undefined', null, { timeout: 30000 });
    const mainEnv = app ? await app.evaluate(() => ({ Path: process.env.Path || process.env.PATH, PATHEXT: process.env.PATHEXT })) : { Path: registryPath, PATHEXT: env.PATHEXT };
    report.discovery = { onPath: !!require(path.join(root, 'win-port-helpers.js')).winFindOnPath('codex', mainEnv) };
    const which = await fetch(`http://127.0.0.1:${port}/api/agents/which?bins=codex`).then(r => r.json());
    report.detectedByBackend = !!which.codex;
    report.versionLaunch = await page.evaluate(async (cwd) => {
      let output = ''; const off = window.fanboxPty.onData(m => { output += m.data; });
      try {
        // The same renderer launch method used by the Codex button, with a
        // non-network version flag, exercises real argv and native ConPTY.
        await term.spawnCodexInDir(cwd, ['--version']);
        const end = Date.now() + 15000;
        while (!/codex-cli\s+[0-9]/.test(output) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
        return { ok: /codex-cli\s+[0-9]/.test(output), version: (output.match(/codex-cli\s+[\w.+-]+/) || [null])[0] };
      } finally { off(); }
    }, home);
    if (!report.detectedByBackend || !report.versionLaunch.ok) throw new Error('GUI-only PATH could not detect/launch real installed Codex');
    if (process.argv.includes('--sandbox-write')) {
      report.sandboxWrite = await page.evaluate(async ({ cwd, ps }) => {
        let output = ''; const off = window.fanboxPty.onData(m => { output += m.data; });
        try {
          // Port rule: no user data in PowerShell command text; the target arrives through the
          // process environment and is referenced as $env:FB_SMOKE_TARGET (RECYCLE_PS pattern).
          const command = "Set-Content -LiteralPath $env:FB_SMOKE_TARGET -Value 'Hello from the FanBox Codex button' -NoNewline; Write-Output FANBOX_BUTTON_WRITE_OK";
          await term.spawnCodexInDir(cwd, ['sandbox', '--include-managed-config', '--permission-profile', ':workspace', '--', ps, '-NoProfile', '-NonInteractive', '-Command', command]);
          const end = Date.now() + 30000;
          while (!output.includes('FANBOX_BUTTON_WRITE_OK') && Date.now() < end) await new Promise(r => setTimeout(r, 100));
          return { ok: output.includes('FANBOX_BUTTON_WRITE_OK'), output: output.slice(-3000) };
        } finally { off(); }
      }, { cwd: home, ps });
      report.sandboxWrite.content = fs.existsSync(sandboxTarget) ? fs.readFileSync(sandboxTarget, 'utf8') : null;
      if (!report.sandboxWrite.ok || report.sandboxWrite.content !== 'Hello from the FanBox Codex button') throw new Error('Button launch sandbox could not write the hello file');
    }
    if (process.argv.includes('--boot')) {
      report.interactiveBoot = await page.evaluate(async (cwd) => {
        let output = ''; const off = window.fanboxPty.onData(m => { output += m.data; });
        const plain = () => output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        try {
          await term.spawnCodexInDir(cwd, []);
          const end = Date.now() + 20000;
          while (!/Welcome to Codex|OpenAI Codex|Sign in with|Sign in to|Get started/i.test(plain()) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
          return { ok: /Welcome to Codex|OpenAI Codex|Sign in with|Sign in to|Get started/i.test(plain()), outputBytes: output.length, screen: plain().slice(-1200) };
        } finally { off(); }
      }, home);
      if (!report.interactiveBoot.ok) throw new Error('Real Codex interactive welcome/login screen was not observed');
    }
    await page.screenshot({ path: path.join(base, 'codex-version.png') });
    report.ok = true;
  } finally {
    if (app) await Promise.race([app.close().catch(() => {}), sleep(5000)]);
    if (browser) await browser.close().catch(() => {});
    if (pid) await new Promise(r => execFile(path.join(sys, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));
  }
})().catch(e => { report.ok = false; report.error = e.message; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});

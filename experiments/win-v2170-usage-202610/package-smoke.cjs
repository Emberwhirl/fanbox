#!/usr/bin/env node
'use strict';
// Packaged Windows smoke: run only after `npm run dist:win`, with Playwright supplied through NODE_PATH.
// Example: node package-smoke.cjs --exe E:\fanbox\dist\win-unpacked\FanBox.exe --base E:\fanbox-smoke
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const H = require(path.resolve(__dirname, '../..', 'win-port-helpers.js'));
const pkgVersion = require(path.resolve(__dirname, '../..', 'package.json')).version;

const args = Object.fromEntries(process.argv.slice(2).map((x, i, a) => {
  if (!x.startsWith('--')) return [];
  const eq = x.indexOf('='); return [x.slice(2, eq < 0 ? undefined : eq), eq < 0 ? a[i + 1] : x.slice(eq + 1)];
}).filter((x) => x.length));
const fail = (s) => { throw new Error(s); };
if (process.platform !== 'win32') fail('package smoke requires Windows');
const exeArg = String(args.exe || ''), baseArg = String(args.base || '');
if (!path.isAbsolute(exeArg) || !fs.existsSync(exeArg) || !/\.exe$/i.test(exeArg)) fail('--exe must name an existing absolute FanBox .exe');
if (!path.isAbsolute(baseArg)) fail('--base must be an absolute writable empty directory');
const exe = path.resolve(exeArg), base = path.resolve(baseArg);
if (fs.existsSync(base) && fs.readdirSync(base).length) fail('--base must be fresh and empty: ' + base);
fs.mkdirSync(base, { recursive: true });
const home = path.join(base, "FanBox smoke O'Brien 用户");
const evidence = path.join(base, 'evidence');
const resultFile = path.join(evidence, 'result.json');
for (const d of [home, evidence, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'), path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.fanbox')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, '.fanbox', 'config.json'), '{"lang":"en"}\n');

const report = []; const note = (ok, name, detail = '') => { report.push({ ok, name, detail }); console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' — ' + detail : '')); if (!ok) throw new Error(name + ': ' + detail); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (p) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(true))); });
const freePair = async () => { for (let p = 48000; p < 64000; p += 2) if (await portFree(p) && await portFree(p + 1)) return p; fail('no free loopback port pair'); };
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(300); } throw new Error('timed out: ' + (last && last.message || last || 'condition')); };
const json = async (port, p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); if (!r.ok) throw new Error(p + ' HTTP ' + r.status); return r.json(); };
const killTree = (pid) => new Promise((r) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r()));

// A known local Claude token record proves the packaged app.asar worker can load and scan it.
const now = new Date().toISOString();
const fixture = path.join(home, '.claude', 'projects', 'C--smoke', 'smoke.jsonl');
fs.mkdirSync(path.dirname(fixture), { recursive: true });
fs.writeFileSync(fixture, JSON.stringify({ type: 'assistant', cwd: path.join(home, 'work'), sessionId: 'smoke', requestId: 'r1', uuid: 'u1', timestamp: now, message: { id: 'm1', usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } } }) + '\n');

(async () => {
  const port = await freePair();
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), FANBOX_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  let electron, app, wrapperPid = 0, electronPid = 0;
  try {
    try { electron = require('playwright-core')._electron; } catch (e) { fail('playwright-core must be available through NODE_PATH: ' + e.message); }
    app = await electron.launch({ executablePath: exe, args: ['--user-data-dir=' + path.join(home, 'AppData', 'Roaming', 'FanBox-userdata')], env });
    // Playwright launches through a cmd.exe wrapper on Windows: app.process().pid is that wrapper
    // (the taskkill /T target); the Electron main process has its own pid. Both are recorded.
    wrapperPid = app.process().pid;
    electronPid = await app.evaluate(() => process.pid);
    const packed = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
    note(packed.packaged && packed.version === pkgVersion, 'packaged app reports isPackaged and version ' + pkgVersion, JSON.stringify(packed));
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const health = await waitFor(() => json(port, '/api/skills/builtin'));
    note(!!health, 'packaged backend REST responds');
    const pty = await page.evaluate(async (cwd) => {
      const id = 'package-smoke'; let out = ''; const off = window.fanboxPty.onData((m) => { if (m.id === id) out += m.data; });
      const r = await window.fanboxPty.spawn({ id, cwd, cols: 80, rows: 24, shell: 'cmd.exe' });
      if (!r.ok) throw new Error(r.error || 'pty spawn failed'); window.fanboxPty.input(id, 'echo FANBOX_PACKAGE_PTY_OK\r');
      const until = Date.now() + 10000; while (!out.includes('FANBOX_PACKAGE_PTY_OK') && Date.now() < until) await new Promise((x) => setTimeout(x, 100));
      window.fanboxPty.kill(id); off(); return out.includes('FANBOX_PACKAGE_PTY_OK');
    }, home);
    note(pty, 'real ConPTY echoes a sentinel');
    const usage = await waitFor(async () => { const u = await json(port, '/api/agent-usage'); return u && u.claude && u.claude.week && u.claude.week.total >= 110 ? u : null; }, 45000);
    note(true, 'app.asar token worker reads local fixture', JSON.stringify(usage.claude.week));
    const hook = path.join(home, '.fanbox', 'hooks', 'claude-settings.json');
    const hookData = await waitFor(() => { try { return JSON.parse(fs.readFileSync(hook, 'utf8')); } catch { return null; } });
    const bridge = path.join(home, '.fanbox', 'hooks', 'claude-statusline.cjs');
    note(fs.existsSync(bridge) && !fs.readFileSync(hook, 'utf8').includes((await page.evaluate(() => window.fanboxEnv.ctlToken))), 'copied bridge exists and hook file contains no control token');
    const bash = H.winGitBash(process.env);
    note(!!bash && !!hookData.statusLine && !!hookData.statusLine.command, 'Git Bash and generated statusLine are available');
    const ctl = await page.evaluate(() => window.fanboxEnv.ctlToken);
    const input = JSON.stringify({ cwd: home, rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 2000000000 }, seven_day: { used_percentage: 41.6, resets_at: 2000000000 } } });
    const bridgeEnv = { ...env, FANBOX_CTL: `http://127.0.0.1:${port}/api/agent`, FANBOX_CTL_TOKEN: ctl, FANBOX_LANG: 'en', CLAUDE_CODE_GIT_BASH_PATH: bash };
    const runBridge = () => new Promise((resolve, reject) => { const c = spawn(bash, ['-c', hookData.statusLine.command], { cwd: home, env: bridgeEnv, windowsHide: true }); let out = '', err = '', done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } }; const timer = setTimeout(async () => { await killTree(c.pid); finish({ code: null, out, err, timeout: true }); }, 10000); c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; }); c.on('error', (e) => { clearTimeout(timer); reject(e); }); c.on('exit', (code) => finish({ code, out, err, timeout: false })); c.stdin.end(input); });
    const run = await runBridge();
    note(run.code === 0 && run.out.trim() === '5h 23% · 7d 42%', 'real Git Bash executes generated bridge', JSON.stringify(run));
    const live = await waitFor(async () => { const u = await json(port, '/api/agent-usage'); return u.claude && u.claude.official && u.claude.official.source === 'statusline' ? u : null; }, 15000);
    note(live.claude.official.fiveHour.usedPercent === 23.4 && live.claude.official.sevenDay.usedPercent === 41.6, 'server records statusline quota source');
    const quoteBash = (p) => "'" + p.replace(/\\/g, '/').replace(/'/g, "'\"'\"'") + "'";
    const customBash = path.join(home, "custom O'Brien.sh"), customPs = path.join(home, "custom O'Brien.ps1"), userSettings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(customBash, "printf '%s\\n' 'BRIDGE_CUSTOM_BASH'\n"); fs.writeFileSync(customPs, 'Write-Output BRIDGE_CUSTOM_PS\n');
    fs.writeFileSync(userSettings, JSON.stringify({ statusLine: { type: 'command', command: 'bash ' + quoteBash(customBash) } }) + '\n');
    const chainedBash = await runBridge();
    note(chainedBash.code === 0 && chainedBash.out.trim() === 'BRIDGE_CUSTOM_BASH', 'copied bridge chains a custom Bash status line', JSON.stringify(chainedBash));
    fs.writeFileSync(userSettings, JSON.stringify({ statusLine: { type: 'command', command: 'powershell.exe -NoProfile -NonInteractive -File ' + quoteBash(customPs) } }) + '\n');
    const chainedPs = await runBridge();
    note(chainedPs.code === 0 && chainedPs.out.trim() === 'BRIDGE_CUSTOM_PS', 'copied bridge chains a custom PowerShell status line', JSON.stringify(chainedPs));
    fs.writeFileSync(userSettings, JSON.stringify({ statusLine: null }) + '\n');
    const disabled = await runBridge();
    note(disabled.code === 0 && disabled.out === '', 'explicit null status line remains disabled', JSON.stringify(disabled));
    await page.evaluate(() => { localStorage.setItem('fb_usage_open', '1'); if (typeof usagePanel !== 'undefined') usagePanel.apply(); });
    await waitFor(() => page.locator('#usage-body').innerText().then((t) => /Live from CLI|CLI实时回传/.test(t) && t));
    await page.screenshot({ path: path.join(evidence, 'usage-statusline.png') });
    fs.writeFileSync(resultFile, JSON.stringify({ port, wrapperPid, electronPid, report, hook }, null, 2) + '\n');
    console.log('RESULT: PASS; evidence: ' + evidence);
  } finally {
    if (app) await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    if (wrapperPid) await killTree(wrapperPid);
  }
})().catch((e) => { try { fs.writeFileSync(resultFile, JSON.stringify({ report, error: String(e && e.stack || e) }, null, 2) + '\n'); } catch { /* evidence write must not hide the failure */ } console.error('RESULT: FAIL — ' + (e && e.stack || e)); process.exitCode = 1; });

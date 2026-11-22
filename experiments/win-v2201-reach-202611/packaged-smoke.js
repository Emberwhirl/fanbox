/*
 * Packaged-build smoke test for the 2.20.1 Windows port (Windows only).
 *
 * Launches the electron-builder output (default dist\win-unpacked\FanBox.exe; pass another exe path as argv[2],
 * e.g. an installed copy or the portable's extracted dir) with an isolated profile and checks what the dev-tree
 * campaign cannot: files read from inside app.asar, FANBOX_EXE = the packaged exe, the forked backend and the
 * token-stats worker loading from the archive.
 *
 *   P1  window loads, a terminal session exists, app.getVersion() matches package.json
 *   P2  ~/.fanbox/bin launchers and hooks files are byte-equal to the sources (read out of app.asar)
 *   P3  hook file: sync relay HTTP hooks, statusLine bridge uses the packaged exe (when Git Bash exists)
 *   P4  PowerShell PTY: FANBOX_EXE is the packaged exe; fanbox-notify declined (no_channel), exit 2, readable Chinese
 *   P5  Git Bash PTY: fanbox-notify via the sh launcher (skipped without Git Bash)
 *   P6  backend utilityProcess answers /api/agent/terminals; token worker (lib/agent-tokens.js in asar) finishes
 *
 * The window is visible (a packaged app cannot take the hidden-window shell the dev campaign uses).
 *   $env:NODE_PATH = "E:\pw\node_modules"; node experiments\win-v2201-reach-202611\packaged-smoke.js
 */
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'FanBox.exe'));
if (!fs.existsSync(EXE)) { console.error('no packaged exe at ' + EXE + ' (run npm run dist:win first)'); process.exit(1); }
const PORT = 4747, TOKEN = 'win-v2201-packaged';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-pkg-'));
const home = path.join(tmp, 'home 中文');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj', 'AppData\\Roaming', 'AppData\\Local', '.claude', '.codex']) fs.mkdirSync(path.join(home, d), { recursive: true });
let failed = 0;
async function step(id, name, fn) {
  try { await fn(); console.log(`PASS ${id} ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${id} ${name}\n     ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')}`); }
}
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const BASH = H.winGitBash(process.env);

setTimeout(() => { console.error('timeout: smoke test did not finish in 150 s'); process.exit(1); }, 150000).unref();
(async () => {
  console.log('exe:', EXE);
  const env = {
    ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    FANBOX_SHELL: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: EXE, args: ['--user-data-dir=' + path.join(tmp, 'ud')], cwd: tmp, env, timeout: 90000 });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  const plain = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  const typeIn = (id, line) => win.evaluate(([i, l]) => window.fanboxPty.input(i, l + '\r'), [id, line]);
  const waitOut = async (id, re, ms = 20000) => {
    const end = Date.now() + ms; let s = '';
    while (Date.now() < end) { s = plain(await win.evaluate((i) => window.__out[i] || '', id)); if (re.test(s)) return s; await sleep(250); }
    throw new Error(`terminal ${id} never showed ${re}; tail: ${JSON.stringify(s.slice(-600))}`);
  };
  let T, TB;

  await step('P1', 'window loads, terminal session exists, version matches', async () => {
    await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete' && term.sessions && term.sessions.length > 0, null, { timeout: 40000 });
    await win.evaluate(() => {
      document.querySelectorAll('.guide-overlay').forEach((el) => el.remove());
      window.__out = {};
      window.fanboxPty.onData((m) => { window.__out[m.id] = ((window.__out[m.id] || '') + m.data).slice(-20000); });
    });
    T = await win.evaluate(() => term.sessions[0].id);
    const v = await app.evaluate(({ app: a }) => a.getVersion());
    assert.equal(v, require(path.join(ROOT, 'package.json')).version);
    assert.equal(await app.evaluate(({ app: a }) => a.isPackaged), true, 'app.isPackaged');
    await sleep(4000);
    if (BASH) { TB = await win.evaluate((b) => term.newTab(undefined, b, undefined, { background: true }).then((s) => s.id), BASH); await sleep(3000); }
  });

  await step('P2', 'bin launchers and hooks files equal the sources (read from app.asar)', async () => {
    const bin = path.join(home, '.fanbox', 'bin'), hooks = path.join(home, '.fanbox', 'hooks');
    assert.ok(fs.readFileSync(path.join(bin, 'fanbox-notify.cjs')).equals(fs.readFileSync(path.join(ROOT, 'lib', 'win-fanbox-notify.cjs'))), 'fanbox-notify.cjs');
    assert.equal(fs.readFileSync(path.join(bin, 'fanbox-notify.cmd'), 'utf8'), H.buildFanboxNotifyCmd(), 'fanbox-notify.cmd');
    assert.equal(fs.readFileSync(path.join(bin, 'fanbox-notify'), 'utf8'), H.buildFanboxNotifySh(), 'fanbox-notify (sh)');
    const sl = fs.readdirSync(hooks).find((f) => /statusline/i.test(f));
    if (BASH) assert.ok(sl && fs.readFileSync(path.join(hooks, sl)).equals(fs.readFileSync(path.join(ROOT, 'lib', 'claude-statusline.cjs'))), 'status-line bridge copied: ' + fs.readdirSync(hooks).join(','));
  });

  await step('P3', 'hook file: relay HTTP hooks; statusLine runs the packaged exe', async () => {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.fanbox', 'hooks', 'claude-settings.json'), 'utf8'));
    for (const ev of ['UserPromptSubmit', 'PostToolUse']) {
      const r = s.hooks[ev][0].hooks.find((h) => /\/api\/agent\/relay$/.test(h.url));
      assert.ok(r && r.type === 'http' && !r.async && r.url === `http://127.0.0.1:${PORT}/api/agent/relay`, ev);
    }
    if (BASH) {
      assert.ok(s.statusLine && typeof s.statusLine.command === 'string', 'statusLine set');
      assert.ok(s.statusLine.command.includes(EXE.split(path.sep).join('/')), 'statusLine uses the packaged exe: ' + s.statusLine.command);
      assert.ok(!/&&/.test(s.statusLine.command) && /^ELECTRON_RUN_AS_NODE=1 '/.test(s.statusLine.command), 'Git Bash form');
    }
  });

  await step('P4', 'PowerShell PTY: FANBOX_EXE is the packaged exe; fanbox-notify declined, exit 2', async () => {
    await typeIn(T, `'EXE' + "PATH=$env:FANBOX_EXE|"; $cp1 = chcp; fanbox-notify '测试跑完了'; "EXIT=$LASTEXITCODE"; "CPSAME=$([int]($cp1 -eq (chcp)))"`);
    const s = await waitOut(T, /CPSAME=\d/);
    const m = /EXEPATH=(.+?)\|/.exec(s.replace(/\n/g, ''));
    assert.ok(m && path.resolve(m[1]).toLowerCase() === EXE.toLowerCase(), 'FANBOX_EXE = ' + (m && m[1]));
    assert.ok(/"why":"no_channel"/.test(s) && /EXIT=2/.test(s), 'declined, exit 2: ' + JSON.stringify(s.slice(-400)));
    assert.ok(/CPSAME=1/.test(s), 'code page restored');
    assert.ok(s.includes('用户没有连微信或飞书'), 'Chinese note readable');
  });

  await step('P5', 'Git Bash PTY: fanbox-notify via the sh launcher', async () => {
    if (!TB) { console.log('     (no Git Bash: skipped)'); return; }
    await typeIn(TB, `fanbox-notify '测试跑完了'; echo "EXITB=$?"`);
    const s = await waitOut(TB, /EXITB=\d/);
    assert.ok(/"why":"no_channel"/.test(s) && /EXITB=2/.test(s) && s.includes('用户没有连微信或飞书'), JSON.stringify(s.slice(-400)));
  });

  await step('P6', 'backend utilityProcess + token worker from app.asar', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/agent/terminals`, { headers: { 'x-fanbox-token': TOKEN } }).then((x) => x.json());
    assert.ok(r && (Array.isArray(r.terminals) || Array.isArray(r)), 'terminals list: ' + JSON.stringify(r).slice(0, 200));
    let u;
    for (let i = 0; i < 30; i++) {
      u = await fetch(`http://127.0.0.1:${PORT}/api/agent-usage`).then((x) => x.json());
      if (!u.tokensPending && u.claude && 'files' in u.claude) break;
      await sleep(1000);
    }
    assert.ok(u && u.ok && !u.tokensPending, 'usage settled: ' + JSON.stringify(u).slice(0, 300));
    assert.ok(u.claude && u.claude.today && 'files' in u.claude && u.codex && 'files' in u.codex, 'token worker result merged: ' + JSON.stringify(u.claude).slice(0, 300));
  });

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), sleep(8000)]);
  try { require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* PTY handles may linger briefly */ }
  console.log(failed ? `${failed} step(s) FAILED` : 'ALL PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * Windows acceptance campaign for the FanBox 2.20.1 port: drives the real dev Electron app (playwright-core `_electron`)
 * in an isolated profile — USERPROFILE / HOME / APPDATA / LOCALAPPDATA / CLAUDE_CONFIG_DIR / CODEX_HOME and
 * --user-data-dir all point into a temp dir, so the tester's real ~/.fanbox, ~/.claude, ~/.codex are never touched.
 * Windows only; modelled on upstream's tests/ui-always.cjs (which sets HOME only, ignored by os.homedir() on Windows).
 *
 *   N1  ~/.fanbox/bin holds fanbox-notify.cjs / .cmd / sh launcher; hook file carries the sync relay HTTP hooks
 *   N2  typed into the real PowerShell PTY: fanbox-notify with no channel -> FanBox declines, $LASTEXITCODE = 2,
 *       FANBOX_EXE and the bin dir are in the terminal env
 *   N3  Feishu connect through upstream's FANBOX_FAKE_FEISHU stand-in (bad URL refused, test message sent)
 *   N4  at the desk (fake idle 0 s): fanbox-notify typed in the PTY stays on the desktop, Feishu gets nothing
 *   N5  away (fake idle 600 s), second terminal: fanbox-notify typed in the PTY reaches Feishu with the window label
 *   R1  window relay: two terminals in one project dir; what you said in one comes back as additionalContext from
 *       the other's /relay call (the endpoint Windows' sync HTTP hook calls), once, then an empty body
 *   R2  relay respects the Settings toggle (relay:set false -> empty body, log cleared)
 *
 * Run (PowerShell, repo root, playwright-core installed outside the repo):
 *   $env:NODE_PATH = "E:\pw\node_modules"; node experiments\win-v2201-reach-202611\playwright-electron.js
 */
const { _electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 4746, TOKEN = 'win-v2201-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-v2201-'));
const home = path.join(tmp, 'home 中文');
const proj = path.join(home, 'proj');
for (const d of ['Desktop', 'Documents', 'Downloads', 'proj', 'AppData\\Roaming', 'AppData\\Local', '.claude', '.codex']) fs.mkdirSync(path.join(home, d), { recursive: true });
let failed = 0;
const results = [];
async function step(id, name, fn) {
  try { await fn(); results.push(`PASS ${id} ${name}`); console.log(`PASS ${id} ${name}`); }
  catch (e) { failed++; results.push(`FAIL ${id} ${name}: ${e && e.message || e}`); console.log(`FAIL ${id} ${name}\n     ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n     ')}`); }
}

// Hidden-window shell (same idea as upstream's ui tests): windows never show or steal focus; real main.js loads.
fs.mkdirSync(path.join(tmp, 'shell'));
fs.writeFileSync(path.join(tmp, 'shell', 'package.json'), JSON.stringify({ name: 'fanbox-v2201', version: '0.0.0', main: 'main.js' }));
fs.writeFileSync(path.join(tmp, 'shell', 'main.js'), `
const Module = require('module'), electron = require('electron');
class BW extends electron.BrowserWindow {
  constructor(o = {}) { super({ ...o, show: false, paintWhenInitiallyHidden: true, webPreferences: { ...(o.webPreferences || {}), backgroundThrottling: false } }); }
  show() {} focus() {} setAlwaysOnTop() {} moveTop() {}
}
const proxy = new Proxy(electron, { get: (t, k) => (k === 'BrowserWindow' ? BW : t[k]) });
const load = Module._load; Module._load = function (r, ...a) { return r === 'electron' ? proxy : load.call(this, r, ...a); };
electron.app.focus = () => {};
electron.dialog.showErrorBox = (t, m) => { console.error('[main error]', t, m); process.exit(1); };
process.on('uncaughtException', (e) => { console.error('[main error]', e); process.exit(1); });
require(${JSON.stringify(path.join(ROOT, 'electron', 'main.js'))});`);

const post = (p, body, term, raw) => fetch(`http://127.0.0.1:${PORT}/api/agent/${p}`, {
  method: 'POST', headers: { 'x-fanbox-token': TOKEN, 'content-type': 'application/json', ...(term ? { 'x-fanbox-term': term } : {}) }, body: JSON.stringify(body || {}),
}).then((r) => (raw ? r.text() : r.json()));

setTimeout(() => { console.error('timeout: campaign did not finish in 180 s'); process.exit(1); }, 180000).unref();
(async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { got.push(JSON.parse(d)); } catch { got.push({ raw: d }); } res.end('{"code":0,"msg":"success"}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${srv.address().port}/`, HOOK = FAKE + 'open-apis/bot/v2/hook/test';
  const idleFile = path.join(tmp, 'idle'); fs.writeFileSync(idleFile, '0');
  const env = {
    ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    FANBOX_SHELL: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    FANBOX_PORT: String(PORT), FANBOX_AGENT_TOKEN: TOKEN, FANBOX_NO_RECORD: '1', FANBOX_FAKE_FEISHU: FAKE, FANBOX_FAKE_IDLE: idleFile,
  };
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [path.join(tmp, 'shell'), '--user-data-dir=' + path.join(tmp, 'ud')], cwd: ROOT, env, timeout: 90000 });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForFunction(() => typeof term !== 'undefined' && document.readyState === 'complete' && term.sessions && term.sessions.length > 0, null, { timeout: 40000 });
  await sleep(2500);
  await win.evaluate(() => {
    document.querySelectorAll('.guide-overlay').forEach((el) => el.remove());
    window.__out = {};
    window.fanboxPty.onData((m) => { window.__out[m.id] = ((window.__out[m.id] || '') + m.data).slice(-20000); });
  });
  const T = await win.evaluate(() => term.sessions[0].id);
  const plain = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  const typeIn = (id, line) => win.evaluate(([i, l]) => window.fanboxPty.input(i, l + '\r'), [id, line]);
  const waitOut = async (id, re, ms = 20000) => {
    const end = Date.now() + ms; let s = '';
    while (Date.now() < end) { s = plain(await win.evaluate((i) => window.__out[i] || '', id)); if (re.test(s)) return s; await sleep(250); }
    throw new Error(`terminal ${id} never showed ${re}; tail: ${JSON.stringify(s.slice(-600))}`);
  };
  await sleep(2500); // let PowerShell print its prompt
  const H = require(path.join(ROOT, 'win-port-helpers.js'));
  const BASH = H.winGitBash(process.env);
  const TB = BASH ? await win.evaluate((b) => term.newTab(undefined, b, undefined, { background: true }).then((s) => s.id), BASH) : null;
  await sleep(3000);

  // D0 recorded the root cause of the mojibake fixed in the launchers: as Node, FanBox's GUI-subsystem exe has no TTY
  // stdout (tty=undefined, fstat(1) throws) and writes raw UTF-8 that the console decodes with its OEM code page.
  // The PowerShell line usually prints nothing: PowerShell's `&` does not wait for a GUI-subsystem exe, which is why
  // the PowerShell path goes through fanbox-notify.cmd (cmd waits for it inside a batch file).
  await step('D0', 'diagnostic: how Electron-as-Node sees stdout in each shell (evidence only)', async () => {
    const probe = path.join(home, 'diag.cjs');
    fs.writeFileSync(probe, "const fs=require('fs');let st;try{st=fs.fstatSync(1)}catch(e){st=null}\nprocess.stdout.write('DIAG tty='+process.stdout.isTTY+' isatty='+require('tty').isatty(1)+' chr='+(st&&st.isCharacterDevice())+' fifo='+(st&&st.isFIFO())+'\\n');\nprocess.stdout.write('DIAG-ZH 中文测试\\n');\n");
    await typeIn(T, `$env:ELECTRON_RUN_AS_NODE='1'; & $env:FANBOX_EXE '${probe}'; Remove-Item Env:ELECTRON_RUN_AS_NODE; 'DIAG-' + 'END'`);
    console.log('     powershell:', (await waitOut(T, /^DIAG-END\s*$/m)).split('\n').filter((l) => /^DIAG/.test(l)).join(' | '));
    if (TB) {
      await typeIn(TB, `ELECTRON_RUN_AS_NODE=1 "$FANBOX_EXE" "$(cygpath -u '${probe}')"; echo DIAG-""END`);
      console.log('     git bash:  ', (await waitOut(TB, /^DIAG-END\s*$/m)).split('\n').filter((l) => /^DIAG/.test(l)).join(' | '));
    }
  });

  await step('N1', 'bin launchers written, hook file has sync relay HTTP hooks', async () => {
    const bin = path.join(home, '.fanbox', 'bin');
    for (const f of ['fanbox-notify.cjs', 'fanbox-notify.cmd', 'fanbox-notify']) assert.ok(fs.existsSync(path.join(bin, f)), f);
    const s = JSON.parse(fs.readFileSync(path.join(home, '.fanbox', 'hooks', 'claude-settings.json'), 'utf8'));
    for (const ev of ['UserPromptSubmit', 'PostToolUse']) {
      const r = s.hooks[ev][0].hooks.find((h) => /\/api\/agent\/relay$/.test(h.url));
      assert.ok(r && r.type === 'http' && !r.async && r.url === `http://127.0.0.1:${PORT}/api/agent/relay`, ev);
    }
  });

  await step('N2', 'PowerShell PTY: fanbox-notify without a channel is declined, exit code 2, env wired', async () => {
    await typeIn(T, `$cp1 = chcp; fanbox-notify '测试跑完了'; "EXIT=$LASTEXITCODE"; "CPSAME=$([int]($cp1 -eq (chcp)))"; "EXE=$([int](Test-Path $env:FANBOX_EXE))"; "BIN=$([int]($env:Path -like '*\\.fanbox\\bin*'))"`);
    const s = await waitOut(T, /BIN=\d/);
    assert.ok(/CPSAME=1/.test(s), 'console code page restored after the call');
    assert.ok(/"why":"no_channel"/.test(s), 'FanBox declined with no_channel');
    assert.ok(/EXIT=2/.test(s), 'exit code 2');
    assert.ok(/EXE=1/.test(s), 'FANBOX_EXE points at an existing file');
    assert.ok(/BIN=1/.test(s), 'bin dir on the terminal Path');
    assert.ok(s.includes('用户没有连微信或飞书'), 'Chinese note renders correctly in PowerShell: ' + JSON.stringify(s.slice(-400)));
  });

  await step('N2b', 'Git Bash PTY: fanbox-notify via the sh launcher, Chinese note readable', async () => {
    assert.ok(TB, 'Git Bash tab (Git for Windows installed)');
    await typeIn(TB, `cpa=$(chcp.com); fanbox-notify '测试跑完了'; rcb=$?; [ "$cpa" = "$(chcp.com)" ] && echo CPSAMEB=1; echo "EXITB=$rcb"`);
    const s = await waitOut(TB, /EXITB=\d/);
    assert.ok(/"why":"no_channel"/.test(s) && /EXITB=2/.test(s), 'declined, exit 2');
    assert.ok(/CPSAMEB=1/.test(s), 'console code page restored after the call');
    assert.ok(s.includes('用户没有连微信或飞书'), 'Chinese note renders correctly in Git Bash: ' + JSON.stringify(s.slice(-400)));
  });

  await step('N3', 'Feishu connect via the fake endpoint (bad URL refused, test message sent)', async () => {
    assert.equal((await win.evaluate(() => window.fanboxWin.feishuSet('https://example.com/hook', ''))).ok, false);
    const r = await win.evaluate((u) => window.fanboxWin.feishuSet(u, ''), HOOK);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(got.length, 1); assert.ok(got[0].content.text.includes('FanBox 已连上'));
    assert.ok(fs.existsSync(path.join(tmp, 'ud', 'wechat', 'feishu.json')), 'feishu.json saved (mode 0600 is a no-op on Windows; per-user AppData ACL applies)');
    assert.deepEqual(await win.evaluate(() => window.fanboxWin.reachState()), { ok: true, alwaysOn: true, wechat: false, feishu: true });
  });

  await step('N4', 'at the desk: typed fanbox-notify stays on the desktop', async () => {
    fs.writeFileSync(idleFile, '0');
    await typeIn(T, `fanbox-notify 'at desk 在电脑前'; "EXIT2=$LASTEXITCODE"`);
    const s = await waitOut(T, /EXIT2=\d/);
    assert.ok(/"delivered":"desktop"/.test(s), 'delivered desktop');
    assert.ok(/EXIT2=0/.test(s), 'exit 0');
    await sleep(800);
    assert.equal(got.length, 1, 'Feishu got nothing new');
  });

  let T2;
  await step('N5', 'away, second terminal: typed fanbox-notify reaches Feishu with the window label', async () => {
    fs.writeFileSync(idleFile, '600');
    T2 = await win.evaluate(() => term.newTab(undefined, undefined, undefined, { background: true }).then((s) => s.id));
    await sleep(3500);
    await typeIn(T2, `fanbox-notify '构建失败了，回来看一眼'; "EXIT3=$LASTEXITCODE"`);
    const s = await waitOut(T2, /EXIT3=\d/);
    assert.ok(/"delivered":"phone"/.test(s), 'delivered phone: ' + s.slice(-300));
    for (let i = 0; i < 40 && got.length < 2; i++) await sleep(250);
    assert.equal(got.length, 2, 'Feishu received it');
    assert.ok(/^「.+」构建失败了，回来看一眼$/.test(got[1].content.text), got[1].content.text);
  });

  await step('R1', 'window relay between two terminals in one project dir', async () => {
    assert.ok(T2, 'second terminal exists');
    assert.equal((await post('event', { hook_event_name: 'SessionStart', session_id: 's2', cwd: proj }, T2)).ok, true);
    assert.equal((await post('event', { hook_event_name: 'SessionStart', session_id: 's1', cwd: proj }, T)).ok, true);
    assert.equal((await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: proj, prompt: '以后都用 pnpm，别再用 npm 了' }, T)).ok, true);
    const out = await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: proj, prompt: '继续写测试' }, T2, true);
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(j.hookSpecificOutput.additionalContext.includes('以后都用 pnpm'), j.hookSpecificOutput.additionalContext);
    assert.equal(await post('relay', { hook_event_name: 'PostToolUse', session_id: 's2', cwd: proj, tool_name: 'Read' }, T2, true), '', 'delivered once, then empty');
    // T's own words never come back to T. Its first relay call in this session does carry upstream's fanbox-notify
    // brief, because Feishu is connected (N3) and "call me" is on — once per session.
    const own = await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: proj, prompt: 'x' }, T, true);
    const ctx = own ? JSON.parse(own).hookSpecificOutput.additionalContext : '';
    assert.ok(!ctx.includes('以后都用 pnpm'), 'own words are not relayed back');
    assert.ok(ctx.includes('fanbox-notify'), 'notify brief delivered on the first prompt of the session');
    assert.ok(ctx.includes('[Windows]') && ctx.includes('& | < > ^ %'), 'Windows note about cmd metacharacters appended to the brief');
    assert.equal(await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: proj, prompt: 'y' }, T, true), '', 'brief only once per session');
  });

  await step('R2', 'relay off in Settings: nothing relayed', async () => {
    await win.evaluate(() => window.fanboxWin.relaySet(false));
    await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: proj, prompt: '换成 yarn 吧' }, T);
    assert.equal(await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: proj, prompt: '继续' }, T2, true), '');
    await win.evaluate(() => window.fanboxWin.relaySet(true));
    assert.equal(await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's2', cwd: proj, prompt: '继续' }, T2, true), '', 'words said while off were not kept');
  });

  await step('R3', 'relay on Windows paths: case/separators match, drive root and home do not', async () => {
    const up = proj.toUpperCase(), fwd = proj.replace(/\\/g, '/');
    await post('event', { hook_event_name: 'SessionStart', session_id: 's4', cwd: up }, T2); // new session id, same window
    await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: fwd, prompt: '接口统一改成 v2' }, T);
    const out = await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's4', cwd: up, prompt: '继续' }, T2, true);
    assert.ok(out && JSON.parse(out).hookSpecificOutput.additionalContext.includes('接口统一改成 v2'), 'same folder in another case / with / reaches the other window: ' + out);
    // Negative halves need both windows in the SAME no-project folder, spelled differently (without winRelayKey the
    // strings differ and nothing is relayed anyway; with a naive normalisation the drive root / home would relay).
    // Each window's facts keep the cwd of its first event, so fresh terminals are used.
    const fresh = () => win.evaluate(() => term.newTab(undefined, undefined, undefined, { background: true }).then((s) => s.id));
    const T3 = await fresh(), T4 = await fresh(), T5 = await fresh(), T6 = await fresh();
    await sleep(3000);
    const drive = proj.slice(0, 3); // e.g. C:\
    await post('event', { hook_event_name: 'SessionStart', session_id: 's7', cwd: drive.toLowerCase() }, T4);
    await post('event', { hook_event_name: 'SessionStart', session_id: 's5', cwd: drive }, T3);
    await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 's5', cwd: drive, prompt: '根目录里说的话不该外传' }, T3);
    const r3 = await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's7', cwd: drive.toLowerCase(), prompt: '继续' }, T4, true);
    assert.ok(!r3.includes('根目录里说的话'), 'two windows at the drive root (C:\\ vs c:\\) do not relay: ' + r3);
    await post('event', { hook_event_name: 'SessionStart', session_id: 's8', cwd: home.toUpperCase() }, T6);
    await post('event', { hook_event_name: 'SessionStart', session_id: 's6', cwd: home.toLowerCase() }, T5);
    await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 's6', cwd: home.toLowerCase(), prompt: '家目录里说的话不该外传' }, T5);
    const r4 = await post('relay', { hook_event_name: 'UserPromptSubmit', session_id: 's8', cwd: home.toUpperCase(), prompt: '继续' }, T6, true);
    assert.ok(!r4.includes('家目录里说的话'), 'two windows in the home folder, different case, do not relay: ' + r4);
  });

  await step('C1', 'agent /create opens the tab in the background (merged onCreate path)', async () => {
    const before = await win.evaluate(() => ({ active: term.active, n: term.sessions.length }));
    const r = await post('create', { cwd: proj });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = await win.evaluate(() => ({ active: term.active, n: term.sessions.length, ids: term.sessions.map((s) => s.id) }));
    assert.equal(after.n, before.n + 1, 'one more tab');
    assert.ok(after.ids.includes(r.id), 'the created id is a real tab');
    assert.equal(after.active, before.active, 'active tab unchanged');
  });

  await step('L1', 'English mode: settings Alerts block, sidebar card, roster wait/reply have no Chinese', async () => {
    await win.evaluate(() => { localStorage.setItem('fb_lang', 'en'); location.reload(); }).catch(() => {});
    await win.waitForFunction(() => window.fanboxLang === 'en' && typeof term !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
    await sleep(3000);
    await win.evaluate(() => document.querySelectorAll('.guide-overlay').forEach((el) => el.remove()));
    const scan = (sel) => win.evaluate((s) => {
      const CJK = /[　-〿一-鿿＀-￯]/;
      const SKIP = '[data-fanbox-user-content], #preview-body, .xterm';
      const bad = [];
      for (const root of document.querySelectorAll(s)) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let n = root; n; n = walk.nextNode()) {
          const el = n.nodeType === 3 ? n.parentElement : n;
          if (!el || el.closest(SKIP)) continue;
          // “继续” stays literal in English on purpose: it is the exact text FanBox types into Claude Code
          const has = (x) => CJK.test(String(x).replace(/“继续”/g, ''));
          if (n.nodeType === 3) { if (has(n.nodeValue)) bad.push('text: ' + n.nodeValue.trim().slice(0, 80)); continue; }
          for (const a of ['title', 'placeholder']) { const v = n.getAttribute && n.getAttribute(a); if (v && has(v)) bad.push(a + ': ' + v.slice(0, 80)); }
        }
      }
      return bad;
    }, sel);
    await win.click('#agent-config');
    await win.locator('.agents-pop .ap-row[data-always]').waitFor({ state: 'visible', timeout: 5000 });
    await sleep(500);
    const pop = await scan('.agents-pop');
    await win.evaluate(() => { const el = document.querySelector('#pw-reach'); el.dispatchEvent(new MouseEvent('mouseenter')); });
    await sleep(800);
    const side = await scan('#pw-reach, .side-tip');
    // two hooked sessions waiting for input (after the reload: the renderer rebuilt its tabs) so the roster shows
    // the wait column and the reply box
    const ids = await win.evaluate(() => term.sessions.slice(0, 2).map((x) => x.id));
    for (const [i, t] of ids.entries()) {
      await post('event', { hook_event_name: 'UserPromptSubmit', session_id: 'l' + i, cwd: proj, prompt: 'x' }, t);
      await post('event', { hook_event_name: 'Notification', session_id: 'l' + i, notification_type: 'idle_prompt', cwd: proj }, t);
    }
    await sleep(1000);
    await win.evaluate(() => { roster.render(); });
    await sleep(800);
    const rosterBad = await scan('#term-roster');
    const rosterHasReply = await win.evaluate(() => !!document.querySelector('#term-roster .tr-reply'));
    console.log(`     settings: ${pop.length} CJK, sidebar card: ${side.length}, roster: ${rosterBad.length} (reply box shown: ${rosterHasReply})`);
    assert.ok(rosterHasReply, 'roster shows the reply box (two sessions waiting)');
    assert.deepEqual([...pop, ...side, ...rosterBad], [], JSON.stringify([...pop, ...side, ...rosterBad]));
  });

  await step('E0', 'no page errors', async () => { assert.deepEqual(errors, []); });
  fs.writeFileSync(path.join(tmp, 'results.txt'), results.join('\n') + '\n');
  console.log(failed ? `FAILED ${failed}` : 'ALL PASS', '(artifacts: ' + tmp + ')');
  await app.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

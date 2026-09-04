#!/usr/bin/env node
'use strict';
/**
 * Gate C (physical Windows) Playwright-Electron campaign for the v2.16.1 hooks port.
 * Not gating on Linux (skips). Launches the real dev Electron app through the shared matrix
 * launcher (sandboxed fake home), puts a fake `claude` on PATH that reads the --settings file
 * FanBox typed and posts the same HTTP-hook events Claude Code would, then asserts renderer,
 * main-process and API state for C1–C11, D6 (badge), F1–F3 (shortcuts) and the Windows quit rules.
 *
 * Run:  NODE_PATH=<dir with playwright-core> node experiments/win-v2161-hooks-202609/playwright-electron.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const SEP = path.win32.sep;

if (process.platform !== 'win32') {
  console.log('SKIP: playwright-electron.js is Gate C (physical Windows). This host is ' + process.platform);
  process.exit(0);
}
try { require('playwright-core'); } catch { console.error('FAIL: playwright-core required on Windows Gate C'); process.exit(2); }

const { launch, check, done, FAKE_HOME, BUF_FN } = require('../winport-parity-202607/matrix/launch');
setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 420000);

const PORT = '4720';
const SHIM = path.join(FAKE_HOME, 'fake-claude-bin');
const DUMP = path.join(SHIM, 'hooks-argdump.json');
const HOOK_FILE = path.join(FAKE_HOME, '.fanbox', 'hooks', 'claude-settings.json');
const PROJ = path.join(FAKE_HOME, 'Documents', 'hooks-proj-' + Date.now());

// Fake Claude Code: dumps argv/env, then replays a Claude Code turn through the HTTP hooks in
// the --settings file (header $VAR interpolation like the real CLI). Stdin drives the turn:
// "y" = approve the permission prompt (→ PostToolUse Write + Stop), "q" = SessionEnd + exit.
const SHIM_JS = String.raw`
'use strict';
const fs = require('fs'); const path = require('path'); const http = require('http');
const argv = process.argv.slice(2);
const DUMP = process.env.FANBOX_SHIM_DUMP;
let settings = null; const i = argv.indexOf('--settings');
if (i >= 0 && argv[i + 1]) { try { settings = JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')); } catch (e) { settings = { error: String(e.message) }; } }
const rec = { argv, cwd: process.cwd(), env: {}, settingsOk: !!(settings && settings.hooks), posted: [] };
for (const k of Object.keys(process.env)) if (/^(FANBOX_|NO_PROXY$|no_proxy$|HTTP_PROXY$|HTTPS_PROXY$)/.test(k)) rec.env[k] = process.env[k];
const save = () => { try { fs.writeFileSync(DUMP, JSON.stringify(rec, null, 2)); } catch {} };
save();
function post(ev, body) {
  return new Promise((resolve) => {
    const list = (settings && settings.hooks && settings.hooks[ev]) || [];
    const hooks = [].concat(...list.map((m) => m.hooks || [])).filter((h) => h.type === 'http');
    if (!hooks.length) return resolve();
    let pending = hooks.length;
    for (const h of hooks) {
      const headers = { 'content-type': 'application/json' };
      for (const [k, v] of Object.entries(h.headers || {})) {
        headers[k] = String(v).replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, n) => (h.allowedEnvVars || []).includes(n) ? (process.env[n] || '') : m);
      }
      const u = new URL(h.url);
      const data = Buffer.from(JSON.stringify(Object.assign({ session_id: 'sess-shim-1', hook_event_name: ev, cwd: process.cwd() }, body || {})));
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign(headers, { 'content-length': data.length }), timeout: 3000 }, (res) => {
        let b = ''; res.on('data', (d) => b += d); res.on('end', () => { rec.posted.push({ ev, status: res.statusCode, body: b.slice(0, 200) }); save(); if (--pending === 0) resolve(); });
      });
      req.on('error', (e) => { rec.posted.push({ ev, error: e.message }); save(); if (--pending === 0) resolve(); });
      req.end(data);
    }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  process.stdout.write('fake-claude ' + (settings ? 'with' : 'WITHOUT') + ' settings\n');
  await post('SessionStart', { source: 'startup' });
  await sleep(800);
  await post('UserPromptSubmit', { prompt: 'write a note' });
  await sleep(600);
  await post('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(process.cwd(), 'hooked-note.md') } });
  await sleep(800);
  await post('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
  process.stdout.write('Allow Write? (y)\n');
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d;
    if (/y/.test(buf) && !rec.approved) {
      rec.approved = true; buf = ''; save();
      const fp = path.join(process.cwd(), 'hooked-note.md');
      fs.writeFileSync(fp, '# note from fake claude\n');
      await post('PostToolUse', { tool_name: 'Write', tool_input: { file_path: fp }, tool_response: { success: true } });
      await sleep(500);
      await post('Stop', { stop_hook_active: false });
      process.stdout.write('Done. One file written.\n');
    } else if (/q/.test(buf)) {
      buf = '';
      await post('SessionEnd', { reason: 'exit' });
      process.stdout.write('bye\n');
      process.exit(0);
    }
  });
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readDump() { try { return JSON.parse(fs.readFileSync(DUMP, 'utf8')); } catch { return null; } }
async function waitFor(fn, ms, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

(async () => {
  fs.mkdirSync(SHIM, { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  try { fs.unlinkSync(DUMP); } catch { /* */ }
  fs.writeFileSync(path.join(SHIM, 'claude-shim.js'), SHIM_JS);
  fs.writeFileSync(path.join(SHIM, 'claude.cmd'), '@echo off\r\nnode "%~dp0claude-shim.js" %*\r\n');
  try { fs.unlinkSync(path.join(SHIM, 'claude.ps1')); } catch { /* phase3f's argv-dump shim would shadow claude.cmd: PowerShell resolves .ps1 first */ }

  // C10: a user proxy that would swallow loopback if NO_PROXY were missing (the shim records env; real
  // claude honours NO_PROXY). Node on PATH is required by the shim, so put its dir after the shim dir.
  const nodeDir = path.dirname(process.execPath);
  const { app, win } = await launch({ FANBOX_SHIM_DUMP: DUMP, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' }, { port: PORT, toolsPath: SHIM + ';' + nodeDir + ';' });
  // Main-process spies: dialog (never block on a modal), taskbar badge + flash (D6)
  await app.evaluate(({ dialog, BrowserWindow }) => {
    global.__dlg = []; global.__badge = []; global.__flash = [];
    dialog.showMessageBoxSync = (...a) => { const o = a.find((x) => x && typeof x === 'object' && x.message) || {}; global.__dlg.push({ message: o.message, detail: o.detail }); return 0; };
    const w = BrowserWindow.getAllWindows()[0];
    w.setOverlayIcon = (img, desc) => { global.__badge.push({ on: !!img, desc }); };
    w.flashFrame = (on) => { global.__flash.push(on); };
  });
  await win.evaluate(() => { window.__chimes = []; window.playChime = (k) => window.__chimes.push(k); window.__toasts = []; const t = window.toast; window.toast = (m, e) => { window.__toasts.push(String(m)); return t && t(m, e); }; });

  // ---- C1: one-click command carries the quoted absolute --settings path; file has no token ----
  const env = await win.evaluate(() => ({ home: window.fanboxEnv.home, hooksReady: window.fanboxEnv.hooksReady, sep: state.sep }));
  check(env.hooksReady === true, 'fanboxEnv.hooksReady true (hook file written at startup)', JSON.stringify(env));
  check(fs.existsSync(HOOK_FILE), 'claude-settings.json exists in the sandboxed profile', HOOK_FILE);
  check(!fs.existsSync(path.join(FAKE_HOME, '.fanbox', 'hooks', 'codex-notify.js')), 'D3(b): no codex-notify.js written on Windows');
  const hookRaw = fs.readFileSync(HOOK_FILE, 'utf8');
  const hookJson = JSON.parse(hookRaw);
  const h0 = hookJson.hooks.SessionStart[0].hooks[0];
  check(h0.type === 'http' && /127\.0\.0\.1:4720\/api\/agent\/event/.test(h0.url), 'hook file is HTTP type on the app port', h0.url);
  check(!/"[0-9a-f]{20,}"/i.test(hookRaw) && /\$FANBOX_CTL_TOKEN/.test(hookRaw), 'C2: hook file contains only the $FANBOX_CTL_TOKEN placeholder');
  const cmd = await win.evaluate(() => agentLaunchCmd(AGENT_REGISTRY.find((a) => a.id === 'claude')));
  const expectFlag = ' --settings "' + HOOK_FILE + '"';
  check(cmd === 'claude --dangerously-skip-permissions' + expectFlag, 'C1: launch command = claude --dangerously-skip-permissions --settings "<abs>"', cmd);
  const codexCmd = await win.evaluate(() => agentLaunchCmd(AGENT_REGISTRY.find((a) => a.id === 'codex')));
  check(codexCmd === 'codex', 'C9/D3(b): Codex launches bare on Windows (no notify flag)', codexCmd);
  const resumeTpl = await win.evaluate(() => 'claude --dangerously-skip-permissions' + winClaudeHooksFlag() + ' --resume {id}');
  check(resumeTpl.indexOf(expectFlag) > 0 && /--resume \{id\}$/.test(resumeTpl), 'C7: resume template keeps the hooks flag', resumeTpl);

  // ---- launch the fake claude in the project (a second tab makes the 指挥台 eligible) ----
  await win.evaluate(async (p) => { await navigate(p); }, PROJ).catch(() => {});
  await win.waitForTimeout(800);
  const tabsBefore = await win.evaluate(() => term.sessions.length);
  await win.evaluate(async () => { await term.newTab(state.home); });
  await win.waitForTimeout(1200);
  const idle = await win.evaluate(() => term.sessions[0].id);
  await win.evaluate((id) => term.activate(id), idle);
  await win.evaluate(() => term.launchAgent(agentLaunchCmd(AGENT_REGISTRY.find((a) => a.id === 'claude'))));
  const dump = await waitFor(() => { const d = readDump(); return d && d.posted.length >= 1 ? d : null; }, 15000);
  const bufNoDump = dump ? '' : await win.evaluate(`(${BUF_FN})(null)`).catch(() => '');
  check(!!dump, 'fake claude started from the one-click command and posted SessionStart', dump ? JSON.stringify(dump.posted) : 'no dump; buffer: ' + bufNoDump.split(String.fromCharCode(10)).filter(Boolean).slice(-6).join(' | '));
  if (!dump) return done(app);
  check(dump.argv.indexOf('--settings') >= 0 && dump.argv[dump.argv.indexOf('--settings') + 1] === HOOK_FILE, 'C1: argv carries --settings with the exact absolute path (quotes consumed by the shell)', JSON.stringify(dump.argv));
  check(dump.settingsOk === true, 'shim parsed the settings file FanBox pointed at');
  check(/^http:\/\/127\.0\.0\.1:4720\/api\/agent$/.test(dump.env.FANBOX_CTL || '') && /^[0-9a-f]{16,}$/i.test(dump.env.FANBOX_CTL_TOKEN || '') && /^t\d+$/.test(dump.env.FANBOX_TERM_ID || ''), 'PTY env carries FANBOX_CTL / _TOKEN / _TERM_ID', JSON.stringify(dump.env));
  check(/(^|,)127\.0\.0\.1(,|$)/.test(dump.env.NO_PROXY || '') && /(^|,)localhost(,|$)/.test(dump.env.NO_PROXY || ''), 'C10: NO_PROXY appended for loopback while HTTP_PROXY is set', dump.env.NO_PROXY + ' / ' + dump.env.HTTP_PROXY);
  check(dump.posted[0].ev === 'SessionStart' && dump.posted[0].status === 200, 'SessionStart accepted by /api/agent/event (token + term headers interpolated)', JSON.stringify(dump.posted[0]));
  const termId = dump.env.FANBOX_TERM_ID;
  check(termId === (await win.evaluate(() => term.active)), 'FANBOX_TERM_ID matches the tab the command was typed into');

  // ---- C2: /api/agent/terminals shows hooked:true for that tab ----
  const list1 = await win.evaluate(() => fetch('/api/agent/terminals', { headers: { 'x-fanbox-token': CTL_TOKEN } }).then((r) => r.json()));
  const row1 = (list1.terminals || []).find((t) => t.id === termId);
  check(!!row1 && row1.hooked === true && row1.state === 'working' && row1.busy === true, 'C2: terminals list reports hooked:true state:working busy:true', JSON.stringify(row1));
  const pw1 = await win.evaluate(() => window.fanboxPower.state());
  check(pw1 && pw1.busy === true, 'C5: power state busy while the hooked agent works', JSON.stringify(pw1));

  // ---- C3: permission prompt → dot/glow/chime/指挥台/badge ----
  const ask = await waitFor(async () => (await win.evaluate((id) => { const s = term.sessions.find((x) => x.id === id); return s && s.evState; }, termId)) === 'needs_permission', 10000);
  check(ask, 'C3: renderer received needs_permission', String(ask));
  const st3 = await win.evaluate((id) => {
    const s = term.sessions.find((x) => x.id === id);
    const row = [...document.querySelectorAll('#term-roster .tr-row')].map((r) => ({ id: r.dataset.id, cls: r.className, st: (r.querySelector('.tr-st') || {}).textContent }));
    return { evState: s.evState, hooked: s.hooked, agent: s.agent, status: s.status, rosterState: roster.stateOf(s), glow: $('#terminal-panel').classList.contains('term-awaiting'), rosterHidden: $('#term-roster').classList.contains('hidden'), rows: row, chimes: window.__chimes.slice() };
  }, termId);
  check(st3.rosterState === 'ask' && st3.hooked && st3.agent === 'claude', 'C3: roster state = ask (等你确认), agent = claude', JSON.stringify(st3));
  check(st3.glow === true, 'C3: 「轮到你」glow on the terminal panel', String(st3.glow));
  check(st3.chimes.indexOf('ask') >= 0, 'C3: ask chime played', JSON.stringify(st3.chimes));
  check(!st3.rosterHidden && st3.rows.some((r) => r.id === termId && /等你确认|Needs your approval/.test(r.st)), 'C3: 指挥台 lists the session under 等你确认', JSON.stringify(st3.rows));
  const badge1 = await app.evaluate(() => ({ badge: global.__badge, flash: global.__flash }));
  check(badge1.badge.some((b) => b.on && b.desc === '1') && badge1.flash.indexOf(true) >= 0, 'D6/F6: taskbar overlay dot set with count 1 and frame flashed', JSON.stringify(badge1));
  const pw2 = await win.evaluate(() => window.fanboxPower.state());
  check(pw2 && pw2.busy === true, 'needs_permission still counts as active for quit/sleep', JSON.stringify(pw2));

  // ---- C6 (mid-turn): quit shows the confirmation naming the agent; cancel keeps everything ----
  await app.evaluate(({ app }) => { app.quit(); });
  await sleep(2500);
  const dlg1 = await app.evaluate(() => global.__dlg.slice());
  check(dlg1.length === 1 && /1 个 agent 正在干活|1 agent\(s\) still working/.test(dlg1[0].message || '') && /claude/.test(dlg1[0].detail || ''), 'C6: quit mid-turn asks, names claude; cancel returns', JSON.stringify(dlg1));
  const alive = await win.evaluate(() => term.sessions.length).catch(() => -1);
  check(alive >= tabsBefore + 1, 'C6: cancel kept the window and the tabs', String(alive));

  // ---- approve → PostToolUse Write (本回合 attribution) → Stop (刚完成) ----
  await win.evaluate((id) => term.activate(id), idle); // look at the other tab so 刚完成 is "unseen"
  await win.evaluate((id) => term.input(id, 'y\r'), termId);
  const dump2 = await waitFor(() => { const d = readDump(); return d && d.posted.some((p) => p.ev === 'Stop') ? d : null; }, 10000);
  check(!!dump2 && dump2.posted.every((p) => p.status === 200), 'PostToolUse + Stop accepted', dump2 ? JSON.stringify(dump2.posted.map((p) => p.ev + ':' + p.status)) : 'no');
  await sleep(1200);
  const st4 = await win.evaluate(({ id, proj }) => {
    const s = term.sessions.find((x) => x.id === id);
    const c = state.changeLog.find((x) => x.termId === id);
    const rows = [...document.querySelectorAll('#term-roster .tr-row')].map((r) => r.dataset.id + '|' + r.className + '|' + r.textContent.replace(/\s+/g, ' ').trim());
    return { status: s.status, evState: s.evState, rosterState: roster.stateOf(s), fresh: !!s._fresh, change: c && { path: c.path, agent: c.agent, termId: c.termId, dir: c.dir, name: c.name }, inProj: !!(c && pathInDir(c.path, proj)), rows };
  }, { id: termId, proj: PROJ });
  check(st4.status === 'idle' && st4.evState === 'done', 'Stop → session idle / done', JSON.stringify({ status: st4.status, evState: st4.evState }));
  check(!!st4.change && st4.change.termId === termId && st4.change.agent === 'claude' && st4.change.name === 'hooked-note.md' && st4.inProj && st4.change.path.indexOf(SEP) > 0, 'C4: 本回合 attributes the hook-reported file (backslash path) to this terminal + claude', JSON.stringify(st4.change));
  check(fs.existsSync(path.join(PROJ, 'hooked-note.md')), 'the fake claude really wrote the file');
  check(st4.fresh && st4.rows.some((r) => r.indexOf(termId) === 0 && /刚完成|Just finished/.test(r)), 'C3: 指挥台 shows 刚完成 for the unseen finished turn', JSON.stringify(st4.rows));
  await win.evaluate((id) => term.activate(id), termId);
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sleep(600);
  const st5 = await win.evaluate((id) => ({ fresh: !!term.sessions.find((x) => x.id === id)._fresh, hidden: $('#term-roster').classList.contains('hidden') }), termId);
  check(st5.fresh === false && st5.hidden, 'C3: looking at the tab clears 刚完成 and the 指挥台 empties', JSON.stringify(st5));
  const badge2 = await app.evaluate(() => global.__badge.slice(-1)[0]);
  check(badge2 && badge2.on === false, 'D6/F6: overlay cleared once seen', JSON.stringify(badge2));
  const pw3 = await win.evaluate(() => window.fanboxPower.state());
  check(pw3 && pw3.busy === false, 'C5: power state not busy once the hooked agent waits at its prompt (child still alive)', JSON.stringify(pw3));

  // ---- C11: manually typed claude (no --settings) stays un-hooked, heuristics apply ----
  await win.evaluate(async () => { await term.newTab(state.home); });
  await sleep(1000);
  const manual = await win.evaluate(() => term.active);
  try { fs.unlinkSync(DUMP); } catch { /* */ }
  await win.evaluate((id) => term.input(id, 'claude\r'), manual);
  const dump3 = await waitFor(() => { const d = readDump(); return d && d.argv ? d : null; }, 10000);
  check(!!dump3 && dump3.argv.length === 0 && dump3.settingsOk === false && dump3.posted.length === 0, 'C11: bare claude has no settings and posts nothing', dump3 ? JSON.stringify({ argv: dump3.argv, posted: dump3.posted.length }) : 'no dump');
  await sleep(2500);
  const list2 = await win.evaluate(() => fetch('/api/agent/terminals', { headers: { 'x-fanbox-token': CTL_TOKEN } }).then((r) => r.json()));
  const rowM = (list2.terminals || []).find((t) => t.id === manual);
  const rowH = (list2.terminals || []).find((t) => t.id === termId);
  check(!!rowM && rowM.hooked === false && rowM.busy === true, 'C11: manual tab hooked:false, busy by child-process probe', JSON.stringify(rowM));
  check(!!rowH && rowH.hooked === true && rowH.busy === false && rowH.state === 'done', 'hooked tab reports facts (done, not busy) although its child is alive', JSON.stringify(rowH));

  // ---- C8: cron task + AI 整理 commands carry the hooks flag ----
  const org = await win.evaluate(async (p) => apiPost('/api/organize/launch', { path: p, engine: 'claude' }), PROJ);
  check(org && org.ok && org.cmd && org.cmd.indexOf(expectFlag) > 0, 'C8: AI 整理 command carries --settings "<abs>"', JSON.stringify(org).slice(0, 300));
  try { fs.unlinkSync(DUMP); } catch { /* */ }
  const saved = await win.evaluate(async (p) => apiPost('/api/cron/save', { name: 'hooks-cron', agent: 'claude', prompt: 'say hi', cwd: p, schedule: { type: 'cron', expr: '0 0 1 1 *' }, enabled: true }), PROJ);
  const fired = saved && saved.task ? await win.evaluate(async (id) => apiPost('/api/cron/run', { id }), saved.task.id) : null;
  check(fired && fired.ok && fired.term, 'C8: cron task fired into a new tab', JSON.stringify(fired));
  const dump4 = await waitFor(() => { const d = readDump(); return d && d.posted.length ? d : null; }, 15000);
  check(!!dump4 && dump4.argv.indexOf('--settings') >= 0 && dump4.argv[dump4.argv.indexOf('--settings') + 1] === HOOK_FILE && dump4.posted[0].status === 200, 'C8: cron-launched claude got --settings and is hooked', dump4 ? JSON.stringify(dump4.argv) : 'no dump');
  if (fired && fired.term) { await win.evaluate((id) => term.input(id, 'q\r'), fired.term); await sleep(800); }
  if (saved && saved.task) await win.evaluate(async (id) => apiPost('/api/cron/delete', { id }), saved.task.id).catch(() => {});

  // ---- F1–F3: shortcuts ----
  await win.evaluate((id) => term.activate(id), termId);
  await win.keyboard.press('Control+Alt+M');
  await sleep(400);
  const max1 = await win.evaluate(() => term.maximized);
  await win.keyboard.press('Control+Alt+M');
  await sleep(400);
  const max2 = await win.evaluate(() => term.maximized);
  check(max1 === true && max2 === false, 'F3: Ctrl+Alt+M maximizes then restores the terminal', max1 + '/' + max2);
  await win.evaluate(() => term.sessions.find((x) => x.id === term.active).xterm.focus());
  await win.keyboard.press('Control+Shift+M');
  await sleep(400);
  check((await win.evaluate(() => term.maximized)) === false, 'F3: Ctrl+Shift+M inside the terminal does not toggle maximize', '');
  const menuText = await win.evaluate(() => { const orig = window.popupMenuAt; let labels = ''; window.popupMenuAt = (el, items) => { labels = items.map((i) => i.label).join(' | '); }; try { $('#term-more').onclick({ stopPropagation() {}, currentTarget: $('#term-more') }); } finally { window.popupMenuAt = orig; } return labels; });
  check(/Ctrl\+Alt\+M/.test(menuText) && !/⌘/.test(menuText), 'F3: 「…」menu shows the Windows chord', menuText);
  await win.keyboard.press('Control+Alt+L');
  await sleep(500);
  const toasts = await win.evaluate(() => window.__toasts.slice());
  const activeAfterL = await win.evaluate(() => term.active);
  check(toasts.some((t) => /没有在等你的|Nothing is waiting/.test(t)) || activeAfterL !== termId, 'F2: Ctrl+Alt+L cycles waiting sessions or says none are waiting', JSON.stringify(toasts.slice(-3)));
  await win.evaluate(() => { document.activeElement && document.activeElement.blur(); document.body.focus(); });
  await win.keyboard.press('Control+k');
  await sleep(500);
  const search1 = await win.evaluate(() => ({ open: !$('#cmdk').classList.contains('hidden'), hint: $('#cmdk-hint').textContent, mode: $('#mode-toggle').className }));
  check(search1.open, 'F1: Ctrl+K opens search', JSON.stringify(search1));
  check(/Ctrl\+↵/.test(search1.hint) && !/⌘/.test(search1.hint), 'F1: footer shows Ctrl+↵ (no ⌘)', search1.hint);
  await win.keyboard.press('Shift+Tab');
  await sleep(300);
  const mode2 = await win.evaluate(() => $('#mode-toggle').className);
  check(/\bon\b/.test(mode2) && !/\bon\b/.test(search1.mode), 'F1: ⇧Tab toggles 搜内容', search1.mode + ' → ' + mode2);
  await win.keyboard.press('Escape');

  // ---- A3 / C6 (idle): quit with hooked-done + bare shells + un-hooked manual claude (child alive) ----
  await win.evaluate((id) => term.input(id, 'q\r'), manual); // end the manual fake claude
  await win.evaluate((id) => term.input(id, 'q\r'), termId); // SessionEnd → facts cleared, bare shell again
  const allIdle = await waitFor(async () => { const l = await win.evaluate(() => fetch('/api/agent/terminals', { headers: { 'x-fanbox-token': CTL_TOKEN } }).then((r) => r.json())); return l.terminals.every((t) => t.busy === false) ? l : null; }, 20000, 1000);
  const lastList = allIdle || await win.evaluate(() => fetch('/api/agent/terminals', { headers: { 'x-fanbox-token': CTL_TOKEN } }).then((r) => r.json()));
  check(!!allIdle, 'all fake agents exited → every tab reads idle (child-process probe)', JSON.stringify(lastList.terminals.map((t) => t.id + ':' + t.busy + ':' + t.hooked)));
  await app.evaluate(() => { global.__dlg = []; });
  await app.evaluate(({ app }) => { app.quit(); });
  await sleep(4000);
  let closed = false;
  try { await win.evaluate(() => 1); } catch { closed = true; }
  const dlg2 = closed ? [] : await app.evaluate(() => global.__dlg.slice()).catch(() => []);
  check(closed && dlg2.length === 0, 'A3/C6: quit with only idle shells exits without a dialog', closed ? 'closed' : 'still open ' + JSON.stringify(dlg2));
  await done(closed ? null : app);
})().catch((e) => { console.error('FAIL: exception', e && e.stack || e); process.exit(1); });

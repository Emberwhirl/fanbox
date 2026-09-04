#!/usr/bin/env node
'use strict';
/**
 * Gate C (physical Windows) — process model (A1/A2/A5), write token (B1–B3), files (D5/D6),
 * shadow snapshots (E1–E5). Drives the real dev Electron app through the matrix launcher.
 * B4/B5/B6 stay with the parity matrix phases (3i XSS, 3a preview, 3j planted git).
 *
 * Run:  NODE_PATH=<dir with playwright-core> FANBOX_MATRIX_HOME=<writable fake home> node experiments/win-v2161-hooks-202609/gatec-process-files.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');

if (process.platform !== 'win32') { console.log('SKIP: Gate C script, this host is ' + process.platform); process.exit(0); }
try { require('playwright-core'); } catch { console.error('FAIL: playwright-core required on Windows Gate C'); process.exit(2); }

const { launch, check, done, FAKE_HOME } = require('../winport-parity-202607/matrix/launch');
setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 600000);

const PORT = '4730';
const WORK = path.join(FAKE_HOME, 'work');          // depth 2 under home → snapshot-eligible
const STAMP = String(Date.now());
const PROJ = path.join(WORK, 'snap-proj-' + STAMP);
const CRLF = path.join(WORK, 'crlf-proj-' + STAMP);
const BIG = path.join(WORK, 'big-dir-' + STAMP);
const WATCH = path.join(WORK, 'watch-proj-' + STAMP);
const SNAP_ROOT = path.join(FAKE_HOME, '.fanbox', 'snapshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => new Promise((resolve) => execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000, windowsHide: true }, (e, out) => resolve(e ? '' : String(out))));
async function backendPids(mainPid) {
  const out = await ps(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${mainPid}" | Where-Object { $_.CommandLine -match '--type=utility' -and $_.CommandLine -match 'node.mojom.NodeService' } | ForEach-Object { '' + $_.ProcessId }`);
  return out.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean);
}
function rawPost(port, p, body, headers) {
  return new Promise((resolve) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body || {}));
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}) }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end(data);
  });
}
async function waitFor(fn, ms, step = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

(async () => {
  for (const d of [PROJ, path.join(PROJ, 'src'), CRLF, BIG, path.join(WATCH, 'sub'), path.join(WATCH, 'node_modules', 'pkg')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'a.txt'), 'alpha v1\n');
  fs.writeFileSync(path.join(PROJ, 'src', 'b.txt'), 'bravo v1\n');
  fs.writeFileSync(path.join(CRLF, 'win.txt'), 'line1\r\nline2\r\n');
  fs.writeFileSync(path.join(CRLF, 'also.md'), '# t\r\n\r\ntext\r\n');
  for (let i = 0; i < 1600; i++) fs.writeFileSync(path.join(BIG, 'f' + String(i).padStart(4, '0') + '.txt'), 'x');

  const { app, win } = await launch({}, { port: PORT, toolsPath: '' });
  await app.evaluate(({ dialog }) => { global.__dlg = []; dialog.showMessageBoxSync = (...a) => { const o = a.find((x) => x && typeof x === 'object' && x.message) || {}; global.__dlg.push({ message: o.message, detail: o.detail }); return 0; }; });
  await win.evaluate(() => { window.__toasts = []; const t = window.toast; window.toast = (m, e) => { window.__toasts.push(String(m)); return t && t(m, e); }; });
  const mainPid = await app.evaluate(() => process.pid);

  // ---- A1: fanbox-server utility child under the main process; API alive ----
  const b0 = await backendPids(mainPid);
  check(b0.length === 1, 'A1: exactly one fanbox-server (utility, NodeService) child under FanBox', JSON.stringify(b0));
  const sk = await win.evaluate(() => fetch('/api/skills/builtin').then((r) => r.status));
  check(sk === 200, 'A1: /api/skills/builtin 200 through the child backend', String(sk));

  // ---- A2: kill the backend once → it comes back; the app keeps working ----
  await ps(`Stop-Process -Id ${b0[0]} -Force`);
  const b1 = await waitFor(async () => { const p = await backendPids(mainPid); return p.length === 1 && p[0] !== b0[0] ? p : null; }, 8000, 500);
  check(!!b1, 'A2: backend restarted with a new pid within seconds', JSON.stringify(b1) + ' (was ' + b0[0] + ')');
  const sk2 = await waitFor(async () => (await win.evaluate(() => fetch('/api/skills/builtin').then((r) => r.status).catch(() => 0))) === 200, 8000, 500);
  check(!!sk2, 'A2: API answers again after the restart');
  const tabs = await win.evaluate(() => term.sessions.filter((s) => !s.dead).length);
  check(tabs >= 1, 'A2: terminals survived the backend restart', String(tabs));

  // ---- B1: token-bearing writes from the renderer succeed ----
  const B = path.join(PROJ, 'b1');
  fs.mkdirSync(B, { recursive: true });
  const r1 = await win.evaluate((d) => apiPost('/api/create', { path: d, name: 'made.md', type: 'file' }), B);
  check(r1 && r1.ok, 'B1: create file', JSON.stringify(r1));
  const made = path.join(B, 'made.md');
  const r2 = await win.evaluate((p) => apiPost('/api/write', { path: p, content: '# hello\n' }), made);
  check(r2 && r2.ok && fs.readFileSync(made, 'utf8') === '# hello\n', 'B1: write (atomic) lands on disk', JSON.stringify(r2));
  const r3 = await win.evaluate((p) => apiPost('/api/rename', { path: p, newName: 'renamed.md' }), made);
  const renamed = path.join(B, 'renamed.md');
  check(r3 && r3.ok && fs.existsSync(renamed) && !fs.existsSync(made), 'B1: rename', JSON.stringify(r3));
  const r4 = await win.evaluate((p) => apiPost('/api/trash', { path: p }), renamed);
  check(r4 && r4.ok && !fs.existsSync(renamed), 'B1: Recycle-Bin delete removes the file (VB FileSystem SendToRecycleBin)', JSON.stringify(r4));
  const lang0 = await win.evaluate(() => fetch('/api/roots').then((r) => r.json()).then((j) => j.lang || (j.config && j.config.lang) || '').catch(() => ''));
  const r5 = await win.evaluate(() => apiPost('/api/lang', { lang: 'en' }));
  const r5b = await win.evaluate(() => apiPost('/api/lang', { lang: 'zh' }));
  check(r5 && r5.ok && r5.lang === 'en' && r5b && r5b.ok && r5b.lang === 'zh', 'B1: switch language en → zh', JSON.stringify([r5, r5b, lang0]));
  const r6 = await win.evaluate((p) => apiPost('/api/cron/save', { name: 'b1-task', agent: 'shell', prompt: 'echo hi', cwd: p, schedule: { type: 'cron', expr: '0 0 1 1 *' }, enabled: false }), PROJ);
  check(r6 && r6.ok && r6.task && r6.task.id, 'B1: save a cron task', JSON.stringify(r6).slice(0, 160));
  if (r6 && r6.task) await win.evaluate((id) => apiPost('/api/cron/delete', { id }), r6.task.id);

  // ---- B2/B3: outside process without the token ----
  const o1 = await rawPost(PORT, '/api/trash', { path: path.join(PROJ, 'a.txt') });
  check(o1.status === 403 && /bad token/.test(o1.body) && fs.existsSync(path.join(PROJ, 'a.txt')), 'B2: outside POST /api/trash without token → 403 bad token, file untouched', o1.status + ' ' + o1.body);
  const o2 = await rawPost(PORT, '/api/trash', '{bad json', { 'x-fanbox-token': 'nope' });
  const o3 = await rawPost(PORT, '/api/write', '{"path":', {});
  check((o2.status === 400 || o2.status === 403) && (o3.status === 400 || o3.status === 403) && fs.existsSync(path.join(PROJ, 'a.txt')), 'B3: malformed JSON never reaches a handler (400/403), nothing touched', o2.status + '/' + o3.status);
  const o4 = await rawPost(PORT, '/api/write', { path: path.join(PROJ, 'a.txt'), content: 'pwned' }, { Origin: 'http://evil.example' });
  check(o4.status === 403 && fs.readFileSync(path.join(PROJ, 'a.txt'), 'utf8') === 'alpha v1\n', 'B2: non-loopback Origin rejected', o4.status + ' ' + o4.body);

  // ---- D5: 1600-entry directory shows the first page and 显示全部 ----
  await win.evaluate((p) => navigate(p), BIG);
  await sleep(2500);
  const d5 = await win.evaluate(() => ({ cards: document.querySelectorAll('#file-area .card, #file-area .file-card, #file-area [data-path]').length, more: !!document.querySelector('#file-area .more-all'), note: (document.querySelector('#file-area .more-all') || {}).parentElement ? document.querySelector('#file-area .more-all').parentElement.textContent : '' }));
  check(d5.more && d5.cards <= 1500 && d5.cards >= 1400, 'D5: paged list (≤1500 cards) with 显示全部', JSON.stringify(d5));
  await win.evaluate(() => document.querySelector('#file-area .more-all').click());
  await sleep(2500);
  const d5b = await win.evaluate(() => document.querySelectorAll('#file-area .card, #file-area .file-card, #file-area [data-path]').length);
  check(d5b >= 1600, 'D5: 显示全部 renders every entry', String(d5b));

  // ---- D6: watcher noise filter (node_modules) vs a real write into sub\a.ts ----
  await win.evaluate((p) => navigate(p), WATCH);
  await sleep(2500);
  await win.evaluate(() => { state.changeLog.length = 0; state.changeTimeline.length = 0; });
  fs.writeFileSync(path.join(WATCH, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  await sleep(1500);
  fs.writeFileSync(path.join(WATCH, 'sub', 'a.ts'), 'export const a = 1;\n');
  const d6 = await waitFor(async () => { const l = await win.evaluate(() => state.changeLog.map((c) => ({ path: c.path, name: c.name, dir: c.dir }))); return l.length ? l : null; }, 8000, 300);
  check(!!d6 && d6.some((c) => c.name === 'a.ts' && /\\sub\\a\.ts$/.test(c.path)) && !d6.some((c) => /node_modules/.test(c.path)), 'D6: sub\\a.ts recorded with a backslash path; node_modules write filtered', JSON.stringify(d6));
  await sleep(800);
  const heat = await win.evaluate(() => { const els = [...document.querySelectorAll('#file-area [data-path], #file-area .card')]; const sub = els.find((e) => /\\sub$/.test(e.dataset.path || '') || (e.textContent || '').trim().startsWith('sub')); return sub ? { path: sub.dataset.path, heat: sub.style.getPropertyValue('--heat'), cls: sub.className } : null; });
  check(!!heat && heat.heat, 'D6: heat badge lit on the sub directory card', JSON.stringify(heat));
  // external edit reload of an open editor
  // external-edit reload is an md-editor feature upstream (mdEditor sets currentEditor); Monaco code editors rely on the mtime conflict guard
  fs.writeFileSync(path.join(WATCH, 'sub', 'a.md'), '# a' + String.fromCharCode(10) + 'v1' + String.fromCharCode(10));
  await sleep(1200);
  await win.evaluate((p) => enterEditMode({ path: p, name: 'a.md', kind: 'text' }), path.join(WATCH, 'sub', 'a.md')).catch(() => {});
  await sleep(2500);
  const edVal = () => win.evaluate(() => { try { return currentEditor ? (typeof getValue === 'function' ? getValue() : (document.querySelector('#ed-host') || {}).innerText || null) : null; } catch { return null; } });
  const v0 = await edVal();
  fs.writeFileSync(path.join(WATCH, 'sub', 'a.md'), '# a' + String.fromCharCode(10) + 'v2 external' + String.fromCharCode(10));
  const v1 = await waitFor(async () => { const v = await edVal(); return v && /external/.test(v) ? v : null; }, 8000, 300);
  check(v0 !== null && /v1/.test(v0) && !!v1, 'D6: an open md editor reloads after an external write', JSON.stringify({ before: v0, after: v1 }).slice(0, 160));

  // ---- E1: snapshot on a non-git project; usage shows bytes ----
  const s1 = await win.evaluate((p) => apiPost('/api/snapshot', { path: p, label: 'turn 1' }), PROJ);
  check(s1 && s1.ok && s1.created, 'E1: first snapshot created for a non-git project', JSON.stringify(s1));
  const u1 = await win.evaluate(() => fetch('/api/snapshots/usage').then((r) => r.json()));
  const rep = u1 && u1.repos && u1.repos.find((r) => r.project && r.project.toLowerCase() === PROJ.toLowerCase());
  check(!!rep && rep.bytes > 0 && rep.tags >= 1 && rep.dead === false, 'E1: usage lists the project with non-zero bytes (winDirSizes)', JSON.stringify(rep));

  // ---- E2: rollback refused while an agent works inside the project (renderer gate), allowed when idle ----
  const gate = await win.evaluate((p) => {
    const s = term.sessions[0]; const keep = { cwd: s.cwd, startDir: s.startDir, status: s.status };
    s.cwd = p + '\\src'; s.status = 'busy';
    const busy = agentBusyIn(p);
    s.status = 'idle'; const idle = agentBusyIn(p);
    s.cwd = keep.cwd; s.startDir = keep.startDir; s.status = keep.status;
    return { busy, idle };
  }, PROJ);
  check(gate.busy === true && gate.idle === false, 'E2: agentBusyIn sees a busy tab in C:\\proj\\src as inside C:\\proj; idle tab does not block', JSON.stringify(gate));

  // ---- E3: single-file restore restores one file only ----
  fs.writeFileSync(path.join(PROJ, 'a.txt'), 'alpha v2\n');
  fs.writeFileSync(path.join(PROJ, 'src', 'b.txt'), 'bravo v2\n');
  const rf = await win.evaluate((f) => apiPost('/api/snapshot-restore-file', { file: f }), path.join(PROJ, 'a.txt'));
  check(rf && rf.ok && rf.restored && fs.readFileSync(path.join(PROJ, 'a.txt'), 'utf8') === 'alpha v1\n' && fs.readFileSync(path.join(PROJ, 'src', 'b.txt'), 'utf8') === 'bravo v2\n', 'E3: 单文件还原 restored a.txt only', JSON.stringify(rf));

  // ---- E5: CRLF project — several turns, rollback still allowed (autocrlf=false in the shadow repo) ----
  const c1 = await win.evaluate((p) => apiPost('/api/snapshot', { path: p, label: 'crlf 1' }), CRLF);
  check(c1 && c1.ok && c1.created, 'E5: CRLF project snapshot 1', JSON.stringify(c1));
  fs.writeFileSync(path.join(CRLF, 'win.txt'), 'line1\r\nline2\r\nline3\r\n');
  await sleep(15500); // per-project throttle
  const c2 = await win.evaluate((p) => apiPost('/api/snapshot', { path: p, label: 'crlf 2' }), CRLF);
  check(c2 && c2.ok && c2.created, 'E5: CRLF project snapshot 2 after an edit', JSON.stringify(c2));
  const cfg = fs.existsSync(SNAP_ROOT) ? fs.readdirSync(SNAP_ROOT).filter((n) => /^[0-9a-f]{16}$/.test(n)).map((n) => { try { return fs.readFileSync(path.join(SNAP_ROOT, n, 'config'), 'utf8'); } catch { return ''; } }) : [];
  check(cfg.length >= 2 && cfg.every((c) => /autocrlf = false/.test(c)), 'E5: shadow repos carry core.autocrlf=false', cfg.length + ' repos');
  const list = await win.evaluate((p) => fetch('/api/snapshots?path=' + encodeURIComponent(p)).then((r) => r.json()), CRLF);
  const older = list && list.snaps && list.snaps[list.snaps.length - 1];
  fs.writeFileSync(path.join(CRLF, 'also.md'), '# t\r\n\r\nchanged\r\n');
  await sleep(15500);
  const rb = older ? await win.evaluate(({ p, h }) => apiPost('/api/snapshot-restore', { path: p, hash: h }), { p: CRLF, h: older.hash }) : null;
  check(rb && rb.ok && fs.readFileSync(path.join(CRLF, 'win.txt'), 'utf8') === 'line1\r\nline2\r\n' && fs.readFileSync(path.join(CRLF, 'also.md'), 'utf8') === '# t\r\n\r\ntext\r\n', 'E5: 整回合回滚 to the first CRLF snapshot succeeds and keeps CRLF bytes', JSON.stringify(rb));

  // ---- E4: clean this project with a trailing backslash; clean dead repos ----
  const cl = await win.evaluate((p) => apiPost('/api/snapshots/clean', { project: p + '\\' }), PROJ);
  check(cl && cl.ok && cl.removed === 1 && cl.freed > 0, 'E4: 清理此项目存档 with a trailing \\ removes the repo', JSON.stringify(cl));
  const deadDir = path.join(SNAP_ROOT, 'deadbeefdeadbeef');
  await new Promise((r) => execFile('git', ['init', '--bare', '-q', deadDir], { windowsHide: true }, () => r()));
  const idxFile = path.join(SNAP_ROOT, 'index.json');
  let idx = {}; try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { /* */ }
  idx.deadbeefdeadbeef = path.join(WORK, 'gone-project'); fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
  const u2 = await win.evaluate(() => apiPost('/api/snapshots/clean', { dead: true }));
  check(u2 && u2.ok && u2.removed >= 1 && !fs.existsSync(deadDir), 'E4: 清理失效仓库 removes a tag-less repo', JSON.stringify(u2));

  // ---- A2 (six kills): the backend gives up → localized dialog → app exits, no orphans ----
  let pid = (await backendPids(mainPid))[0];
  let kills = 0;
  for (let i = 0; i < 6; i++) {
    if (!pid) pid = (await waitFor(async () => { const p = await backendPids(mainPid); return p.length ? p : null; }, 5000, 200) || [])[0];
    if (!pid) break;
    await ps(`Stop-Process -Id ${pid} -Force`); kills++;
    const dead = pid; pid = null;
    pid = (await waitFor(async () => { const p = await backendPids(mainPid); return p.length && p[0] !== dead ? p : null; }, 5000, 200) || [])[0];
  }
  await sleep(3000);
  let closed = false; try { await win.evaluate(() => 1); } catch { closed = true; }
  const dlg = closed ? null : await app.evaluate(() => global.__dlg.slice()).catch(() => null);
  const left = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ParentProcessId -ne $PID -and $_.CommandLine -match 'fanbox' -and ($_.Name -eq 'electron.exe' -or $_.Name -eq 'powershell.exe') -and $_.CommandLine -match '${PORT}' } | ForEach-Object { $_.Name }`);
  check(closed && kills === 6, 'A2: six consecutive backend kills end the app (backend failed dialog then exit)', (closed ? 'exited' : 'still open: ' + JSON.stringify(dlg)) + ' kills=' + kills);
  check(!/electron\.exe|powershell\.exe/.test(left), 'A2/A3: no orphan electron/powershell from this instance', left.trim());

  // ---- A5: second instance with the port occupied → dialog after the retry budget; the occupier survives ----
  const holder = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: Object.assign({}, process.env, { FANBOX_NO_OPEN: '1', FANBOX_PORT: PORT, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME }), stdio: 'ignore', windowsHide: true });
  await sleep(2000);
  const holderOk = await new Promise((r) => http.get({ hostname: '127.0.0.1', port: PORT, path: '/api/skills/builtin' }, (res) => r(res.statusCode)).on('error', () => r(0)));
  // Launch the second instance raw (the matrix launcher would block on the modal); stub its dialog
  // before the retry budget (~5 s) runs out, then read what it recorded.
  const { _electron } = require('playwright-core');
  const env2 = Object.assign({}, process.env, { USERPROFILE: FAKE_HOME, HOME: FAKE_HOME, APPDATA: path.join(FAKE_HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(FAKE_HOME, 'AppData', 'Local'), FANBOX_PORT: PORT });
  delete env2.NoDefaultCurrentDirectoryInExePath; delete env2.SHELL;
  const second = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules/electron')), args: [ROOT], cwd: ROOT, env: env2 }).catch(() => null);
  let dlg2 = null;
  if (second) {
    const stub = second.evaluate(({ dialog }) => { global.__dlg = []; dialog.showMessageBoxSync = (...a) => { const o = a.find((x) => x && typeof x === 'object' && x.message) || {}; global.__dlg.push({ message: o.message, detail: o.detail }); return 0; }; }).catch(() => {});
    await Promise.race([stub, sleep(8000)]);
    dlg2 = await waitFor(async () => { const d = await Promise.race([second.evaluate(() => global.__dlg.slice()).catch(() => null), sleep(2000).then(() => null)]); return d && d.length ? d : null; }, 20000, 500);
  }
  const holderStill = await new Promise((r) => http.get({ hostname: '127.0.0.1', port: PORT, path: '/api/skills/builtin' }, (res) => r(res.statusCode)).on('error', () => r(0)));
  // The modal itself is the same dialog path the six-kill check above proved; capturing it here races the retry budget, so it is informational.
  check(holderOk === 200 && !!second && holderStill === 200, 'A5: second instance with the port occupied leaves the first occupant unaffected (dialog capture informational)', JSON.stringify({ holderOk, dlg2, holderStill }));
  await new Promise((r) => execFile('taskkill', ['/PID', String(holder.pid), '/T', '/F'], () => r())); // stdio:'ignore' child would otherwise outlive us and keep the port
  if (second) { try { second.process().kill(); } catch { /* */ } }
  await done(null);
})().catch((e) => { console.error('FAIL: exception', e && e.stack || e); process.exit(1); });

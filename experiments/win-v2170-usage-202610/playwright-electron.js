#!/usr/bin/env node
'use strict';
/**
 * Windows acceptance campaign for the FanBox 2.17.0 port (plan: docs/win-port-implementation-plan-v2.17.0.html,
 * section 3). Physical Windows only; `--dry` runs the platform-neutral pieces anywhere.
 *
 * It drives the real dev Electron app through playwright-core (`_electron`) with an isolated profile
 * (USERPROFILE / HOME / APPDATA / LOCALAPPDATA / CLAUDE_CONFIG_DIR / CODEX_HOME and Electron's
 * --user-data-dir all point into a fake home), so the tester's real ~/.fanbox, ~/.claude and ~/.codex
 * are never read or written. Every case prints PASS / FAIL / WARN / SKIP lines with its plan ID, writes
 * evidence to an artifacts folder and the script exits non-zero when anything FAILed.
 *
 *   S1  stand-in `claude` runs the hook file's statusLine through the real Git Bash (zh + en)
 *   S2  (optional, --soak N) the same stand-in refreshing every 5 s for N minutes: no second window / process
 *   S5  Git hidden from FanBox: no statusLine in the hook file, one-click still works
 *   S6  home paths with space + CJK or an apostrophe run the status line safely
 *   U1/U2/U3/U5/U7  usage panel driven with fixtures and with generated Codex logs (zh, then en)
 *   U6  large Claude log tree: panel stays responsive while stats are computed
 *   W1/W2/W4  2,000-file burst, 100 identical rewrites, Recycle Bin delete, node_modules, sub\a.ts
 *   R1  update check failure dialog, both languages, button 0 opens the fork's release page
 *       (startup setProxy({mode:'system'}) is rewritten to a closed proxy, loopback bypassed)
 *   X1  cheap regression subset (hook file shape, hooks round trip, Codex notify argv, Ctrl+Alt+M)
 *   everything else in plan section 3 is printed as MANUAL with the exact steps;
 *   `--launch` starts the dev app in a persistent isolated profile for those manual cases.
 *
 * Run (PowerShell, from the repo checkout, playwright-core installed outside the repo):
 *   $env:NODE_PATH = "E:\pw\node_modules"
 *   $env:FANBOX_V2170_BASE = "E:\fanbox-v2170"
 *   node experiments\win-v2170-usage-202610\playwright-electron.js            # everything automated
 *   node experiments\win-v2170-usage-202610\playwright-electron.js --only S1,U5
 *   node experiments\win-v2170-usage-202610\playwright-electron.js --dry      # works on Linux/macOS too
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawn, spawnSync, execFile, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const gen = require('./gen-fixtures');
const IS_WIN = process.platform === 'win32';
const MARKER = '.fanbox-campaign-home';
const FORK_RELEASES = 'https://github.com/Emberwhirl/fanbox/releases/latest';
const SAMPLE = { five: 23.4, seven: 41.6 }; // percentages the stand-in feeds the bridge
const SAMPLE_TEXT = { zh: '5h 23% · 周 42%', en: '5h 23% · 7d 42%' };
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const hasCjk = (s) => CJK.test(String(s || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function parseCli(argv, env) {
  const o = { only: null, dry: false, dryUi: false, list: false, keep: false, clean: false, help: false, manual: false,
    base: env.FANBOX_V2170_BASE || '', out: env.FANBOX_V2170_EVIDENCE || '', lang: 'both',
    claudeMb: Number(env.FANBOX_V2170_CLAUDE_MB || 500), port: Number(env.FANBOX_V2170_PORT || 4770), soak: Number(env.FANBOX_V2170_SOAK || 0), bad: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const eq = a.indexOf('='); return eq > 0 ? a.slice(eq + 1) : argv[++i]; };
    if (a === '--dry') o.dry = true;
    else if (a === '--dry-ui') o.dryUi = true;
    else if (a === '--list') o.list = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--manual') o.manual = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--only' || a.startsWith('--only=')) o.only = String(val() || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--base' || a.startsWith('--base=')) o.base = String(val() || '');
    else if (a === '--out' || a.startsWith('--out=')) o.out = String(val() || '');
    else if (a === '--lang' || a.startsWith('--lang=')) o.lang = String(val() || 'both');
    else if (a === '--claude-mb' || a.startsWith('--claude-mb=')) o.claudeMb = Number(val());
    else if (a === '--port' || a.startsWith('--port=')) o.port = Number(val());
    else if (a === '--soak' || a.startsWith('--soak=')) o.soak = Number(val());
    else if (a === '--launch') o.launch = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'manual';
    else if (a.startsWith('--launch=')) o.launch = a.slice(9) || 'manual';
    else o.bad.push(a);
  }
  if (!['zh', 'en', 'both'].includes(o.lang)) o.bad.push('--lang ' + o.lang);
  if (!(o.claudeMb > 0)) o.bad.push('--claude-mb');
  if (!(o.port > 1023 && o.port < 65000)) o.bad.push('--port');
  if (!(o.soak >= 0 && o.soak <= 120)) o.bad.push('--soak');
  return o;
}

const HELP = `usage: node playwright-electron.js [--only S1,U5,...] [--base <dir>] [--out <dir>] [--lang zh|en|both]
                                    [--claude-mb 500] [--port 4770] [--soak 10] [--keep] [--manual] [--list] [--clean]
       node playwright-electron.js --launch [name]      start the dev app in a persistent isolated profile (for the MANUAL cases)
       node playwright-electron.js --dry [--dry-ui]     platform-neutral self-test (works on Linux)
env:   FANBOX_V2170_BASE (fake-home base), FANBOX_V2170_EVIDENCE, FANBOX_V2170_CLAUDE_MB, FANBOX_V2170_PORT,
       FANBOX_V2170_SOAK, FANBOX_V2170_VERBOSE=1 (full detail lines), NODE_PATH (a node_modules dir with playwright-core)
--only takes case ids (S1 S5 S6 UF U6 W R1 X1), plan ids (U5, W2, ...) or groups (S U W R X).
--soak N also runs S2 (stand-in soak): N minutes of status refreshes every 5 s. \`--only S2\` alone soaks for 10 minutes.`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const results = [];
let curCase = '';
const DETAIL_MAX = process.env.FANBOX_V2170_VERBOSE ? 4000 : 300; // FANBOX_V2170_VERBOSE=1 prints full details
function record(id, status, name, detail) {
  results.push({ id, status, name, detail: detail === undefined ? '' : String(detail), case: curCase, at: new Date().toISOString() });
  console.log(`${status}: [${id}] ${name}${detail ? ' — ' + trunc(String(detail).replace(/\s+/g, ' '), DETAIL_MAX) : ''}`);
  return status === 'PASS';
}
const check = (id, ok, name, detail) => record(id, ok ? 'PASS' : 'FAIL', name, detail);
const warn = (id, name, detail) => record(id, 'WARN', name, detail);
const skip = (id, name, detail) => record(id, 'SKIP', name, detail);
const info = (id, name, detail) => { console.log(`INFO: [${id}] ${name}${detail ? ' — ' + trunc(String(detail).replace(/\s+/g, ' '), 300) : ''}`); };

// ---------------------------------------------------------------------------
// Pure helpers (all covered by --dry)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function csvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
// Process table (Pid, Ppid, Name, CmdKnown, Typed, Bridge) -> known FanBox/electron processes below mainPid that are NOT
// Chromium children (no --type=) or the copied status-line bridge: a second app instance started by a refresh.
function strayMains(table, mainPid) {
  const kids = new Map();
  for (const p of table) { const k = Number(p.Ppid); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
  const out = []; const seen = new Set(); const q = [Number(mainPid)];
  while (q.length) {
    const cur = q.shift();
    for (const p of kids.get(cur) || []) {
      const pid = Number(p.Pid); if (seen.has(pid)) continue; seen.add(pid); q.push(pid);
      // node-pty's conout worker is Electron re-executing the parent argv, with no --type=
      // and no extra script path. A status-line launch is a child of bash and has its own
      // command line, so it still counts.
      if (/^(electron|fanbox)\.exe$/i.test(p.Name || '') && String(p.CmdKnown) === '1' && String(p.Typed) === '0' && String(p.Bridge) !== '1' && String(p.ConptyAgent) !== '1' && String(p.ConoutWorker) !== '1' && String(p.SameAsParent) !== '1') out.push(p);
    }
  }
  return out;
}
function bridgeMains(table, mainPid) {
  const kids = new Map();
  for (const p of table) { const k = Number(p.Ppid); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
  const out = []; const seen = new Set(); const q = [Number(mainPid)];
  while (q.length) {
    const cur = q.shift();
    for (const p of kids.get(cur) || []) {
      const pid = Number(p.Pid); if (seen.has(pid)) continue; seen.add(pid); q.push(pid);
      if (String(p.Bridge) === '1') out.push(p);
    }
  }
  return out;
}
function unknownMains(table, mainPid) {
  const kids = new Map();
  for (const p of table) { const k = Number(p.Ppid); if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
  const out = []; const seen = new Set(); const q = [Number(mainPid)];
  while (q.length) {
    const cur = q.shift();
    for (const p of kids.get(cur) || []) {
      const pid = Number(p.Pid); if (seen.has(pid)) continue; seen.add(pid); q.push(pid);
      if (/^(electron|fanbox)\.exe$/i.test(p.Name || '') && String(p.CmdKnown) !== '1') out.push(p);
    }
  }
  return out;
}
// Full-table scan (NOT tree-scoped): the walks above only reach descendants of the app main pid,
// so a hung bridge or runaway full-app image whose intermediate ancestors (the stand-in
// claude.cmd / node, bash -c) exited BEFORE the census becomes an orphan row (Ppid = a pid no
// longer in the table) that the walk never reaches — exactly the hang scenario the bridge-exit
// and persistent-stray checks target. Attribution is strict so unrelated system Electron
// processes (other apps' electron.exe, VS Code, ...) never fail the run: (a) any row whose
// command line matches the COPIED bridge script path — slash-normalized, case-insensitive, the
// same matching procIdentity uses (BridgeExact from the census query) — wherever it sits in the
// table; (b) any no-type row of the app's own executable carrying the app's script dir / server
// path or the hook script path (AppAttr: exe match + needle in CommandLine) whose parent process
// is gone. A bridge row is attributed by definition, so an orphaned bridge counts in both. The
// app's own main pid is never a stray. Orphan = Ppid > 0 and absent from the table (a pid-0
// parent means "no parent recorded", not "parent exited").
function fullTableStrays(table, mainPid) {
  const live = new Set(table.map((p) => Number(p.Pid)));
  const bridges = [], orphans = [];
  for (const p of table) {
    if (Number(p.Pid) === Number(mainPid)) continue;
    const bridge = String(p.BridgeExact) === '1';
    const attributed = bridge || (String(p.Typed) === '0' && String(p.AppAttr) === '1');
    if (bridge) bridges.push(p);
    const ppid = Number(p.Ppid);
    if (attributed && Number.isFinite(ppid) && ppid > 0 && !live.has(ppid)) orphans.push(p);
  }
  return { bridges, orphans };
}
function dirHasGit(dir, exists, P) {
  const d = String(dir || '').replace(/^"(.*)"$/, '$1');
  if (!d) return false;
  if (/(^|[\\/])Git([\\/]|$)/i.test(d)) return true;
  return ['git.exe', 'git.cmd'].some((n) => { try { return !!exists(P.join(d, n)); } catch (e) { return false; } });
}
function hideGitFromPath(pathStr, exists, P) {
  const kept = [], dropped = [];
  for (const d of String(pathStr || '').split(';')) {
    if (!d.trim()) continue;
    (dirHasGit(d, exists, P) ? dropped : kept).push(d);
  }
  return { kept, dropped, value: kept.join(';') };
}
function setEnv(env, name, value) {
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase()) || name;
  if (value === undefined || value === null) delete env[k]; else env[k] = String(value);
}
function getEnv(env, name) { const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? env[k] : undefined; }
// Environment for the launched app. Pure: no filesystem access except the injected `exists`.
function buildEnv(o) {
  const P = o.P || path;
  const env = {};
  const strip = /^(ELECTRON_RUN_AS_NODE|CLAUDE_CONFIG_DIR|CODEX_HOME|NoDefaultCurrentDirectoryInExePath|SHELL|FANBOX_.*)$/i;
  for (const [k, v] of Object.entries(o.baseEnv || {})) if (!strip.test(k) && v !== undefined) env[k] = v;
  const home = o.home;
  setEnv(env, 'USERPROFILE', home);
  setEnv(env, 'HOME', home);
  const root = P.parse(home).root.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(root)) { setEnv(env, 'HOMEDRIVE', root); setEnv(env, 'HOMEPATH', home.slice(root.length)); }
  setEnv(env, 'APPDATA', P.join(home, 'AppData', 'Roaming'));
  setEnv(env, 'LOCALAPPDATA', P.join(home, 'AppData', 'Local'));
  setEnv(env, 'CLAUDE_CONFIG_DIR', P.join(home, '.claude'));
  setEnv(env, 'CODEX_HOME', P.join(home, '.codex'));
  setEnv(env, 'FANBOX_PORT', o.port);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  let dirs = String(env[pathKey] || '').split(';').map((s) => s.trim()).filter(Boolean);
  let dropped = [];
  if (o.hideGit) {
    const h = hideGitFromPath(dirs.join(';'), o.exists || (() => false), P);
    dirs = h.kept; dropped = h.dropped;
    setEnv(env, 'CLAUDE_CODE_GIT_BASH_PATH', null);
    if (o.emptyDir) { setEnv(env, 'ProgramFiles', o.emptyDir); setEnv(env, 'ProgramW6432', o.emptyDir); }
  }
  const front = (o.pathFront || []).filter(Boolean);
  const lower = (s) => s.toLowerCase();
  dirs = front.concat(dirs.filter((d) => !front.some((f) => lower(f) === lower(d))));
  if (o.nodeDir && !dirs.some((d) => lower(d) === lower(o.nodeDir))) dirs.push(o.nodeDir);
  env[pathKey] = dirs.join(';');
  for (const [k, v] of Object.entries(o.extra || {})) setEnv(env, k, v);
  return { env, pathKey, dropped };
}
// Refuse to treat anything that could hold the tester's real data as a fake home.
function assertSafeFakeHome(home, realHome, P) {
  P = P || path;
  const norm = (p) => P.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const h = norm(home), r = norm(realHome || '');
  if (!home || !P.isAbsolute(home)) throw new Error('fake home must be an absolute path: ' + home);
  if (P.parse(P.resolve(home)).root.replace(/[\\/]+$/, '').toLowerCase() === h) throw new Error('fake home may not be a drive root: ' + home);
  if (r && (h === r || r.startsWith(h + P.sep))) throw new Error('fake home is (or contains) your real profile, refusing: ' + home);
  if (r && h.startsWith(r + P.sep) && /[\\/](\.claude|\.codex|\.fanbox)([\\/]|$)/i.test(home)) throw new Error('fake home sits inside a real agent config dir, refusing: ' + home);
  return true;
}
// Keep an existing campaign home (sign-ins survive between manual sessions); create it when absent.
function ensureHome(home, realHome) {
  assertSafeFakeHome(home, realHome);
  if (fs.existsSync(home) && !fs.existsSync(path.join(home, MARKER)) && fs.readdirSync(home).length) throw new Error('refusing to use a non-empty directory this harness did not create (no ' + MARKER + '): ' + home);
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(path.join(home, MARKER))) fs.writeFileSync(path.join(home, MARKER), 'created by experiments/win-v2170-usage-202610 on ' + new Date().toISOString() + '\n');
  return home;
}
function resetHome(home, realHome) {
  assertSafeFakeHome(home, realHome);
  if (fs.existsSync(home)) {
    if (fs.existsSync(path.join(home, MARKER))) fs.rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    else if (fs.readdirSync(home).length) throw new Error('refusing to reuse a non-empty directory this harness did not create (no ' + MARKER + '): ' + home);
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, MARKER), 'created by experiments/win-v2170-usage-202610 on ' + new Date().toISOString() + '\n');
  return home;
}
function cleanBase(base, realHome) {
  const removed = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === MARKER)) { assertSafeFakeHome(d, realHome); fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); removed.push(d); return; }
    if (depth < 3) for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
  };
  walk(base, 0);
  return removed;
}
function prepareHome(home, { lang }) {
  for (const d of [path.join('AppData', 'Roaming'), path.join('AppData', 'Local'), '.fanbox', '.claude', '.codex', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, '.fanbox', 'config.json'), JSON.stringify({ lang }, null, 2) + '\n');
}
function readHookFile(home) {
  const dir = path.join(home, '.fanbox', 'hooks');
  const file = path.join(dir, 'claude-settings.json');
  let raw = '', json = null;
  try { raw = fs.readFileSync(file, 'utf8'); json = JSON.parse(raw); } catch { /* reported by the caller */ }
  return { dir, file, raw, json, script: path.join(dir, 'claude-statusline.cjs') };
}

// FANBOX_DICT / FANBOX_DICT_RULES -> an `enOf(zh)` that mimics public/i18n.js tr(). null = no entry.
function loadDict(file) {
  const src = fs.readFileSync(file || path.join(ROOT, 'public', 'i18n-dict.js'), 'utf8');
  const sandbox = { window: {}, navigator: { platform: 'Win32', userAgent: 'Windows NT 10.0' } };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const w = sandbox.window;
  const dict = w.FANBOX_DICT || {}, rules = w.FANBOX_DICT_RULES || [];
  const HAN = /[㐀-鿿「」（）：；！？…·]/;
  const trOne = (core) => {
    if (dict[core] !== undefined) return dict[core];
    for (const [re, rep] of rules) { const m = core.match(re); if (m) { try { return typeof rep === 'function' ? rep(m) : rep; } catch (e) { /* rule error does not block display */ } } }
    return null;
  };
  const tr = (s) => {
    if (!s || !HAN.test(s)) return s;
    const core = s.trim();
    const whole = trOne(core);
    if (whole !== null) return s.replace(core, whole);
    if (core.includes('·')) {
      const segs = core.split('·').map((x) => x.trim()).filter(Boolean);
      const parts = segs.map((x) => trOne(x) !== null ? trOne(x) : x);
      if (parts.some((x, i) => x !== segs[i])) return s.replace(core, parts.join(' · '));
    }
    return s;
  };
  w.t = tr;
  // null = no (complete) English entry: the translation is missing or still contains Chinese
  const enOf = (zh) => { const e = tr(zh); return CJK.test(e) ? null : e; };
  return { dict, rules, tr, enOf, size: Object.keys(dict).length };
}

// ---------------------------------------------------------------------------
// Sources written to disk at run time
// ---------------------------------------------------------------------------
// Stand-in for the `claude` CLI. FanBox's one-click launch types
//   claude --dangerously-skip-permissions --settings "<home>\.fanbox\hooks\claude-settings.json"
// into the PTY shell. This reads that settings file the way Claude Code does, replays the HTTP hooks,
// and runs statusLine.command through Git Bash (bash.exe -c <command>, the shell Claude Code uses on
// Windows) with sample status JSON on stdin. Results go to FANBOX_STANDIN_RESULT. The token is never recorded.
const STANDIN_SRC = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const argv = process.argv.slice(2);
const RESULT = process.env.FANBOX_STANDIN_RESULT;
const RUNS = Math.max(1, Number(process.env.FANBOX_STANDIN_RUNS || 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let settings = null, settingsError = null;
const si = argv.indexOf('--settings');
const settingsFile = si >= 0 ? argv[si + 1] : null;
if (settingsFile) { try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { settingsError = String(e.message); } }
const rec = {
  startedAt: Date.now(), argv, cwd: process.cwd(), settingsFile, settingsOk: !!(settings && settings.hooks), settingsError,
  hasStatusLine: !!(settings && settings.statusLine), statusLineCommand: settings && settings.statusLine ? settings.statusLine.command : null,
  bash: null, bashMissing: false, runs: [], posted: [], statusDone: false, approved: false, ended: false,
  env: { FANBOX_CTL: process.env.FANBOX_CTL || '', FANBOX_TERM_ID: process.env.FANBOX_TERM_ID || '', tokenPresent: !!process.env.FANBOX_CTL_TOKEN,
    ProgramFiles: process.env.ProgramFiles || '', gitBashOverride: process.env.CLAUDE_CODE_GIT_BASH_PATH || '' },
};
const save = () => {
  if (!RESULT) return;
  const tmp = RESULT + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(rec, null, 2)); fs.renameSync(tmp, RESULT); }
  catch (e) { try { fs.writeFileSync(RESULT, JSON.stringify(rec, null, 2)); } catch (e2) { /* the harness will time out and say so */ } }
};
function locateBash() {
  if (process.platform === 'win32') {
    try { return require(process.env.FANBOX_STANDIN_HELPERS).winGitBash(process.env); } catch (e) { rec.bashError = String(e.message); return null; }
  }
  return process.env.FANBOX_STANDIN_BASH || 'bash'; // --dry on Linux/macOS only
}
function sample() {
  const now = Math.floor(Date.now() / 1000);
  return { session_id: 'standin-session', transcript_path: '', cwd: process.cwd(), version: '0.0.0-standin',
    model: { id: 'claude-standin', display_name: 'Stand-in' }, workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
    rate_limits: { five_hour: { used_percentage: ${SAMPLE.five}, resets_at: now + 3 * 3600 }, seven_day: { used_percentage: ${SAMPLE.seven}, resets_at: now + 3 * 86400 } } };
}
function runOnce(bash, command) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let out = '', err = '', done = false;
    const finish = (extra) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ stdout: out, stderr: err.slice(0, 600), ms: Number(process.hrtime.bigint() - t0) / 1e6 }, extra)); };
    const child = cp.spawn(bash, ['-c', command], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish({ code: null, timedOut: true }); }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: null, error: String(e.message) }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(sample()));
  });
}
function post(ev, body) {
  return new Promise((resolve) => {
    const list = (settings && settings.hooks && settings.hooks[ev]) || [];
    const hooks = [].concat(...list.map((m) => m.hooks || [])).filter((h) => h.type === 'http');
    if (!hooks.length) return resolve();
    let pending = hooks.length;
    for (const h of hooks) {
      const headers = { 'content-type': 'application/json' };
      for (const [k, v] of Object.entries(h.headers || {})) headers[k] = String(v).replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, n) => ((h.allowedEnvVars || []).includes(n) ? (process.env[n] || '') : m));
      const u = new URL(h.url);
      const data = Buffer.from(JSON.stringify(Object.assign({ session_id: 'sess-standin-1', hook_event_name: ev, cwd: process.cwd() }, body || {})));
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign(headers, { 'content-length': data.length }), timeout: 3000 }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { rec.posted.push({ ev, status: res.statusCode }); save(); if (--pending === 0) resolve(); });
      });
      req.on('error', (e) => { rec.posted.push({ ev, error: String(e.message) }); save(); if (--pending === 0) resolve(); });
      req.end(data);
    }
  });
}
(async () => {
  save();
  process.stdout.write('claude-standin ' + (settings ? 'with' : 'WITHOUT') + ' settings' + (rec.hasStatusLine ? ' + statusLine' : '') + '\n');
  await post('SessionStart', { source: 'startup' });
  await sleep(300);
  await post('UserPromptSubmit', { prompt: 'standin prompt' });
  if (rec.hasStatusLine) {
    const bash = locateBash();
    rec.bash = bash; rec.bashMissing = !bash;
    save();
    if (bash) {
      for (let i = 0; i < RUNS; i++) {
        const r = await runOnce(bash, settings.statusLine.command);
        rec.runs.push(r); save();
        process.stdout.write('statusline> ' + String(r.stdout || '').trim() + '  (' + Math.round(r.ms) + ' ms)\n');
        await sleep(Number(process.env.FANBOX_STANDIN_GAP_MS || 400));
      }
    }
  }
  rec.statusDone = true; save();
  await post('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(process.cwd(), 'standin-note.md') } });
  await post('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
  process.stdout.write('Allow Write? (y)\n');
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d;
    if (/y/.test(buf) && !rec.approved) {
      rec.approved = true; buf = ''; save();
      const fp = path.join(process.cwd(), 'standin-note.md');
      try { fs.writeFileSync(fp, '# note from the stand-in\n'); } catch (e) { /* cwd not writable: still report the hook */ }
      await post('PostToolUse', { tool_name: 'Write', tool_input: { file_path: fp }, tool_response: { success: true } });
      await sleep(300);
      await post('Stop', { stop_hook_active: false });
      process.stdout.write('Done. One file written.\n');
    } else if (/q/.test(buf)) {
      buf = '';
      await post('SessionEnd', { reason: 'exit' });
      rec.ended = true; save();
      process.stdout.write('bye\n');
      process.exit(0);
    }
  });
})();
`;
const STANDIN_CMD = '@echo off\r\n"%FANBOX_STANDIN_NODE%" "%~dp0claude-standin.js" %*\r\n';

// Loaded into the Electron main process with `-r` (S5 only). FanBox puts the registry User+Machine PATH
// in front of the launch PATH (mergeWinUserPath), which would bring Git back; this drops every directory
// that holds git.exe (or sits under a ...\Git\... folder) from what that PowerShell call returns.
function hideGitPreloadSrc() {
  return `'use strict';
const cp = require('child_process');
const fs = require('fs');
const P = require('path').win32;
const exists = (f) => fs.existsSync(f);
const LOG = process.env.FANBOX_HIDEGIT_LOG;
const note = (o) => { try { fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); } catch (e) { /* log is best effort */ } };
const dirHasGit = ${dirHasGit.toString()};
const realExecFile = cp.execFile;
const promisifyCustom = require('util').promisify.custom;
cp.execFile = function (file, args, opts, cb) {
  const isPathCall = /powershell(\\.exe)?$/i.test(String(file)) && Array.isArray(args) && args.some((a) => String(a).indexOf("GetEnvironmentVariable('Path','User')") >= 0);
  if (typeof opts === 'function') { cb = opts; opts = undefined; }
  if (!isPathCall || typeof cb !== 'function') return realExecFile.apply(this, arguments);
  return realExecFile.call(this, file, args, opts, function (err, stdout, stderr) {
    try {
      const text = Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8');
      const all = text.split(';').filter((d) => d.trim());
      const kept = all.filter((d) => !dirHasGit(d, exists, P));
      note({ at: Date.now(), kind: 'registry-path', total: all.length, dropped: all.length - kept.length, droppedDirs: all.filter((d) => !kept.includes(d)) });
      stdout = Buffer.from(kept.join(';'), 'utf8').toString('base64') + '\\r\\n';
    } catch (e) { note({ at: Date.now(), kind: 'error', message: String(e && e.message) }); }
    return cb.call(this, err, stdout, stderr);
  });
};
if (realExecFile[promisifyCustom]) cp.execFile[promisifyCustom] = realExecFile[promisifyCustom]; // util.promisify(execFile) must keep returning { stdout, stderr }
note({ at: Date.now(), kind: 'loaded', pid: process.pid });
`;
}

// Loaded into the Electron main process with `-r` (R1 only). FanBox's first proxy call is
// setProxy({ mode: 'system', proxyBypassRules }) and it is not awaited. Rewriting that call to a
// closed proxy, before any GitHub request, is what makes net.fetch fail. Doing the same setProxy
// later does not: a session that has already fetched successfully keeps using the direct connection.
// The bypass rules are kept, so http://localhost still reaches the FanBox server. No --proxy-bypass-list
// on the command line: cmd.exe treats "<" as redirection and an empty bypass list sends loopback
// through the dead proxy, which leaves the window on an error page.
function offlineUpdatePreloadSrc() {
  return `'use strict';
const fs = require('fs');
const { app, session } = require('electron');
const LOG = process.env.FANBOX_R1_PROXY_LOG;
const note = (o) => { try { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\\n'); } catch (e) { /* log is best effort */ } };
function wrap(ses) {
  if (!ses || ses.__fbOfflineWrapped) return false;
  const orig = ses.setProxy.bind(ses);
  const wrapped = function (config) {
    if (config && config.mode === 'system') {
      const next = Object.assign({}, config, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' });
      note({ at: Date.now(), kind: 'rewritten-system' });
      return orig(next);
    }
    note({ at: Date.now(), kind: 'passthrough', mode: config && config.mode || '' });
    return orig(config);
  };
  let ok = false;
  try { ses.setProxy = wrapped; ok = ses.setProxy === wrapped; } catch (e) { /* read-only: try defineProperty */ }
  if (!ok) { try { Object.defineProperty(ses, 'setProxy', { value: wrapped, configurable: true, writable: true }); ok = ses.setProxy === wrapped; } catch (e) { /* still read-only */ } }
  if (!ok) { note({ at: Date.now(), kind: 'wrap-failed' }); return false; }
  try { Object.defineProperty(ses, '__fbOfflineWrapped', { value: true }); } catch (e) { ses.__fbOfflineWrapped = true; }
  note({ at: Date.now(), kind: 'wrapped' });
  return true;
}
function arm() {
  try { wrap(session.defaultSession); }
  catch (e) { note({ at: Date.now(), kind: 'arm-error', message: String(e && e.message || e) }); }
}
note({ at: Date.now(), kind: 'loaded', pid: process.pid });
if (app.isReady()) arm(); else app.on('ready', arm);
`;
}

// Page-side helpers: frame-gap sampler, PTY echo probe, card watcher. Installed with win.evaluate().
const PAGE_LIB_SRC = `(() => {
  const L = window.__fbLib = window.__fbLib || {};
  L.startFrames = () => {
    // Keep a tiny visible paint workload and record visibility/focus on slow
    // frames, to distinguish frame scheduling from log-scanning work. This
    // diagnostic does not relax the frame-gap acceptance threshold.
    const marker = document.createElement('div');
    marker.style.cssText = 'position:fixed;top:0;left:0;width:3px;height:3px;background:#0d6b5a;z-index:2147483647;pointer-events:none';
    document.body.appendChild(marker);
    const s = L.frames = { gaps: [], max: 0, frames: 0, last: performance.now(), running: true, t0: performance.now(), marker };
    const loop = (t) => { if (!s.running) return; marker.style.transform = 'translateX(' + (s.frames % 2) + 'px)'; const g = t - s.last; s.last = t; s.frames++; if (g > s.max) s.max = g; if (g > 50) s.gaps.push({ at: Math.round(t - s.t0), ms: Math.round(g), visibility: document.visibilityState, focused: document.hasFocus() }); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return true;
  };
  L.stopFrames = () => { const s = L.frames; if (!s) return null; s.running = false; s.marker.remove(); return { max: Math.round(s.max), frames: s.frames, seconds: +((performance.now() - s.t0) / 1000).toFixed(1), over50: s.gaps.length, gaps: s.gaps.slice(0, 40) }; };
  L.probe = async (id, ms, every) => {
    const sess = term.sessions.find((x) => x.id === id);
    if (!sess) return { error: 'no session ' + id };
    const lat = [], timeouts = [];
    const deadline = performance.now() + ms;
    const lineNow = () => { const b = sess.xterm.buffer.active; const l = b.getLine(b.baseY + b.cursorY); return l ? l.translateToString(true) : ''; };
    let n = 0;
    while (performance.now() < deadline) {
      const mark = 'zq' + (n++).toString(36);
      const t0 = performance.now();
      term.input(id, mark);
      let ok = false;
      while (performance.now() - t0 < 4000) { if (lineNow().indexOf(mark) >= 0) { ok = true; break; } await new Promise((r) => setTimeout(r, 4)); }
      if (ok) lat.push(Math.round(performance.now() - t0)); else timeouts.push(mark);
      term.input(id, '\\u001b'); // Esc clears the typed line in PSReadLine and cmd
      await new Promise((r) => setTimeout(r, every || 500));
    }
    const sorted = lat.slice().sort((a, b) => a - b);
    return { n: lat.length, timeouts: timeouts.length, max: sorted.length ? sorted[sorted.length - 1] : null, p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null, median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null, lat: lat.slice(0, 60) };
  };
  // a shell is ready when one of the last lines ends with a prompt character (PS C:\\...> or C:\\...>)
  L.waitPrompt = async (id, ms) => {
    const sess = term.sessions.find((x) => x.id === id);
    if (!sess) return false;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const b = sess.xterm.buffer.active;
      for (let i = Math.max(0, b.baseY + b.cursorY - 2); i <= b.baseY + b.cursorY; i++) { const l = b.getLine(i); if (l && /[>$#%]\\s*$/.test(l.translateToString(true))) return true; }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };
  L.watchCard = (p) => {
    const want = String(p).toLowerCase();
    const w = L.card = { seen: false, maxHeat: 0, label: '', changeLogMax: 0, badgeSeen: false, timelineMax: 0, polls: 0 };
    clearInterval(L.cardTimer);
    L.cardTimer = setInterval(() => {
      w.polls++;
      const el = [...document.querySelectorAll('#file-area [data-path]')].find((e) => String(e.dataset.path).toLowerCase() === want);
      if (el && (el.classList.contains('changed') || el.classList.contains('live-edit'))) {
        w.seen = true; const h = parseFloat(el.style.getPropertyValue('--heat') || '0'); if (h > w.maxHeat) w.maxHeat = h; if (el.dataset.changed) w.label = el.dataset.changed;
      }
      w.changeLogMax = Math.max(w.changeLogMax, state.changeLog.length);
      w.timelineMax = Math.max(w.timelineMax, state.changeTimeline.length);
      const b = document.querySelector('#changes-badge'); if (b && !b.classList.contains('hidden')) w.badgeSeen = true;
    }, 150);
    return true;
  };
  L.stopCard = () => { clearInterval(L.cardTimer); return L.card; };
  L.termTail = (id, n) => { const s = term.sessions.find((x) => x.id === (id || term.active)); if (!s) return ''; const b = s.xterm.buffer.active; const out = []; for (let i = Math.max(0, b.length - (n || 25)); i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\\n'); };
  return true;
})()`;

// ---------------------------------------------------------------------------
// Windows runtime helpers
// ---------------------------------------------------------------------------
const SYS = process.env.SystemRoot || 'C:\\Windows';
const PS_EXE = path.join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYS, 'System32', 'taskkill.exe');
const TASKLIST = path.join(SYS, 'System32', 'tasklist.exe');
function runPs(script, env, timeout) {
  return new Promise((resolve) => execFile(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout: timeout || 20000, maxBuffer: 16 * 1024 * 1024, env: env || process.env }, (e, out) => resolve(e ? '' : String(out))));
}
// Bridge / ConptyAgent / ConoutWorker are marked by SCRIPT PATH in the command line, for every app
// image name: under FANBOX_V2170_EXE the bridge runs as FanBox.exe, and the old ^electron\.exe$
// name gate made the packaged bridge invisible to the bridge-exit check. They mark only the
// expected copied script and node-pty helpers, never an arbitrary child. It contains no token.
// BridgeExact / AppAttr are the strict full-table attribution marks (env-driven needles, no
// command lines in the output): BridgeExact matches the COPIED bridge script path the same
// slash-normalized way procIdentity does; AppAttr is "same executable as the running app image
// AND the command line carries the app's script dir / server path or the hook script path", so
// unrelated system Electron processes are never attributed. Exe is a safe identity field.
const PROC_SCRIPT = "$all=@(Get-CimInstance Win32_Process); $cmd=@{}; foreach($p in $all){ $cmd[[int]$p.ProcessId]=[string]$p.CommandLine }; $bridge=[string]$env:FANBOX_CENSUS_BRIDGE; $appExe=[string]$env:FANBOX_CENSUS_APP_EXE; $needles=@(($env:FANBOX_CENSUS_NEEDLES -split [char]10) | Where-Object { $_ }); $all | ForEach-Object { $parent=[string]$cmd[[int]$_.ParentProcessId]; $cl=[string]$_.CommandLine; $ncl=$cl.Replace([char]92,[char]47); $hit=$false; foreach($n in $needles){ if($n -and ($ncl.IndexOf($n.Replace([char]92,[char]47),[System.StringComparison]::OrdinalIgnoreCase) -ge 0)){ $hit=$true; break } }; [pscustomobject]@{ Pid=$_.ProcessId; Ppid=$_.ParentProcessId; Name=$_.Name; CmdKnown=[int](-not [string]::IsNullOrEmpty($_.CommandLine)); Typed=[int]([bool]($_.CommandLine -match '--type=')); Bridge=[int]([bool](($_.CommandLine -match '(?i)[\\\\/]\\.fanbox[\\\\/]hooks[\\\\/]claude-statusline\\.cjs(?:\\\"|\\s|$)'))); ConptyAgent=[int]([bool](($_.CommandLine -match '(?i)[\\\\/]node-pty[\\\\/]lib[\\\\/]conpty_console_list_agent(?:\\.js)?(?:\\\"|\\s|$)'))); ConoutWorker=[int]([bool](($_.CommandLine -match '(?i)[\\\\/]node-pty[\\\\/]lib[\\\\/]worker[\\\\/]conoutSocketWorker(?:\\.js)?(?:\\\"|\\s|$)'))); SameAsParent=[int]([bool]($parent -and $_.CommandLine -and $_.CommandLine -eq $parent)); BridgeExact=[int]([bool]($bridge -and $cl -and ($ncl.IndexOf($bridge.Replace([char]92,[char]47),[System.StringComparison]::OrdinalIgnoreCase) -ge 0))); AppAttr=[int]([bool]($appExe -and $_.ExecutablePath -and ($_.ExecutablePath -ieq $appExe) -and $hit)); Exe=$_.ExecutablePath } } | ConvertTo-Csv -NoTypeInformation";
async function procTable(attr) {
  // Full-table attribution needles travel via env (like procIdentity's bridge needle): no path
  // is ever baked into the script and no command line comes back into the evidence.
  const env = Object.assign({}, process.env, {
    FANBOX_CENSUS_BRIDGE: String((attr && attr.bridgeScript) || ''),
    FANBOX_CENSUS_APP_EXE: String((attr && attr.appExe) || ''),
    FANBOX_CENSUS_NEEDLES: ((attr && attr.needles) || []).map(String).filter(Boolean).join('\n'),
  });
  let rows = csvObjects(await runPs(PROC_SCRIPT, env, 30000));
  if (!rows.length) { // CIM unavailable: fall back to tasklist (names and pids only, no parent links)
    const out = await new Promise((resolve) => execFile(TASKLIST, ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 20000 }, (e, o) => resolve(e ? '' : String(o))));
    rows = parseCsv(out).map((r) => ({ Name: r[0], Pid: r[1], Ppid: '0', Typed: '1' }));
    rows.degraded = true;
  }
  return rows;
}
// Re-query just suspicious no-type descendants without recording their full command lines:
// Electron renderer argv can contain the control token. The evidence records only safe identity fields.
async function procIdentity(pids, bridgeScript) {
  const wanted = (pids || []).map((p) => Number(p)).filter(Number.isFinite);
  if (!wanted.length) return [];
  const script = "$ids=@(" + wanted.join(',') + "); $needle=$env:FANBOX_CENSUS_BRIDGE; $all=@(Get-CimInstance Win32_Process); $cmd=@{}; foreach($p in $all){ $cmd[[int]$p.ProcessId]=[string]$p.CommandLine }; $all | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { $parent=[string]$cmd[[int]$_.ParentProcessId]; [pscustomobject]@{ Pid=$_.ProcessId; Ppid=$_.ParentProcessId; Name=$_.Name; HasCommandLine=[int](-not [string]::IsNullOrEmpty($_.CommandLine)); Typed=[int]([bool]($_.CommandLine -match '--type=')); ExactBridgeScript=[int]([bool]($needle -and $_.CommandLine -and $_.CommandLine.Replace([char]92,[char]47).IndexOf($needle.Replace([char]92,[char]47),[System.StringComparison]::OrdinalIgnoreCase) -ge 0)); ExactConptyAgent=[int]([bool]($_.CommandLine -match '(?i)[\\\\/]node-pty[\\\\/]lib[\\\\/]conpty_console_list_agent(?:\\.js)?(?:\\\"|\\s|$)')); ExactConoutWorker=[int]([bool]($_.CommandLine -match '(?i)[\\\\/]node-pty[\\\\/]lib[\\\\/]worker[\\\\/]conoutSocketWorker(?:\\.js)?(?:\\\"|\\s|$)')); SameAsParent=[int]([bool]($parent -and $_.CommandLine -and $_.CommandLine -eq $parent)); Exe=$_.ExecutablePath } } | ConvertTo-Csv -NoTypeInformation";
  return csvObjects(await runPs(script, Object.assign({}, process.env, { FANBOX_CENSUS_BRIDGE: String(bridgeScript || '') }), 10000));
}
function killTreeSync(pid) { try { execFileSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* already gone */ } }
const killTree = (pid) => new Promise((resolve) => execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20000 }, () => resolve()));
async function freePorts(from) {
  const free = (p) => new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
  for (let p = from; p < from + 400; p += 2) if (await free(p) && await free(p + 1)) return p;
  throw new Error('no free port pair near ' + from);
}
async function waitFor(fn, ms, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { let v; try { v = await fn(); } catch { v = null; } if (v) return v; await sleep(step || 250); }
  return null;
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

class Ctx {
  constructor(opts) {
    this.opts = opts;
    this.realHome = os.homedir();
    this.base = path.resolve(opts.base || path.join(os.tmpdir(), 'fanbox-v2170'));
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.out = path.resolve(opts.out || path.join(this.base, 'evidence', this.stamp));
    this.live = new Set();
    this.nextPortFrom = opts.port;
    this.pw = null;
    this.dict = null;
  }
  homeFor(name) { return path.join(this.base, name); }
  freshHome(name, lang) {
    const home = this.homeFor(name);
    if (!this.opts.keep || !fs.existsSync(path.join(home, MARKER))) resetHome(home, this.realHome);
    prepareHome(home, { lang: lang || 'zh' });
    return home;
  }
  evidence(name, data) {
    fs.mkdirSync(this.out, { recursive: true });
    const f = path.join(this.out, name);
    fs.writeFileSync(f, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n');
    return f;
  }
  async port() { const p = await freePorts(this.nextPortFrom); this.nextPortFrom = p + 2; return p; }
  killAll() { for (const h of this.live) killTreeSync(h.wrapperPid || h.pid); this.live.clear(); }
}

function installStandIn(home, extraDirs) {
  const dir = path.join(home, 'fb-standin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-standin.js'), STANDIN_SRC);
  fs.writeFileSync(path.join(dir, 'claude.cmd'), STANDIN_CMD);
  for (const f of ['claude.ps1', 'claude.exe']) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* none */ } } // PowerShell prefers .ps1 over .cmd
  return dir;
}
function installFakeCodex(home) {
  const dir = path.join(home, 'fb-fake-codex');
  const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@ECHO off\r\n"%FANBOX_STANDIN_NODE%" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  fs.writeFileSync(entry, "'use strict';\nconst fs = require('fs');\ntry { fs.writeFileSync(process.env.FANBOX_CODEX_DUMP, JSON.stringify(process.argv.slice(2))); } catch (e) { /* none */ }\nprocess.exit(0);\n");
  return dir;
}

async function launchApp(ctx, o) {
  if (!ctx.pw) throw new Error('playwright-core is not loaded');
  const home = o.home;
  const port = await ctx.port();
  const userData = path.join(home, 'AppData', 'Roaming', 'FanBox-userdata');
  const standinDir = o.standin ? installStandIn(home) : null;
  const codexDir = o.fakeCodex ? installFakeCodex(home) : null;
  const emptyPf = path.join(home, 'fb-empty-programfiles');
  if (o.hideGit) fs.mkdirSync(emptyPf, { recursive: true });
  const hideLog = path.join(home, 'hide-git.log');
  const { env, dropped } = buildEnv({
    baseEnv: process.env, home, port, hideGit: !!o.hideGit, emptyDir: emptyPf, exists: (f) => fs.existsSync(f),
    pathFront: [standinDir, codexDir], nodeDir: path.dirname(process.execPath),
    extra: Object.assign({
      FANBOX_STANDIN_NODE: process.execPath, FANBOX_STANDIN_HELPERS: path.join(ROOT, 'win-port-helpers.js'),
      FANBOX_STANDIN_RESULT: path.join(home, 'standin-result.json'), FANBOX_STANDIN_RUNS: o.runs || 3,
      FANBOX_CODEX_DUMP: path.join(home, 'codex-argdump.json'), FANBOX_HIDEGIT_LOG: hideLog,
      FANBOX_R1_PROXY_LOG: o.offlineUpdate ? path.join(home, 'r1-proxy.log') : undefined,
    }, o.env || {}),
  });
  const preloads = [];
  if (o.hideGit) { const p = path.join(home, 'hide-git-preload.cjs'); fs.writeFileSync(p, hideGitPreloadSrc()); preloads.push(p); }
  if (o.offlineUpdate) { const p = path.join(home, 'offline-update-preload.cjs'); fs.writeFileSync(p, offlineUpdatePreloadSrc()); preloads.push(p); }
  const args = ['--user-data-dir=' + userData, '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  // Block non-loopback traffic before the app's own setProxy runs. The bypass list is NOT passed
  // here: cmd.exe eats "<...>", and an empty bypass list forces localhost through the proxy.
  if (o.offlineUpdate) args.push('--proxy-server=http://127.0.0.1:9');
  for (const p of preloads) args.push('-r', p);
  if (!process.env.FANBOX_V2170_EXE) args.push(ROOT);
  const electronExe = process.env.FANBOX_V2170_EXE || require(path.join(ROOT, 'node_modules', 'electron'));
  const app = await ctx.pw._electron.launch({ executablePath: electronExe, args, cwd: ROOT, env, timeout: 90000 });
  const wrapperPid = app.process().pid;
  // Playwright launches Electron through `cmd.exe /c` on Windows, so app.process().pid is
  // that wrapper. The census has to start at the real Electron process, or the app itself
  // looks like a second instance.
  const electronPid = await app.evaluate(() => process.pid);
  const h = { app, pid: electronPid, wrapperPid, home, port, env, dropped, standinDir, codexDir, hideLog, errors: [], label: o.label || '' };
  ctx.live.add(h);
  h.win = await app.firstWindow();
  h.win.on('pageerror', (e) => h.errors.push(String(e && e.message || e)));
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1500, 940); w.center(); w.show(); w.focus(); });
  await sleep(2200);
  const seedArg = { lang: o.lang || 'zh', usage: !!o.usage };
  const seedStorage = () => h.win.evaluate((c) => {
    localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_term_open', '1'); localStorage.setItem('fb_term_dock', 'bottom');
    localStorage.setItem('fb_lang', c.lang); localStorage.setItem('fb_usage_open', c.usage ? '1' : '0');
  }, seedArg);
  try {
    await seedStorage();
  } catch (e) {
    // A dead proxy can leave the first paint on a chrome-error page, which has no localStorage.
    // FanBox retries loadURL every 150 ms once loopback is reachable.
    await h.win.waitForFunction(() => { try { return location.hostname === 'localhost' || location.hostname === '127.0.0.1'; } catch (err) { return false; } }, null, { timeout: 20000 });
    await seedStorage();
  }
  await h.win.evaluate(() => location.reload()).catch(() => {});
  await sleep(2500);
  await h.win.waitForFunction(() => typeof term !== 'undefined' && typeof usagePanel !== 'undefined' && !!window.fanboxEnv && !!document.querySelector('#usage-body'), null, { timeout: 40000 });
  await h.win.evaluate(() => { try { window.playChime = () => {}; } catch { /* none */ } });
  await h.win.evaluate(PAGE_LIB_SRC);
  if (o.perf) {
    // Keep the shipped rendering settings. Foreground validity is sampled from
    // BrowserWindow, since document.visibilityState can lie under test flags.
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(true); w.focus(); });
    await h.win.evaluate(() => { const n = document.createElement('div'); n.textContent = 'Performance test — keep this window focused and uncovered until it closes'; n.style.cssText = 'position:fixed;top:40px;left:50%;transform:translateX(-50%);padding:6px 12px;background:#ffe6a6;color:#241b00;border-radius:6px;z-index:2147483646;pointer-events:none;font:13px Segoe UI'; document.body.appendChild(n); });
  }
  if (standinDir) await putFirstOnPath(app, standinDir);
  if (codexDir) await putFirstOnPath(app, codexDir);
  return h;
}
// FanBox merges the registry PATH in FRONT of the launch PATH during startup, so a stand-in placed
// first in the launch environment could still lose to a real `claude`. After startup the PTYs copy
// process.env at spawn time, so putting the directory first now wins.
async function putFirstOnPath(app, dir) {
  await app.evaluate((_, d) => {
    const k = Object.keys(process.env).find((x) => x.toLowerCase() === 'path') || 'Path';
    const parts = String(process.env[k] || '').split(';').filter((x) => x && x.toLowerCase() !== d.toLowerCase());
    process.env[k] = [d].concat(parts).join(';');
  }, dir);
}
async function mainEnvOf(app) { return app.evaluate(() => Object.assign({}, process.env)); }
async function startNativeFrameProbe(app) {
  await app.evaluate(({ BrowserWindow }) => {
    global.__frameNative = [];
    const sample = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) global.__frameNative.push({ at: Date.now(), visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() }); };
    sample(); global.__frameNativeTimer = setInterval(sample, 250);
  });
}
async function stopNativeFrameProbe(app) {
  return app.evaluate(() => { clearInterval(global.__frameNativeTimer); return global.__frameNative; });
}
function frameWindowValid(samples) {
  return samples.length > 0 && samples.every(s => s.visible && !s.minimized && s.focused);
}
function validFrameWindow(id, samples) {
  const invalid = samples.filter(s => !s.visible || s.minimized || !s.focused);
  check(id, samples.length > 0 && invalid.length === 0, 'Performance window stayed visible, focused and not minimized', invalid.length ? 'INVALID MEASUREMENT: keep the test window foreground and uncovered; samples ' + JSON.stringify(invalid.slice(0, 3)) : samples.length + ' native window samples');
  return frameWindowValid(samples);
}
async function closeApp(ctx, h) {
  if (!h) return;
  try { await h.win.evaluate(() => { try { window.__fbLib.stopFrames(); window.__fbLib.stopCard(); } catch { /* none */ } }); } catch { /* window gone */ }
  await Promise.race([h.app.close().catch(() => {}), sleep(8000)]);
  await killTree(h.wrapperPid || h.pid); // app.close() can hang while a ConPTY child is alive
  ctx.live.delete(h);
  await sleep(800);
}

// ---------------------------------------------------------------------------
// Status-line case (S1 / S5 / S6 / X1 share it)
// ---------------------------------------------------------------------------
const expectedHookPath = (home) => path.join(home, '.fanbox', 'hooks', 'claude-settings.json');

async function oneClick(h, project) {
  const win = h.win;
  await win.evaluate(async (p) => { await navigate(p); }, project);
  await sleep(700);
  const cmd = await win.evaluate(() => agentLaunchCmd(AGENT_REGISTRY.find((a) => a.id === 'claude')));
  await win.evaluate((c) => term.launchAgent(c), cmd);
  const termId = await waitFor(() => win.evaluate(() => term.active), 10000, 200);
  return { cmd, termId };
}

async function statusLineCase(ctx, o) {
  const id = o.id, label = o.label;
  const result = {};
  const home = ctx.freshHome(o.homeName, o.lang);
  const project = path.join(home, 'work', 'sl-proj');
  fs.mkdirSync(project, { recursive: true });
  const soakRuns = o.soak ? Math.ceil(o.soak * 60 / 5) : 0; // one refresh every 5 s
  const h = await launchApp(ctx, { home, lang: o.lang, standin: true, hideGit: !!o.hideGit, usage: true, label, runs: soakRuns || undefined, env: soakRuns ? { FANBOX_STANDIN_GAP_MS: 5000 } : {} });
  try {
    const win = h.win, app = h.app;
    const mainEnv = await mainEnvOf(app);
    const bashInMain = H.winGitBash(mainEnv);
    if (o.hideGit) {
      const log = (fs.existsSync(h.hideLog) ? fs.readFileSync(h.hideLog, 'utf8') : '').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = log.find((l) => l.kind === 'registry-path');
      info(id, 'hide-Git preload', JSON.stringify({ loaded: log.some((l) => l.kind === 'loaded'), filtered: filtered && filtered.dropped, droppedDirs: filtered && filtered.droppedDirs, launchPathDropped: h.dropped.length }));
      if (bashInMain) {
        skip(id, label + ': could not hide Git from FanBox (harness limitation, not a product failure)', `winGitBash still finds ${bashInMain}. Preload loaded=${log.some((l) => l.kind === 'loaded')}. Hide Git by hand (rename ...\\Git, or remove it from PATH) and rerun; see README S5.`);
        return result;
      }
      check(id, true, label + ': FanBox sees no Git Bash (PATH filtered after the registry merge, ProgramFiles emptied, CLAUDE_CODE_GIT_BASH_PATH unset)', 'winGitBash(main env) = null');
    } else if (!bashInMain) {
      skip(id, label + ': prerequisite missing: winGitBash() finds no Git Bash in FanBox\'s environment', 'Install Git for Windows (or set CLAUDE_CODE_GIT_BASH_PATH) and rerun. Without Git Bash FanBox correctly writes no status line.');
      return result;
    }
    // the stand-in really is what the shell will resolve
    const mainPath = await app.evaluate(() => process.env.Path || process.env.PATH || '');
    const first = H.winFindOnPath('claude', Object.assign({}, mainEnv, { Path: mainPath }));
    const standinCmd = path.join(h.standinDir, 'claude.cmd');
    check(id, !!first && first.toLowerCase() === standinCmd.toLowerCase(), label + ': stand-in claude.cmd is first on the PTY PATH (after the registry PATH merge)', `first claude on PATH = ${first}`);
    const whichClaude = await win.evaluate(() => fetch('/api/agents/which?bins=claude').then((r) => r.json()).catch(() => null));
    check(id, !!(whichClaude && whichClaude.claude), label + ': /api/agents/which (findAgentBin) reports claude installed', JSON.stringify(whichClaude));

    // ---- hook file ----
    const hook = readHookFile(home);
    check(id, !!hook.json && !!hook.json.hooks && !!hook.json.hooks.SessionStart, label + ': hook file written with the HTTP hooks', hook.file);
    const hookHttp = hook.json && hook.json.hooks && hook.json.hooks.SessionStart && hook.json.hooks.SessionStart[0].hooks[0];
    check(id, !!hookHttp && hookHttp.type === 'http' && hookHttp.headers['x-fanbox-token'] === '$FANBOX_CTL_TOKEN', label + ': hook file still has the HTTP hooks and the x-fanbox-token: $FANBOX_CTL_TOKEN reference', JSON.stringify(hookHttp && hookHttp.headers));
    const token = await win.evaluate(() => (window.fanboxEnv || {}).ctlToken || '');
    check(id, token.length >= 16 && !hook.raw.includes(token), label + ': hook file contains no token literal', `token length ${token.length}`);
    const execPath = await app.evaluate(() => process.execPath);
    const wantCmd = H.winStatusLineCommand(execPath, hook.script);
    // Full-table census attribution: the COPIED bridge script path (the slash-normalized needle
    // procIdentity uses) plus the app's script dir / server path and the running app image.
    // Unrelated system Electron processes carry neither, so they can never be attributed.
    const censusAttr = { bridgeScript: hook.script, appExe: execPath, needles: [hook.script, ROOT, path.join(ROOT, 'server.js'), execPath, path.join(path.dirname(execPath), 'resources', 'app.asar')] };
    if (o.expectStatusLine) {
      check(id, !!hook.json && !!hook.json.statusLine && hook.json.statusLine.type === 'command', label + ': hook file has a statusLine', JSON.stringify(hook.json && hook.json.statusLine));
      check(id, !!wantCmd && hook.json.statusLine.command === wantCmd, label + ': statusLine.command = ELECTRON_RUN_AS_NODE=1 \'<FanBox exe>\' \'<hooks>/claude-statusline.cjs\' (forward slashes, single quotes)', hook.json.statusLine && hook.json.statusLine.command);
      if (o.apostrophe) check(id, !!wantCmd && wantCmd.includes("'\"'\"'"), label + ': winStatusLineCommand escapes an apostrophe with a Bash single-quote splice', String(wantCmd));
      check(id, fs.existsSync(hook.script) && fs.readFileSync(hook.script, 'utf8') === fs.readFileSync(path.join(ROOT, 'lib', 'claude-statusline.cjs'), 'utf8'), label + ': bridge script copied byte for byte to ~/.fanbox/hooks', hook.script);
    } else {
      check(id, !!hook.json && !('statusLine' in hook.json), label + ': hook file has no statusLine', JSON.stringify(Object.keys(hook.json || {})));
      check(id, !fs.existsSync(hook.script), label + ': bridge script was not copied', hook.script);
    }

    // ---- one-click launch of the stand-in ----
    const before = { windows: app.windows().length, bw: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), table: await procTable(censusAttr) };
    const strayBefore = strayMains(before.table, h.pid);
    // Census honesty: the tasklist fallback has no parent links and no Bridge/SameAsParent fields,
    // so a tree walk finds no descendants and every "nothing found" claim would be vacuous. Any
    // census check whose underlying table is degraded is recorded FAIL with this reason below,
    // never a green PASS.
    const degradedReason = 'RECORDED FAIL: process census degraded to tasklist (names and pids only, no parent links, no command lines, no Bridge/SameAsParent fields); the tree walk finds no descendants and the full-table scan cannot attribute any row, so these claims cannot be verified';
    const { cmd, termId } = await oneClick(h, project);
    const wantFlag = ' --settings "' + expectedHookPath(home) + '"';
    check(id, cmd === 'claude --dangerously-skip-permissions' + wantFlag, label + ': one-click command = claude --dangerously-skip-permissions --settings "<abs hook file>"', cmd);
    const resultFile = path.join(home, 'standin-result.json');
    const census = [];
    const waitMs = o.soak ? o.soak * 60000 + 180000 : 75000;
    const tWait = Date.now(); let nextCensus = tWait + 60000, finished = null;
    while (Date.now() - tWait < waitMs) {
      const r = readJson(resultFile);
      if (r && (r.statusDone || r.bashMissing)) { finished = r; break; }
      if (o.soak && Date.now() >= nextCensus) { // once a minute: no stray main process, no window growth, process count stable
        nextCensus += 60000;
        const tbl = await procTable(censusAttr);
        // Tree-scoped stray counts miss rows whose ancestors already exited; the full-table orphan
        // count closes that gap per minute. A bridge row may legitimately be alive mid-refresh
        // here (refreshes run every 5 s), so per-minute bridge counts are evidence only — the
        // bridge-exit claim ("none alive at all") is asserted once, at the after-census below.
        const fullMinute = fullTableStrays(tbl, h.pid);
        census.push({ minute: Math.round((Date.now() - tWait) / 60000), refreshes: r ? r.runs.length : 0, stray: strayMains(tbl, h.pid).length, fullBridge: fullMinute.bridges.length, fullOrphan: fullMinute.orphans.length, electronProcs: tbl.filter((p) => /^(electron|fanbox)\.exe$/i.test(p.Name || '')).length, windows: app.windows().length, degraded: !!tbl.degraded });
        console.log('INFO: [' + id + '] soak minute ' + census[census.length - 1].minute + ': ' + JSON.stringify(census[census.length - 1]));
      }
      await sleep(400);
    }
    const rec = finished || readJson(resultFile);
    if (!rec) {
      const tail = await win.evaluate((i) => window.__fbLib.termTail(i, 40), termId).catch(() => '');
      ctx.evidence(`terminal-tail-${label.replace(/\W+/g, '_')}.txt`, tail);
      // diagnostics: what does the shell think `claude` is? (constant command, no user data)
      check(id, false, label + ': stand-in started from the one-click command', 'no result file after 75 s. Terminal tail saved to evidence; last lines: ' + trunc(tail.split('\n').filter(Boolean).slice(-4).join(' | '), 200));
      return result;
    }
    ctx.evidence(`standin-result-${label.replace(/\W+/g, '_')}.json`, rec);
    check(id, rec.argv.includes('--settings') && rec.argv[rec.argv.indexOf('--settings') + 1] === expectedHookPath(home), label + ': argv carries --settings with the exact absolute path', JSON.stringify(rec.argv));
    check(id, rec.settingsOk === true, label + ': stand-in parsed the settings file FanBox pointed at', rec.settingsError || '');
    check(id, /^http:\/\/127\.0\.0\.1:\d+\/api\/agent$/.test(rec.env.FANBOX_CTL) && rec.env.tokenPresent && /^t\d+$/.test(rec.env.FANBOX_TERM_ID), label + ': PTY env carries FANBOX_CTL / FANBOX_CTL_TOKEN / FANBOX_TERM_ID', JSON.stringify(rec.env));
    check(id, rec.posted.length >= 1 && rec.posted.every((p) => p.status === 200), label + ': hook events accepted by /api/agent/event (200)', JSON.stringify(rec.posted));
    result.rec = rec; result.termId = termId; result.home = home; result.project = project;

    if (o.expectStatusLine) {
      check(id, rec.hasStatusLine === true && !rec.bashMissing && !!rec.bash && fs.existsSync(rec.bash), label + ': stand-in located Git Bash like winGitBash does', rec.bash || rec.bashError || 'none');
      check(id, rec.bash && bashInMain && rec.bash.toLowerCase() === bashInMain.toLowerCase(), label + ': same bash.exe FanBox\'s own lookup finds', `${rec.bash} vs ${bashInMain}`);
      const want = SAMPLE_TEXT[o.lang];
      const runs = rec.runs || [];
      check(id, runs.length >= 1 && runs.every((r) => r.code === 0 && !r.timedOut && !r.error), label + ': every bash -c <statusLine.command> run exited 0', JSON.stringify(runs.map((r) => ({ code: r.code, err: r.error, stderr: trunc(r.stderr || '', 80) }))));
      check(id, runs.length >= 1 && runs.every((r) => String(r.stdout).trim() === want), label + ': output line is "' + want + '"', JSON.stringify(runs.map((r) => String(r.stdout).trim())));
      const ms = runs.map((r) => Math.round(r.ms));
      const worst = Math.max.apply(null, ms.length ? ms : [Infinity]);
      info(id, label + ': status refresh timings', `${ms.join(' / ')} ms (first = cold)`);
      if (worst < 1000) check(id, true, label + ': each refresh under 1 s', `${ms.join(' / ')} ms`);
      else if (worst < 2000) warn(id, label + ': a refresh took 1-2 s (target is under 1 s)', `${ms.join(' / ')} ms`);
      else check(id, false, label + ': a refresh took 2 s or more', `${ms.join(' / ')} ms`);
      const sample = rec.runs.length ? rec.runs[rec.runs.length - 1] : null;
      info(id, label + ': stderr of last run', sample && sample.stderr ? sample.stderr : '(empty)');
      if (o.soak) {
        const sorted = ms.slice().sort((a, b) => a - b);
        const baseline = before.table.filter((p) => /^(electron|fanbox)\.exe$/i.test(p.Name || '')).length;
        info(id, label + ': soak refresh distribution', JSON.stringify({ refreshes: ms.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], over1s: ms.filter((x) => x >= 1000).length }));
        check(id, ms.length >= soakRuns - 1, label + ': the stand-in completed its ' + soakRuns + ' scheduled refreshes over ' + o.soak + ' minutes', ms.length + ' done');
        const soakDegraded = !!before.table.degraded || census.some((c) => c.degraded);
        check(id, !soakDegraded && census.length >= Math.max(1, o.soak - 1) && census.every((c) => c.stray === 0 && c.fullOrphan === 0), label + ': every minute: no extra FanBox / electron main process below the app and no orphaned app row in the full process table', soakDegraded ? degradedReason : JSON.stringify(census.map((c) => ({ stray: c.stray, orphan: c.fullOrphan }))));
        check(id, census.every((c) => c.windows === before.windows), label + ': every minute: no second FanBox window', JSON.stringify(census.map((c) => c.windows)));
        check(id, census.every((c) => c.electronProcs <= baseline + 3), label + ': electron process count did not grow (baseline ' + baseline + ', +3 allowed for Chromium helpers)', JSON.stringify(census.map((c) => c.electronProcs)));
      }
      // the bridge's POST is real: server state + panel
      const usage = await waitFor(async () => { const u = await win.evaluate(() => fetch('/api/agent-usage').then((r) => r.json())); return u && u.claude && u.claude.official && u.claude.official.source === 'statusline' ? u : null; }, 15000, 500);
      const off = usage && usage.claude.official;
      check(id, !!off && off.fiveHour && Math.abs(off.fiveHour.usedPercent - SAMPLE.five) < 1e-9 && off.sevenDay && Math.abs(off.sevenDay.usedPercent - SAMPLE.seven) < 1e-9, label + ': /api/agent/usage accepted the bridge POST (server reports source "statusline", 23.4 / 41.6)', JSON.stringify(off && { s: off.source, f: off.fiveHour && off.fiveHour.usedPercent, w: off.sevenDay && off.sevenDay.usedPercent }));
      await win.evaluate(() => { localStorage.setItem('fb_usage_open', '1'); usagePanel.apply(); });
      const zhLabel = 'CLI实时回传';
      const wantLabel = o.lang === 'en' ? ctx.dict.enOf(zhLabel) : zhLabel;
      if (!wantLabel) check(id, false, label + ': English text for the Claude source line', `i18n-dict.js has no entry for "${zhLabel}" (D4 dictionary not merged yet?)`);
      else {
        const shown = await waitFor(async () => { await win.evaluate(() => usagePanel.refresh()); const t = await win.evaluate(() => document.querySelector('#usage-body').innerText); return t.toLowerCase().includes(wantLabel.toLowerCase()) ? t : null; }, 25000, 1500);
        check(id, !!shown, label + ': usage panel shows the Claude source as "' + wantLabel + '"', shown ? trunc(shown.replace(/\s+/g, ' '), 200) : 'not shown');
        await win.screenshot({ path: ctx.evidence(`panel-${label.replace(/\W+/g, '_')}.png`, '') }).catch(() => {});
      }
    } else {
      check(id, rec.hasStatusLine === false && rec.runs.length === 0, label + ': stand-in saw no statusLine (nothing to run)', JSON.stringify({ hasStatusLine: rec.hasStatusLine, runs: rec.runs.length }));
      const usage = await win.evaluate(() => fetch('/api/agent-usage').then((r) => r.json()));
      const off = usage && usage.claude && usage.claude.official;
      check(id, !!off && off.source !== 'statusline' && !!off.error, label + ': Claude quota comes from the official-API path (no live bridge), here an error because the sandbox has no login', JSON.stringify(off && { source: off.source, error: off.error }));
      await win.evaluate(() => { localStorage.setItem('fb_usage_open', '1'); usagePanel.apply(); });
      const t = await waitFor(async () => { await win.evaluate(() => usagePanel.refresh()); const x = await win.evaluate(() => document.querySelector('#usage-body').innerText); return /Claude Code/.test(x) ? x : null; }, 15000, 1000);
      const claimsLive = /CLI实时回传(?:\s*[·•]|\s*$)/.test(t) || /\bLive from CLI(?:\s*[·•]|\s*$)/i.test(t);
      check(id, !!t && !claimsLive, label + ': panel does not claim a live CLI source', trunc(String(t).replace(/\s+/g, ' '), 160));
    }

    // ---- no second FanBox: windows and processes ----
    // The expected copied bridge is Electron-as-Node and therefore deliberately has no --type=.
    // Give its final callback a bounded grace period, then require that it has exited; all other
    // no-type Electron descendants still fail the second-app check.
    await sleep(3200);
    const afterTable = await procTable(censusAttr);
    const after = { windows: app.windows().length, bw: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), stray: strayMains(afterTable, h.pid) };
    // A process can exit between the snapshot and CIM's detail query. Treat that as a vanished
    // snapshot entry, but retain a persistent non-bridge no-type Electron descendant as a failure.
    const firstStray = after.stray;
    const firstUnknown = unknownMains(afterTable, h.pid);
    await sleep(250);
    const identities = await procIdentity(firstStray.concat(firstUnknown).map((p) => p.Pid), hook.script);
    const sameExe = (p) => String(p.Exe || '').toLowerCase() === String(execPath || '').toLowerCase();
    // Expected node-pty helpers are identified by executable path (the app image re-executes its own
    // argv as the conout worker), never by image name, so a FANBOX_V2170_EXE run is classified
    // exactly like dev Electron and only the app's own helpers are whitelisted.
    const isExpectedPtyHelper = (p) => sameExe(p) && (String(p.ExactConptyAgent) === '1' || String(p.ExactConoutWorker) === '1' || String(p.SameAsParent) === '1');
    const persistentStray = identities.filter((p) => Number(p.Pid) !== Number(h.pid) && String(p.HasCommandLine) === '1' && String(p.ExactBridgeScript) !== '1' && !isExpectedPtyHelper(p));
    const unknownPersistent = identities.filter((p) => String(p.HasCommandLine) !== '1');
    check(id, after.windows === before.windows && after.bw === before.bw, label + ': no second FanBox window (Playwright windows / BrowserWindow count unchanged)', `windows ${before.windows} -> ${after.windows}, BrowserWindow ${before.bw} -> ${after.bw}`);
    const censusDegraded = !!(afterTable.degraded || before.table.degraded);
    if (censusDegraded) warn(id, label + ': process census degraded to tasklist (no parent links); the census checks below are recorded FAIL, never a vacuous PASS', 'CIM query returned nothing');
    // The bridge is marked by script path for every app image name, so a live bridge — and the
    // historical runaway-full-app regression, which carries the same argv — is seen here instead of
    // vanishing from the checks. Non-vacuous: a bridge launch must be observed (the stand-in's
    // statusLine runs are bridge launches), the census must see the app's own main process, and no
    // marked process may survive the bounded grace.
    // Full-table scan (NOT tree-scoped): the walks above only reach descendants of the app main,
    // so a hung bridge or runaway app image whose ancestors (the stand-in claude.cmd / node,
    // bash -c) exited before this census is an orphan row they never reach. (a) any row carrying
    // the copied bridge script path fails the bridge-exit claim wherever it sits in the table;
    // (b) any orphaned no-type row of this app's executable carrying its script path fails the
    // stray claim. The tasklist fallback has no command lines to attribute, so censusDegraded
    // below turns both claims into a recorded FAIL instead of a vacuous pass.
    const full = fullTableStrays(afterTable, h.pid);
    const fullBridges = full.bridges.map((p) => ({ pid: p.Pid, ppid: p.Ppid, name: p.Name, exe: p.Exe }));
    const fullOrphans = full.orphans.map((p) => ({ pid: p.Pid, ppid: p.Ppid, name: p.Name, typed: p.Typed, exe: p.Exe }));
    const afterBridges = bridgeMains(afterTable, h.pid);
    const censusSawMain = afterTable.some((p) => Number(p.Pid) === Number(h.pid));
    const bridgeLaunched = !!(o.expectStatusLine && rec && Array.isArray(rec.runs) && rec.runs.length >= 1);
    const s5NothingRan = !o.expectStatusLine && Array.isArray(rec.runs) && rec.runs.length === 0;
    check(id, !censusDegraded && afterBridges.length === 0 && full.bridges.length === 0 && censusSawMain && (bridgeLaunched || s5NothingRan),
      label + (o.expectStatusLine ? ': status-line bridge launch observed and the marked bridge process is gone after its bounded callback grace period (tree walk and full process table)' : ': no status line expected: the stand-in ran nothing and no process carries the bridge script path (tree walk and full process table)'),
      censusDegraded ? degradedReason : JSON.stringify({ bridgeLaunched, s5NothingRan, runs: Array.isArray(rec.runs) ? rec.runs.length : null, censusSawMain, fullTableBridges: fullBridges, alive: afterBridges.map((p) => ({ pid: p.Pid, name: p.Name })) }));
    if (unknownPersistent.length) warn(id, label + ': process census saw persistent descendants with unavailable command lines', JSON.stringify(unknownPersistent.map((p) => ({ pid: p.Pid, ppid: p.Ppid, name: p.Name, hasCommandLine: p.HasCommandLine, exe: p.Exe }))));
    check(id, !censusDegraded && strayBefore.length === 0 && persistentStray.length === 0 && full.orphans.length === 0, label + ': no persistent extra FanBox / electron main process below the app and no orphaned app process in the full process table after the refreshes', censusDegraded ? degradedReason : JSON.stringify({ snapshot: firstStray.map((p) => ({ pid: p.Pid, name: p.Name })), fullTableOrphans: fullOrphans, requery: identities.map((p) => ({ pid: p.Pid, ppid: p.Ppid, name: p.Name, hasCommandLine: p.HasCommandLine, typed: p.Typed, exactBridgeScript: p.ExactBridgeScript, exe: p.Exe })) }));
    ctx.evidence(`processes-${label.replace(/\W+/g, '_')}.json`, { mainPid: h.pid, before: before.table.length, after: afterTable.length, bridgeLaunched, s5NothingRan, censusSawMain, censusDegraded, fullTableBridges: fullBridges, fullTableOrphans: fullOrphans, snapshotStray: firstStray.map((p) => ({ pid: p.Pid, name: p.Name, conout: p.ConoutWorker, conpty: p.ConptyAgent, sameAsParent: p.SameAsParent })), snapshotUnknown: firstUnknown.map((p) => ({ pid: p.Pid, name: p.Name })), requery: identities.map((p) => ({ pid: p.Pid, ppid: p.Ppid, name: p.Name, hasCommandLine: p.HasCommandLine, typed: p.Typed, exactBridgeScript: p.ExactBridgeScript, exactConptyAgent: p.ExactConptyAgent, exactConoutWorker: p.ExactConoutWorker, sameAsParent: p.SameAsParent, expectedPtyHelper: isExpectedPtyHelper(p), exe: p.Exe })) });

    await win.evaluate((i) => term.input(i, 'q\r'), termId).catch(() => {});
    await sleep(800);
    return result;
  } finally {
    await closeApp(ctx, h);
  }
}

async function caseS1(ctx) {
  for (const lang of ctx.langs()) {
    await statusLineCase(ctx, { id: 'S1', label: 'S1 ' + lang, lang, homeName: 's1-' + lang, expectStatusLine: true });
  }
}
// S2, automated half: the stand-in refreshes the status line every 5 s for N minutes through the real
// Git Bash + bridge; FanBox must never grow a second window / main process and every refresh stays fast.
// (The other half, a real Claude Code session with --debug, is a MANUAL step.)
async function caseS2(ctx) {
  const minutes = ctx.opts.soak > 0 ? ctx.opts.soak : 10;
  await statusLineCase(ctx, { id: 'S2', label: 'S2 soak ' + minutes + ' min', lang: 'zh', homeName: 's2-soak', expectStatusLine: true, soak: minutes });
}
async function caseS5(ctx) {
  await statusLineCase(ctx, { id: 'S5', label: 'S5 no Git', lang: 'zh', homeName: 's5', expectStatusLine: false, hideGit: true });
}
async function caseS6(ctx) {
  // homes below <base>\fanbox test\ : a space in the parent, CJK in the home itself; and an apostrophe
  await statusLineCase(ctx, { id: 'S6', label: 'S6 space+CJK home', lang: 'zh', homeName: path.join('fanbox test', '用户'), expectStatusLine: true });
  await statusLineCase(ctx, { id: 'S6', label: 'S6 apostrophe home', lang: 'zh', homeName: path.join('fanbox test', "o'brien"), expectStatusLine: true, apostrophe: true });
}

// ---------------------------------------------------------------------------
// Usage panel fixtures (U1 / U2 / U3 / U5 / U7). `page` is any Playwright page that has usagePanel.
// ---------------------------------------------------------------------------
function usageFixtures() {
  const now = Date.now();
  const bucket = (n) => ({ input: 20 * n, output: 10 * n, cacheRead: 80 * n, cacheCreate: 5 * n, reasoning: 3 * n, reasoningAvailable: true, total: 115 * n });
  const toks = (n) => ({ last5h: bucket(n), today: bucket(n + 1), week: bucket(n + 2) });
  const reset = (sec) => Math.floor(now / 1000) + sec;
  const live = () => ({ fiveHour: { usedPercent: SAMPLE.five, resetsAt: reset(3 * 3600) }, sevenDay: { usedPercent: SAMPLE.seven, resetsAt: reset(3 * 86400) }, source: 'statusline', capturedAt: now, stale: false });
  return [
    { id: 'pro-weekly', plan: 'U1', data: { ok: true, codex: { ...toks(1), planType: 'pro', source: 'official', capturedAt: now, primary: { usedPercent: 87, windowMinutes: 10080, resetsAt: reset(2 * 86400) }, resets: { available: 1, applicable: 0 } }, claude: { ...toks(2), official: live() } },
      expect: ['周额度', '87%', '官方数据 · 刚刚', '重置卡：1张 · 当前适用0张', '失效时间、使用记录：接口未提供', 'token明细与缓存命中率', '5h窗口', '23%', '42%', 'CLI实时回传 · 刚刚', '近5h', '今日', '近7天'],
      codexMustNotHave: ['5h窗口'] },
    { id: 'plus-dual', plan: 'U1', data: { ok: true, codex: { ...toks(1), planType: 'plus', source: 'snapshot', capturedAt: now, primary: { usedPercent: 50, windowMinutes: 300, resetsAt: reset(7200) }, secondary: { usedPercent: 90, windowMinutes: 10080, stale: true } } },
      expect: ['5h窗口', '50%', '周额度：待更新（旧窗口已结束）', '会话快照 · 刚刚', '重置卡信息暂不可用'], forbid: ['90%'] },
    { id: 'stale-last-good', plan: 'U3', data: { ok: true, claude: { ...toks(2), official: { fiveHour: { usedPercent: SAMPLE.five, resetsAt: reset(3 * 3600) }, sevenDay: { usedPercent: SAMPLE.seven, resetsAt: reset(3 * 86400) }, capturedAt: now - 10 * 60000, stale: true, error: '额度接口HTTP 429' } } },
      expect: ['5h窗口', '23%', '周额度', '42%', '额度接口HTTP 429', '官方数据 · 10 分钟前', '上次成功值'] },
    { id: 'snapshot-fallback', plan: 'U2', data: { ok: true, codex: { ...toks(1), planType: 'plus', source: 'snapshot', error: '未找到Codex登录凭证，使用本地快照', capturedAt: now - 12 * 60000, primary: { usedPercent: 37, windowMinutes: 300, resetsAt: reset(7200) }, secondary: { usedPercent: 62, windowMinutes: 10080, resetsAt: reset(3 * 86400) } } },
      expect: ['5h窗口', '37%', '周额度', '62%', '会话快照 · 12 分钟前', '未找到Codex登录凭证，使用本地快照', '重置卡信息暂不可用'] },
    { id: 'cli-live-claude', plan: 'U1', data: { ok: true, claude: { ...toks(2), official: live() } },
      expect: ['5h窗口', '23%', '周额度', '42%', 'CLI实时回传 · 刚刚', '近5h'] },
    { id: 'tokens-pending', plan: 'U6', data: { ok: true, tokensPending: true, claude: { official: live() } }, expect: ['正在统计本地token…'] },
    { id: 'tokens-unavailable', plan: 'U6', data: { ok: true, claude: { official: live() } }, expect: ['本地token统计暂不可用'] },
    ...['登录凭证已过期，请在CLI重新登录', '未找到有效登录凭证，请在Claude Code重新登录', '额度接口没有返回可识别的窗口', '网络连接失败或超时', '额度接口返回格式异常', '请求过于频繁，稍后自动重试', '额度接口HTTP 503']
      .map((err, i) => ({ id: 'error-' + (i + 1), plan: 'U7', data: { ok: true, claude: { official: { error: err, stale: true } } }, expect: [err] })),
    { id: 'codex-error', plan: 'U7', data: { ok: true, codex: { source: 'snapshot', error: '额度接口HTTP 403', primary: { usedPercent: 10, windowMinutes: 300, resetsAt: reset(3600) }, capturedAt: now } }, expect: ['额度接口HTTP 403', '10%'] },
  ];
}
const textOf = (page) => page.evaluate(() => document.querySelector('#usage-body').innerText);
async function quietPanel(page) {
  await waitFor(() => page.evaluate(() => !usagePanel.loading), 15000, 200);
  await page.evaluate(() => { clearInterval(usagePanel.timer); usagePanel.timer = null; clearTimeout(usagePanel.pendingTimer); usagePanel.refresh = async () => {}; });
}
async function runFixturePass(page, o) {
  const { tag, lang, dict } = o;
  const en = lang === 'en';
  const want = (z) => (en ? dict.enOf(z) : z);
  const ci = (s) => String(s).toLowerCase();
  for (const fx of usageFixtures()) {
    await page.evaluate((d) => usagePanel.render(d), fx.data);
    await sleep(90);
    const text = await textOf(page);
    const id = fx.plan === 'U7' || en ? 'U7' : fx.plan;
    const missing = [];
    for (const z of fx.expect) {
      const e = want(z);
      if (e === null) missing.push('no complete English dictionary entry for "' + z + '"');
      else if (!ci(text).includes(ci(e))) missing.push('"' + e + '" not shown');
    }
    for (const f of fx.forbid || []) if (text.includes(f)) missing.push('"' + f + '" must not be shown');
    for (const f of fx.codexMustNotHave || []) { const e = want(f); if (e && ci(text.split('Claude Code')[0]).includes(ci(e))) missing.push('Codex block must not show "' + e + '"'); }
    if (en && hasCjk(text)) missing.push('Chinese left in #usage-body: ' + (text.match(new RegExp(CJK.source + '+', 'g')) || []).slice(0, 4).join(' | '));
    check(id, missing.length === 0, `${tag}: fixture ${fx.id} (${lang})`, missing.length ? missing.join('; ') + ' || panel text: ' + trunc(text.replace(/\s+/g, ' '), 260) : trunc(text.replace(/\s+/g, ' '), 120));
  }
  // refresh failures keep the last content, or say so when there is none
  await page.evaluate((d) => usagePanel.render(d), usageFixtures()[0].data);
  await sleep(60);
  await page.evaluate(() => usagePanel.render(null));
  await sleep(90);
  let t = await textOf(page);
  let miss = [];
  const keepMsg = want('刷新失败，保留上次数据');
  if (keepMsg === null) miss.push('no English entry for 刷新失败，保留上次数据');
  else if (!ci(t).includes(ci(keepMsg))) miss.push('"' + keepMsg + '" not shown');
  if (!t.includes('87%')) miss.push('last values were dropped');
  if (en && hasCjk(t)) miss.push('Chinese left');
  check(en ? 'U7' : 'U3', miss.length === 0, `${tag}: failed refresh keeps the last values and says so (${lang})`, miss.join('; ') || trunc(t.replace(/\s+/g, ' '), 100));
  await page.evaluate(() => { document.querySelector('#usage-body').innerHTML = ''; usagePanel.render(null); });
  await sleep(90);
  t = await textOf(page);
  const emptyMsg = want('读取失败，稍后重试');
  miss = [];
  if (emptyMsg === null) miss.push('no English entry for 读取失败，稍后重试'); else if (!ci(t).includes(ci(emptyMsg))) miss.push('"' + emptyMsg + '" not shown');
  if (en && hasCjk(t)) miss.push('Chinese left');
  check(en ? 'U7' : 'U3', miss.length === 0, `${tag}: first load failure message (${lang})`, miss.join('; ') || trunc(t, 100));
}
async function runExpanders(page, o) {
  const { tag, lang, dict } = o;
  const en = lang === 'en';
  const data = usageFixtures()[0].data;
  await page.evaluate((d) => usagePanel.render(d), data);
  await sleep(90);
  for (const agent of ['codex', 'claude']) await page.locator(`.usage-detail[data-agent="${agent}"] summary`).click();
  await sleep(150);
  const opened = await page.evaluate(() => [...document.querySelectorAll('.usage-detail')].map((e) => ({ agent: e.dataset.agent, open: e.open })));
  check('U5', opened.length === 2 && opened.every((e) => e.open), `${tag}: both .usage-detail expanders open after clicking (${lang})`, JSON.stringify(opened));
  await page.evaluate((d) => usagePanel.render(d), data); // a refresh re-renders the whole panel
  await sleep(120);
  const after = await page.evaluate(() => [...document.querySelectorAll('.usage-detail')].map((e) => ({ agent: e.dataset.agent, open: e.open, periods: e.querySelectorAll('.usage-breakdown').length, rows: [...e.querySelectorAll('.usage-breakdown')].map((b) => b.querySelectorAll(':scope > div').length), hit: [...e.querySelectorAll('.usage-breakdown')].map((b) => (b.querySelector('strong') || {}).textContent) })));
  check('U5', after.length === 2 && after.every((e) => e.open), `${tag}: expanders stay open after the panel re-renders (${lang})`, JSON.stringify(after.map((e) => [e.agent, e.open])));
  check('U5', after.every((e) => e.periods === 3 && e.rows.every((n) => n === 6)), `${tag}: three periods, each with hit rate + five rows (${lang})`, JSON.stringify(after.map((e) => [e.agent, e.periods, e.rows])));
  check('U5', after.every((e) => e.hit.every((x) => x === '76.2%')), `${tag}: input cache hit rate = cache read / all input (80/105 = 76.2%)`, JSON.stringify(after.map((e) => e.hit)));
  const text = await textOf(page);
  if (en) {
    const rows = ['未缓存输入', '缓存读取', '缓存写入', '输出', '其中推理', '输入缓存命中率', '近5h', '今日', '近7天', 'token明细与缓存命中率'];
    const miss = rows.filter((z) => { const e = dict.enOf(z); return e === null || !text.toLowerCase().includes(e.toLowerCase()); });
    check('U7', !hasCjk(text), `${tag}: expanded breakdown has no Chinese`, (text.match(new RegExp(CJK.source + '+', 'g')) || []).slice(0, 6).join(' | '));
    check('U7', miss.length === 0, `${tag}: breakdown labels use the dictionary's English`, miss.join(', '));
  } else {
    check('U5', ['未缓存输入', '缓存读取', '缓存写入', '输出', '其中推理', '输入缓存命中率'].every((s) => text.includes(s)), `${tag}: breakdown rows present (zh)`, trunc(text.replace(/\s+/g, ' '), 140));
  }
  const overflow = await page.evaluate(() => { const b = document.querySelector('#usage-body'); return b.scrollWidth > b.clientWidth; });
  check(en ? 'U7' : 'U5', overflow === false, `${tag}: #usage-body has no horizontal overflow (${lang})`, '');
}
async function switchLang(page, to) {
  const cur = await page.evaluate(() => window.fanboxLang);
  if (cur === to) return;
  await page.evaluate(() => document.getElementById('lang-toggle').click());
  await waitFor(async () => (await page.evaluate(() => window.fanboxLang).catch(() => null)) === to, 20000, 400);
  await page.waitForFunction(() => typeof usagePanel !== 'undefined' && !!document.querySelector('#usage-body'), null, { timeout: 20000 });
  await sleep(1500);
}

async function caseUF(ctx) {
  const id = 'UF';
  const home = ctx.freshHome('uf', 'zh');
  // generated logs: small Claude tree for token numbers + Codex sessions with a rate-limit snapshot, NO auth.json
  const cm = gen.genClaudeTree({ home, mb: 24 });
  const xm = gen.genCodex({ home });
  const h = await launchApp(ctx, { home, lang: 'zh', usage: true, label: 'UF' });
  try {
    const win = h.win;
    // ---- U2 (automated variant): the sandbox profile has no Codex auth.json ----
    check('U2', !fs.existsSync(path.join(home, '.codex', 'auth.json')), 'U2: sandbox ~/.codex has no auth.json', path.join(home, '.codex'));
    const shown = await waitFor(async () => { await win.evaluate(() => usagePanel.refresh()); const t = await textOf(win); return /未找到Codex登录凭证，使用本地快照/.test(t) && /正在统计/.test(t) === false ? t : null; }, 90000, 2000);
    check('U2', !!shown, 'U2: Codex shows 会话快照 and 未找到Codex登录凭证，使用本地快照 (no auth.json), tokens counted', shown ? trunc(shown.replace(/\s+/g, ' '), 260) : trunc(await textOf(win), 200));
    const real = await win.evaluate(() => fetch('/api/agent-usage').then((r) => r.json()));
    check('U2', !!real.codex && real.codex.source === 'snapshot' && real.codex.planType === 'plus' && real.codex.primary && real.codex.primary.windowMinutes === 300 && real.codex.secondary && real.codex.secondary.windowMinutes === 10080, 'U2: snapshot carries plan "plus", a 300-minute and a 10080-minute window', JSON.stringify(real.codex && { s: real.codex.source, p: real.codex.planType, a: real.codex.primary && real.codex.primary.windowMinutes, b: real.codex.secondary && real.codex.secondary.windowMinutes }));
    const age = Date.now() - cm.generatedAt;
    const c = real.claude || {};
    check('U2', c.week && c.week.total > 0 && c.last5h && c.today, 'U2: Claude token numbers arrived from the generated logs', c.week && JSON.stringify({ week: c.week.total, files: c.files }));
    if (age < 12 * 60000) {
      check('U2', c.week.total === cm.windows.week.total && c.today.total === cm.windows.today.total && c.last5h.total === cm.windows.last5h.total, 'U2: Claude totals equal the generator\'s ground truth (dedupe, subagents, old files excluded)', JSON.stringify({ got: [c.last5h.total, c.today.total, c.week.total], want: [cm.windows.last5h.total, cm.windows.today.total, cm.windows.week.total] }));
      const x = real.codex || {};
      check('U2', x.week && x.week.total === xm.windows.week.total && x.today.total === xm.windows.today.total, 'U2: Codex totals equal the generator\'s ground truth', JSON.stringify({ got: [x.today && x.today.total, x.week && x.week.total], want: [xm.windows.today.total, xm.windows.week.total] }));
    } else warn('U2', 'ground-truth comparison skipped: fixtures older than 12 minutes (windows may have moved)', Math.round(age / 60000) + ' min');
    await win.screenshot({ path: ctx.evidence('uf-real-zh.png', '') }).catch(() => {});

    // ---- fixtures, Chinese ----
    await quietPanel(win);
    await runFixturePass(win, { tag: 'UF', lang: 'zh', dict: ctx.dict });
    await runExpanders(win, { tag: 'UF', lang: 'zh', dict: ctx.dict });
    await win.screenshot({ path: ctx.evidence('uf-fixture-zh.png', '') }).catch(() => {});

    // ---- U7: the app's own language toggle, then the real data and the fixtures again ----
    await switchLang(win, 'en');
    const realEn = await waitFor(async () => { await win.evaluate(() => usagePanel.refresh()); const t = await textOf(win); return /Codex/.test(t) && /Claude Code/.test(t) ? t : null; }, 60000, 2000);
    check('U7', !!realEn && !hasCjk(realEn), 'U7: real panel data in English has no Chinese (incl. the snapshot-fallback error line)', realEn ? (hasCjk(realEn) ? (realEn.match(new RegExp(CJK.source + '+', 'g')) || []).join(' | ') : trunc(realEn.replace(/\s+/g, ' '), 200)) : 'panel not rendered');
    const snapEn = ctx.dict.enOf('未找到Codex登录凭证，使用本地快照');
    check('U7', !!snapEn && !!realEn && realEn.toLowerCase().includes(snapEn.toLowerCase()), 'U7: the snapshot-fallback line reads "' + snapEn + '"', '');
    await win.screenshot({ path: ctx.evidence('uf-real-en.png', '') }).catch(() => {});
    await quietPanel(win);
    await runFixturePass(win, { tag: 'UF', lang: 'en', dict: ctx.dict });
    await runExpanders(win, { tag: 'UF', lang: 'en', dict: ctx.dict });
    await win.screenshot({ path: ctx.evidence('uf-fixture-en.png', '') }).catch(() => {});
    check('U5', h.errors.length === 0, 'UF: no renderer exceptions while exercising the panel', h.errors.slice(0, 3).join(' | '));
  } finally { await closeApp(ctx, h); }
}

// ---------------------------------------------------------------------------
// U6: large Claude log tree
// ---------------------------------------------------------------------------
async function caseU6(ctx) {
  const id = 'U6';
  const home = ctx.freshHome('u6', 'zh');
  const t0 = Date.now();
  info(id, 'generating the Claude log tree', `${ctx.opts.claudeMb} MB under ${path.join(home, '.claude', 'projects')}`);
  const cm = gen.genClaudeTree({ home, mb: ctx.opts.claudeMb, seed: 7 });
  info(id, 'fixture ready', `${(cm.bytes / 1048576).toFixed(0)} MB, ${cm.files} files, ${cm.uniqueMessages} messages, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  gen.genCodex({ home });
  const h = await launchApp(ctx, { home, lang: 'zh', usage: false, perf: true, label: 'U6' });
  try {
    const win = h.win;
    await win.evaluate(async () => { await term.newTab(state.home); });
    await sleep(1500);
    const termId = await win.evaluate(() => term.active);
    const ready = await win.evaluate((i) => window.__fbLib.waitPrompt(i, 30000), termId);
    if (!ready) warn(id, 'U6: no shell prompt detected in the terminal before the probes started (first echo samples may be slow)', '');
    await win.evaluate(() => { window.__u6 ={ seenPending: null, firstTrio: null, t0: performance.now() }; clearInterval(window.__u6timer); window.__u6timer = setInterval(() => { const b = document.querySelector('#usage-body'); const s = window.__u6; const now = Math.round(performance.now() - s.t0); const txt = b ? b.innerText : ''; if (s.seenPending === null && txt.includes('正在统计本地token')) s.seenPending = now; if (s.firstTrio === null && b && b.querySelector('.usage-trio')) s.firstTrio = now; }, 100); });
    await startNativeFrameProbe(h.app);
    await win.evaluate(() => window.__fbLib.startFrames());
    const probeP = win.evaluate(([i]) => { window.__probeP = window.__fbLib.probe(i, 75000, 600); return true; }, [termId]);
    await probeP;
    await win.evaluate(() => { localStorage.setItem('fb_usage_open', '1'); usagePanel.apply(); });
    const numbers = await waitFor(() => win.evaluate(() => window.__u6.firstTrio !== null), 120000, 500);
    const timing = await win.evaluate(() => window.__u6);
    const probe = await win.evaluate(() => window.__probeP);
    const frames = await win.evaluate(() => window.__fbLib.stopFrames());
    const nativeWindow = await stopNativeFrameProbe(h.app);
    await win.evaluate(() => clearInterval(window.__u6timer));
    ctx.evidence('u6-perf.json', { fixture: { mb: ctx.opts.claudeMb, files: cm.files, messages: cm.uniqueMessages }, timing, frames, probe, nativeWindow });
    check(id, timing.seenPending !== null, 'U6: panel showed 正在统计本地token… while counting', `first seen at ${timing.seenPending} ms after the panel opened`);
    if (timing.seenPending === null) warn(id, 'U6: the pending text never appeared (stats finished before the first paint, or the tree is too small)', `numbers after ${timing.firstTrio} ms`);
    check(id, !!numbers, 'U6: token numbers arrived', `numbers at ${timing.firstTrio} ms`);
    const usage = await win.evaluate(() => fetch('/api/agent-usage').then((r) => r.json()));
    const c = usage.claude || {};
    const age = Date.now() - cm.generatedAt;
    if (age < 12 * 60000 && cm.windows.week) check(id, c.week && c.week.total === cm.windows.week.total, 'U6: week total equals the generator\'s ground truth', JSON.stringify({ got: c.week && c.week.total, want: cm.windows.week.total }));
    else check(id, c.week && c.week.total > 0, 'U6: week total is non-zero', JSON.stringify(c.week && c.week.total));
    info(id, 'renderer frame gaps', JSON.stringify({ maxMs: frames.max, over50ms: frames.over50, seconds: frames.seconds, frames: frames.frames }));
    // 500 ms = a visible freeze (30 frames at 60 Hz); a main-thread scan of this size, as before the worker, produces multi-second gaps
    if (!validFrameWindow(id, nativeWindow)) info(id, 'Frame timing is invalid due to native window state; raw measurements retained', frames.max + ' ms');
    else if (frames.max <= 250) check(id, true, 'U6: worst requestAnimationFrame gap while stats were computed', frames.max + ' ms (limit 500)');
    else if (frames.max <= 500) warn(id, 'U6: worst requestAnimationFrame gap between 250 and 500 ms', frames.max + ' ms (limit 500)');
    else check(id, false, 'U6: worst requestAnimationFrame gap over 500 ms (renderer froze)', frames.max + ' ms; gaps ' + JSON.stringify(frames.gaps.slice(0, 6)));
    check(id, probe && !probe.error && probe.n >= 10, 'U6: terminal echo probes ran', JSON.stringify(probe && { n: probe.n, timeouts: probe.timeouts }));
    if (probe && probe.max !== null) {
      if (probe.timeouts > 0 || probe.max > 1000) check(id, false, 'U6: typing in a terminal tab stayed responsive (echo <= 1 s)', JSON.stringify({ max: probe.max, p95: probe.p95, timeouts: probe.timeouts }));
      else if (probe.max > 500) warn(id, 'U6: slowest keystroke echo between 500 ms and 1 s', JSON.stringify({ max: probe.max, p95: probe.p95, median: probe.median }));
      else check(id, true, 'U6: typing in a terminal tab stayed responsive (echo <= 500 ms)', JSON.stringify({ max: probe.max, p95: probe.p95, median: probe.median }));
    }
    await win.screenshot({ path: ctx.evidence('u6-panel.png', '') }).catch(() => {});
    // ---- U5 (real timer): expand both, wait for the next 60 s refresh, expanders stay open ----
    if (numbers) {
      await win.evaluate(() => { window.__renders = 0; const r = usagePanel.render.bind(usagePanel); usagePanel.render = (d) => { window.__renders++; return r(d); }; });
      for (const agent of ['codex', 'claude']) { const sel = `.usage-detail[data-agent="${agent}"] summary`; if (await win.locator(sel).count()) await win.locator(sel).click(); }
      await sleep(300);
      const open0 = await win.evaluate(() => [...document.querySelectorAll('.usage-detail')].filter((e) => e.open).length);
      const refreshed = await waitFor(() => win.evaluate(() => window.__renders >= 1), 80000, 1000);
      await sleep(1500);
      const rows = await win.evaluate(() => [...document.querySelectorAll('.usage-detail')].map((e) => ({ a: e.dataset.agent, open: e.open, periods: e.querySelectorAll('.usage-breakdown').length, rows: [...e.querySelectorAll('.usage-breakdown')].map((b) => b.querySelectorAll(':scope > div').length) })));
      check('U5', !!refreshed && open0 >= 1 && rows.filter((r) => r.open).length === open0, 'U5: expanders stay open after a real 60-second refresh', JSON.stringify({ opened: open0, rendersSeen: !!refreshed, rows }));
      check('U5', rows.filter((r) => r.open).every((r) => r.periods === 3 && r.rows.every((n) => n === 6)), 'U5: each open expander shows three periods x (hit rate + five rows) after the refresh', JSON.stringify(rows));
    }
  } finally { await closeApp(ctx, h); }
}

// ---------------------------------------------------------------------------
// W1 / W2 / W4
// ---------------------------------------------------------------------------
const RECYCLE_PS = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:FB_DEL, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)";
function runChild(script, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script].concat(args), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => { let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* */ } resolve({ code, json, out, err }); });
    c.on('error', (e) => resolve({ code: -1, json: null, out, err: String(e.message) }));
  });
}
async function caseW(ctx) {
  const home = ctx.freshHome('w', 'zh');
  const proj = path.join(home, 'work', 'w-proj');
  for (const d of ['sub', 'burst', path.join('node_modules', 'pkg')]) fs.mkdirSync(path.join(proj, d), { recursive: true });
  for (const [f, c] of [['hello.txt', 'hello\n'], ['rewrite-me.txt', 'same content\n'], ['w4-delete-me.txt', 'bye\n']]) fs.writeFileSync(path.join(proj, f), c);
  const h = await launchApp(ctx, { home, lang: 'zh', perf: true, label: 'W' });
  try {
    const win = h.win;
    await win.evaluate(async (p) => { await navigate(p); await term.newTab(p); }, proj);
    await sleep(1500);
    const termId = await win.evaluate(() => term.active);
    if (!(await win.evaluate((i) => window.__fbLib.waitPrompt(i, 30000), termId))) warn('W1', 'W: no shell prompt detected in the terminal before the probes started', '');
    await win.evaluate(() => {
      window.__fbw ={ msgs: [], t0: performance.now() };
      window.fanboxFs.onChanged((m) => window.__fbw.msgs.push({ t: Math.round(performance.now() - window.__fbw.t0), dir: m.dir, f: m.filename, o: !!m.overflow }));
      state.changeLog.length = 0; state.changeTimeline.length = 0;
    });
    await sleep(1500);
    const burstDir = path.join(proj, 'burst'), sentinel = path.join(proj, 'burst-done.txt');
    const gens = path.join(__dirname, 'gen-fixtures.js');

    // ---- W1: 2,000 files in ~8 s from a child process ----
    await startNativeFrameProbe(h.app);
    await win.evaluate(([dir, i]) => { window.__fbLib.startFrames(); window.__fbLib.watchCard(dir); window.__w1Probe = window.__fbLib.probe(i, 11500, 600); return true; }, [burstDir, termId]);
    const t0 = Date.now();
    const burst = await runChild(gens, ['burst', '--dir', burstDir, '--count', '2000', '--seconds', '8', '--dirs', '8', '--sentinel', sentinel]);
    const tEnd = Date.now();
    check('W1', burst.code === 0 && !!burst.json && burst.json.count === 2000, 'W1: burst writer wrote 2,000 files', JSON.stringify(burst.json || burst.err));
    if (burst.json && burst.json.elapsedMs >= 10000) warn('W1', 'W1: this machine took 10 s or more to write the 2,000 files (the plan says within 10 s); the burst was slower than specified, not FanBox', burst.json.elapsedMs + ' ms');
    const caughtUp = await waitFor(() => win.evaluate((p) => [...document.querySelectorAll('#file-area [data-path]')].some((e) => String(e.dataset.path).toLowerCase() === p.toLowerCase()), sentinel), 10000, 100);
    const catchMs = caughtUp ? Date.now() - tEnd : null;
    if (catchMs !== null && catchMs <= 2000) check('W1', true, 'W1: file list caught up (burst-done.txt card present) within 2 s after the burst', catchMs + ' ms');
    else if (catchMs !== null && catchMs <= 3000) warn('W1', 'W1: file list caught up 2-3 s after the burst (target about 2 s)', catchMs + ' ms');
    else check('W1', false, 'W1: file list caught up after the burst', catchMs === null ? 'burst-done.txt card never appeared' : catchMs + ' ms');
    const probe = await win.evaluate(() => window.__w1Probe);
    const frames = await win.evaluate(() => window.__fbLib.stopFrames());
    const nativeWindow = await stopNativeFrameProbe(h.app);
    const card = await win.evaluate(() => window.__fbLib.stopCard());
    const nmsgs = await win.evaluate(() => window.__fbw.msgs.length);
    ctx.evidence('w1-perf.json', { burst: burst.json, catchUpMs: catchMs, frames, probe, card, nativeWindow, rendererNotifications: nmsgs, burstWallMs: tEnd - t0 });
    info('W1', 'renderer frame gaps during the burst', JSON.stringify({ maxMs: frames.max, over50: frames.over50, frames: frames.frames, seconds: frames.seconds }));
    if (!validFrameWindow('W1', nativeWindow)) info('W1', 'Frame timing is invalid due to native window state; raw measurements retained', frames.max + ' ms');
    else if (frames.max <= 250) check('W1', true, 'W1: worst requestAnimationFrame gap during the burst', frames.max + ' ms (limit 500)');
    else if (frames.max <= 500) warn('W1', 'W1: worst requestAnimationFrame gap between 250 and 500 ms', frames.max + ' ms');
    else check('W1', false, 'W1: worst requestAnimationFrame gap over 500 ms', frames.max + ' ms; gaps ' + JSON.stringify(frames.gaps.slice(0, 6)));
    if (probe && probe.max !== null && probe.n >= 5) {
      if (probe.timeouts > 0 || probe.max > 1000) check('W1', false, 'W1: typing in another terminal tab stayed responsive during the burst (echo <= 1 s)', JSON.stringify({ max: probe.max, p95: probe.p95, timeouts: probe.timeouts }));
      else if (probe.max > 500) warn('W1', 'W1: slowest keystroke echo during the burst between 500 ms and 1 s', JSON.stringify({ max: probe.max, p95: probe.p95 }));
      else check('W1', true, 'W1: typing in another terminal tab stayed responsive during the burst (echo <= 500 ms)', JSON.stringify({ max: probe.max, p95: probe.p95, median: probe.median, n: probe.n }));
    } else check('W1', false, 'W1: terminal echo probes ran', JSON.stringify(probe));
    check('W1', card && card.seen && card.maxHeat > 0, 'W1: the burst card (folder) lit up with heat while files were written', JSON.stringify(card && { seen: card.seen, maxHeat: card.maxHeat, label: card.label }));
    check('W1', card && card.changeLogMax > 0 && card.badgeSeen && card.timelineMax > 0, 'W1: 本回合 / 本会话变更 entries appeared (changeLog, timeline, #changes-badge)', JSON.stringify(card && { changeLog: card.changeLogMax, timeline: card.timelineMax, badge: card.badgeSeen }));
    info('W1', 'raw change notifications the renderer received for 2,000 writes', String(nmsgs));
    await win.screenshot({ path: ctx.evidence('w1-after-burst.png', '') }).catch(() => {});

    // ---- W2: 100 identical rewrites ----
    await sleep(3000);
    const rewrite = path.join(proj, 'rewrite-me.txt');
    const mark0 = await win.evaluate(() => window.__fbw.msgs.length);
    const rw = await runChild(gens, ['rewrite', '--file', rewrite, '--times', '100']);
    await sleep(2800);
    const hits = await win.evaluate(([n, name]) => window.__fbw.msgs.slice(n).filter((m) => String(m.f || '').toLowerCase() === name).length, [mark0, 'rewrite-me.txt']);
    const maxAllowed = Math.min(5, Math.floor((rw.json ? rw.json.elapsedMs : 0) / 400) + 2);
    info('W2', '100 identical rewrites', JSON.stringify({ elapsedMs: rw.json && rw.json.elapsedMs, notifications: hits, allowed: maxAllowed }));
    check('W2', rw.code === 0 && hits >= 1 && hits <= maxAllowed, 'W2: 100 identical rewrites produced ' + hits + ' change notification(s), not 100 (one per 400 ms batching window at most; ideal 1)', JSON.stringify({ elapsedMs: rw.json && rw.json.elapsedMs, hits, maxAllowed }));
    if (hits > 1) warn('W2', 'W2: more than one notification (the rewrites spanned a batching window boundary)', `${hits} notifications over ${rw.json && rw.json.elapsedMs} ms`);

    // ---- W4: Recycle Bin delete, node_modules (silent), sub\a.ts (lights up sub) ----
    await sleep(1500);
    const mark1 = await win.evaluate(() => { state.changeLog.length = 0; state.changeTimeline.length = 0; return window.__fbw.msgs.length; });
    fs.writeFileSync(path.join(proj, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await sleep(2000);
    const nm = await win.evaluate(([n]) => ({ msgs: window.__fbw.msgs.slice(n).filter((m) => /node_modules/i.test(String(m.f || ''))).length, changed: state.changed.has('node_modules'), log: state.changeLog.some((c) => /node_modules/i.test(c.path)) }), [mark1]);
    check('W4', nm.msgs === 0 && !nm.changed && !nm.log, 'W4: a write into node_modules stays silent (no notification, no heat, no change entry)', JSON.stringify(nm));
    fs.writeFileSync(path.join(proj, 'sub', 'a.ts'), 'export const a = 1;\n');
    const sub = await waitFor(() => win.evaluate(([n]) => { const hit = window.__fbw.msgs.slice(n).some((m) => /^sub[\\/]a\.ts$/i.test(String(m.f || ''))); const rec = state.changed.get('sub'); return hit && rec ? { count: rec.count, files: [...rec.files] } : null; }, [mark1]), 8000, 300);
    check('W4', !!sub, 'W4: sub\\a.ts is reported and `sub` lights up (state.changed has "sub")', JSON.stringify(sub));
    const subCard = await win.evaluate((p) => { const el = [...document.querySelectorAll('#file-area [data-path]')].find((e) => String(e.dataset.path).toLowerCase() === p.toLowerCase()); return el ? { cls: el.className, heat: el.style.getPropertyValue('--heat'), tag: el.dataset.changed || '' } : null; }, path.join(proj, 'sub'));
    check('W4', !!subCard && /changed|live-edit/.test(subCard.cls), 'W4: the sub folder card is highlighted', JSON.stringify(subCard));
    const del = path.join(proj, 'w4-delete-me.txt');
    const rb = await new Promise((resolve) => execFile(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RECYCLE_PS], { windowsHide: true, timeout: 30000, env: Object.assign({}, process.env, { FB_DEL: del }) }, (e, out, err) => resolve({ err: e ? String(err || e.message) : '' })));
    check('W4', !rb.err && !fs.existsSync(del), 'W4: file moved to the Recycle Bin through the shell API (same call FanBox uses; empty the bin afterwards if you like)', rb.err || '');
    const gone = await waitFor(() => win.evaluate(([n]) => window.__fbw.msgs.slice(n).some((m) => String(m.f || '').toLowerCase() === 'w4-delete-me.txt') && state.changeLog.some((c) => /w4-delete-me\.txt$/i.test(c.path)), [mark1]), 8000, 300);
    check('W4', !!gone, 'W4: the Recycle Bin delete shows as a change', '');
    check('W4', h.errors.length === 0, 'W: no renderer exceptions during the bursts', h.errors.slice(0, 3).join(' | '));
  } finally { await closeApp(ctx, h); }
}

// ---------------------------------------------------------------------------
// R1: update-check failure dialog
// ---------------------------------------------------------------------------
async function caseR1(ctx) {
  const home = ctx.freshHome('r1', 'zh');
  const h = await launchApp(ctx, { home, lang: 'zh', usage: false, label: 'R1', offlineUpdate: true });
  try {
    const { app, win } = h;
    const patched = await app.evaluate(({ dialog, shell }) => {
      global.__r1 = { dialogs: [], opened: [], ret: 1 };
      const patch = (obj, key, fn) => {
        try { obj[key] = fn; if (obj[key] === fn) return true; } catch (e) { /* read-only: try defineProperty */ }
        try { Object.defineProperty(obj, key, { value: fn, configurable: true, writable: true }); return obj[key] === fn; } catch (e) { return false; }
      };
      const dlg = patch(dialog, 'showMessageBoxSync', (...a) => {
        const o = a.find((x) => x && typeof x === 'object' && 'message' in x) || {};
        global.__r1.dialogs.push({ type: o.type, message: o.message, detail: o.detail, buttons: o.buttons, defaultId: o.defaultId, cancelId: o.cancelId });
        return global.__r1.ret;
      });
      const ext = patch(shell, 'openExternal', (u) => { global.__r1.opened.push(String(u)); return Promise.resolve(); });
      return { dialog: dlg, shell: ext };
    });
    check('R1', patched.dialog && patched.shell, 'R1: main-process spies installed (dialog.showMessageBoxSync, shell.openExternal)', JSON.stringify(patched));
    if (!(patched.dialog && patched.shell)) return;
    const all = [];
    for (const lang of ctx.langs()) {
      const r = await win.evaluate((l) => apiPost('/api/lang', { lang: l }), lang);
      check('R1', !!r && r.ok && r.lang === lang, `R1: FanBox language set to ${lang} (config.json)`, JSON.stringify(r));
      for (const choice of [1, 0]) {
        await app.evaluate((_, c) => { global.__r1.dialogs = []; global.__r1.opened = []; global.__r1.ret = c; }, choice);
        const found = await app.evaluate(({ Menu }) => {
          const walk = (items) => { for (const it of items) { if (/^(检查更新…|Check for Updates…)$/.test(it.label || '')) return it; if (it.submenu) { const r = walk(it.submenu.items); if (r) return r; } } return null; };
          const item = walk(Menu.getApplicationMenu().items);
          if (!item) return false;
          item.click();
          return true;
        });
        check('R1', found, `R1 ${lang}: the 检查更新… / Check for Updates… menu item exists and was clicked`, '');
        const got = await waitFor(() => app.evaluate(() => (global.__r1.dialogs.length ? JSON.parse(JSON.stringify(global.__r1)) : null)), 60000, 400);
        await sleep(400);
        const final = await app.evaluate(() => JSON.parse(JSON.stringify(global.__r1)));
        all.push({ lang, choice, final });
        const d = got && final.dialogs[0];
        check('R1', !!d, `R1 ${lang}: the failure dialog appeared (network forced offline)`, d ? '' : 'no dialog within 60 s');
        if (!d) continue;
        const wantMsg = lang === 'zh' ? '检查更新失败' : 'Update check failed';
        const wantBtns = lang === 'zh' ? ['打开下载页', '关闭'] : ['Open download page', 'Close'];
        const lines = String(d.detail || '').split('\n');
        if (choice === 1) {
          check('R1', d.message === wantMsg, `R1 ${lang}: message is "${wantMsg}"`, d.message);
          check('R1', JSON.stringify(d.buttons) === JSON.stringify(wantBtns), `R1 ${lang}: buttons are ${JSON.stringify(wantBtns)}`, JSON.stringify(d.buttons));
          check('R1', lines.length === 2 && lines[0].trim().length > 0 && lines[1] === FORK_RELEASES, 'R1 ' + lang + ': detail = <reason>\\n' + FORK_RELEASES, JSON.stringify(d.detail));
          if (lang === 'en') check('R1', !hasCjk(d.message + ' ' + d.detail + ' ' + (d.buttons || []).join(' ')), 'R1 en: no Chinese anywhere in the dialog (reason follows the UI language)', d.detail);
          else check('R1', hasCjk(lines[0]) && /GitHub API/.test(lines[0]), 'R1 zh: reason is upstream\'s Chinese text (GitHub API…)', lines[0]);
          check('R1', final.opened.length === 0, `R1 ${lang}: choosing Close opens nothing`, JSON.stringify(final.opened));
        } else {
          check('R1', final.opened.length === 1 && final.opened[0] === FORK_RELEASES, `R1 ${lang}: choosing button 0 opens exactly ${FORK_RELEASES}`, JSON.stringify(final.opened));
        }
      }
    }
    ctx.evidence('r1-dialogs.json', all);
    const proxyLog = path.join(home, 'r1-proxy.log');
    if (fs.existsSync(proxyLog)) ctx.evidence('r1-proxy.log', fs.readFileSync(proxyLog));
    await win.evaluate(() => apiPost('/api/lang', { lang: 'zh' })).catch(() => {});
  } finally { await closeApp(ctx, h); }
}

// ---------------------------------------------------------------------------
// X1: cheap regression subset
// ---------------------------------------------------------------------------
async function caseX1(ctx) {
  const id = 'X1';
  const home = ctx.freshHome('x1', 'zh');
  const project = path.join(home, 'work', 'x1-proj');
  fs.mkdirSync(project, { recursive: true });
  const h = await launchApp(ctx, { home, lang: 'zh', standin: true, fakeCodex: true, usage: false, label: 'X1' });
  try {
    const { win, app } = h;
    const hook = readHookFile(home);
    const env = await win.evaluate(() => ({ hooksReady: window.fanboxEnv.hooksReady, home: window.fanboxEnv.home }));
    check(id, env.hooksReady === true && !!hook.json, 'X1: hook file written at startup (fanboxEnv.hooksReady)', JSON.stringify(env));
    const events = Object.keys((hook.json && hook.json.hooks) || {});
    check(id, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'].every((e) => events.includes(e)) && events.every((e) => hook.json.hooks[e][0].hooks[0].type === 'http'), 'X1: all eight events are HTTP hooks on the app port', events.join(','));
    const token = await win.evaluate(() => window.fanboxEnv.ctlToken);
    check(id, !hook.raw.includes(token) && /"x-fanbox-token": "\$FANBOX_CTL_TOKEN"/.test(hook.raw), 'X1: no token literal in the hook file, x-fanbox-token: $FANBOX_CTL_TOKEN reference present', '');
    const codexCmd = await win.evaluate(() => agentLaunchCmd(AGENT_REGISTRY.find((a) => a.id === 'codex')));
    check(id, codexCmd === 'codex', 'X1: typed Codex command has no -c notify (argv spawn, never a shell string)', codexCmd);

    // Codex launched by FanBox gets notify as ONE argv slot (fake codex shim dumps its argv)
    const dumpFile = path.join(home, 'codex-argdump.json');
    try { fs.unlinkSync(dumpFile); } catch { /* none */ }
    const prompt = "backup logs & prune 'old'";
    await win.evaluate(async (a) => { await term.spawnCodexInDir(a.p, [a.x], 'x1'); }, { p: project, x: prompt });
    const dump = await waitFor(() => readJson(dumpFile), 20000, 300);
    const at = dump ? dump.indexOf('-c') : -1;
    const notify = at >= 0 ? dump[at + 1] : '';
    check(id, Array.isArray(dump) && at >= 0, 'X1: argv-spawned fake Codex received -c', dump ? JSON.stringify(dump) : 'no dump (is `node` on PATH for codex.cmd? FANBOX_STANDIN_NODE is used)');
    check(id, /^notify=\["[^"]+","[^"]+"\]$/.test(notify) && /codex-notify\.js/.test(notify), 'X1: Codex notify JSON is one intact argv slot', notify);
    check(id, dump && dump[dump.length - 1] === prompt, 'X1: a prompt with & and quotes arrives as its own slot', dump && dump[dump.length - 1]);

    // hooks round trip with the stand-in; permission prompt lights the tab and the 指挥台
    await win.evaluate(async (p) => { await navigate(p); }, project);
    await sleep(700);
    await win.evaluate(async () => { await term.newTab(state.home); });
    await sleep(1500);
    const idle = await win.evaluate(() => term.sessions[term.sessions.length - 1].id);
    await win.evaluate((i) => term.activate(i), idle);
    const { cmd, termId } = await oneClick(h, project);
    void cmd;
    const resultFile = path.join(home, 'standin-result.json');
    const rec = await waitFor(() => { const r = readJson(resultFile); return r && r.posted.some((p) => p.ev === 'Notification') ? r : null; }, 90000, 400);
    check(id, !!rec && rec.settingsOk && rec.posted.every((p) => p.status === 200), 'X1: hooks round trip (SessionStart .. Notification accepted, token + term headers interpolated)', rec ? JSON.stringify(rec.posted) : 'no result');
    const tid = rec ? rec.env.FANBOX_TERM_ID : termId;
    const list = await win.evaluate(() => fetch('/api/agent/terminals', { headers: { 'x-fanbox-token': CTL_TOKEN } }).then((r) => r.json()));
    const row = (list.terminals || []).find((t) => t.id === tid);
    check(id, !!row && row.hooked === true, 'X1: /api/agent/terminals reports the stand-in tab hooked:true', JSON.stringify(row));
    const ask = await waitFor(async () => (await win.evaluate((i) => { const s = term.sessions.find((x) => x.id === i); return s && s.evState; }, tid)) === 'needs_permission', 15000, 300);
    check(id, !!ask, 'X1: permission prompt reaches the renderer (evState needs_permission)', String(ask));
    const st = await win.evaluate((i) => { const s = term.sessions.find((x) => x.id === i); return { roster: roster.stateOf(s), glow: $('#terminal-panel').classList.contains('term-awaiting'), rosterHidden: $('#term-roster').classList.contains('hidden'), rows: [...document.querySelectorAll('#term-roster .tr-row')].map((r) => r.dataset.id) }; }, tid);
    check(id, st.roster === 'ask' && !st.rosterHidden && st.rows.includes(tid), 'X1: the tab shows 等你确认 in the 指挥台', JSON.stringify(st));
    check(id, st.glow === true, 'X1: the 「轮到你」 glow is on', String(st.glow));

    // Ctrl+Alt+M maximizes the terminal and restores it
    await win.evaluate((i) => term.activate(i), tid);
    await win.keyboard.press('Control+Alt+M'); await sleep(400);
    const m1 = await win.evaluate(() => term.maximized);
    await win.keyboard.press('Control+Alt+M'); await sleep(400);
    const m2 = await win.evaluate(() => term.maximized);
    check(id, m1 === true && m2 === false, 'X1: Ctrl+Alt+M maximizes then restores the terminal', m1 + '/' + m2);

    await win.evaluate((i) => term.input(i, 'q\r'), tid).catch(() => {});
    await sleep(600);
    check(id, h.errors.length === 0, 'X1: no renderer exceptions', h.errors.slice(0, 3).join(' | '));
    void app;
  } finally { await closeApp(ctx, h); }
}

// ---------------------------------------------------------------------------
// --launch: start the dev app in a persistent isolated profile for the MANUAL cases (no Playwright)
// ---------------------------------------------------------------------------
async function launchManual(ctx, name) {
  const home = ctx.homeFor('manual-' + String(name).replace(/[^\w.-]/g, '_'));
  ensureHome(home, ctx.realHome);
  const cfg = path.join(home, '.fanbox', 'config.json');
  for (const d of [path.join('AppData', 'Roaming'), path.join('AppData', 'Local'), '.fanbox', '.claude', '.codex', 'work']) fs.mkdirSync(path.join(home, d), { recursive: true });
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ lang: 'zh' }, null, 2) + '\n');
  const port = await freePorts(ctx.opts.port);
  const { env } = buildEnv({ baseEnv: process.env, home, port, nodeDir: path.dirname(process.execPath), extra: {} });
  const exe = require(path.join(ROOT, 'node_modules', 'electron'));
  console.log('# isolated profile: ' + home + '\n#   USERPROFILE / HOME / APPDATA / LOCALAPPDATA / CLAUDE_CONFIG_DIR / CODEX_HOME / --user-data-dir all point below it; FanBox port ' + port);
  console.log('#   sign Claude Code / Codex in inside FanBox\'s terminal if a case needs it (the logins stay in this folder). Close the FanBox window or press Ctrl+C here when done.');
  const child = spawn(exe, ['--user-data-dir=' + path.join(home, 'AppData', 'Roaming', 'FanBox-userdata'), ROOT], { cwd: ROOT, env, stdio: 'inherit', windowsHide: false });
  const stop = () => { killTreeSync(child.pid); };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('exit', stop);
  return new Promise((resolve) => child.on('close', () => resolve(0)));
}

// ---------------------------------------------------------------------------
// Manual cases: printed, never automated
// ---------------------------------------------------------------------------
const MANUAL = [
  { id: 'S2', group: 'S', title: 'A real Claude Code session of about 10 minutes (Pro or Max plan)',
    steps: ['Start the isolated profile: node experiments\\win-v2170-usage-202610\\playwright-electron.js --launch   (prints the profile folder; logins stay inside it).',
      'In FanBox open a terminal, run claude /login once if the sandbox profile is not signed in, then one-click 启动 Claude Code and add --debug to the command if you want the log (claude --debug writes a debug file; note its path).',
      'Keep the session working for about 10 minutes with Task Manager > Details open, sorted by name, watching FanBox.exe / electron.exe.'],
    expect: 'No second FanBox window ever appears; no extra FanBox.exe / electron.exe beyond the app\'s own; each status-line refresh in the debug log finishes in under 1 s. (The automated S2 soak with the stand-in covers FanBox\'s side: --soak 10.)' },
  { id: 'S3', group: 'S', title: 'Your own statusLine replaces the quota text (bash script, then PowerShell script)',
    steps: ['With the --launch profile, write <profile>\\.claude\\statusline.sh (for example: printf "my-bash-line\\n") and add to <profile>\\.claude\\settings.json: { "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" } }. Restart the Claude session launched from FanBox.',
      'Then change the command to: powershell -NoProfile -File C:/path/to/statusline.ps1 (a script printing my-ps-line). Restart the session again.'],
    expect: 'Your script\'s text replaces the quota text in both cases; the usage panel still receives live numbers (source line CLI实时回传).' },
  { id: 'S4', group: 'S', title: 'Plain `claude` typed by hand',
    steps: ['In a FanBox terminal tab of the --launch profile type claude and press Enter (no --settings).'],
    expect: 'Behaves as in 2.16.1: no FanBox quota line under the prompt; the tab falls back to the heuristic busy/idle detection.' },
  { id: 'U1', group: 'U', title: 'Codex signed in: official data (real network and login)',
    steps: ['Start the --launch profile, sign Codex in inside its terminal (codex login), then open the Agent 用量 panel in the sidebar.'],
    expect: 'The Codex row shows your plan; window names match it (a weekly limit reads 周额度, never 5h); the source line reads 官方数据. If it shows 会话快照 with an HTTP code instead, note the code: that answers the curl.exe question of D3. Also rename <profile>\\.codex\\auth.json away and back to see U2 (未找到Codex登录凭证，使用本地快照) with real logs.' },
  { id: 'U3', group: 'U', title: 'Network off, then back on (needs real credentials)',
    steps: ['With U1 working, disconnect the network and wait for a refresh (up to 60 s), then reconnect.'],
    expect: 'Old numbers stay, marked 上次成功值 with the reason; values recover on their own after reconnecting. (The automated UF case already checks this state\'s rendering from fixtures.)' },
  { id: 'U4', group: 'U', title: 'System proxy only, FanBox started from the Start menu',
    steps: ['Turn the Windows system proxy on, make sure no HTTP_PROXY / HTTPS_PROXY variables are set, and start FanBox the way a user does (installed build from the Start menu).'],
    expect: 'Official data still loads for Claude and Codex.' },
  { id: 'W3', group: 'W', title: 'Only opening and reading a file is not a change',
    steps: ['Start the --launch profile, open a project folder in FanBox, preview a file, open it in Explorer / Notepad and read it, close it again.'],
    expect: 'No "changed" marker on any card and nothing new in 本会话变更.' },
  { id: 'R2', group: 'R', title: 'Update offer after publishing',
    steps: ['After the draft release is published: run the campaign\'s pretend-2.16.1 build, then the real 2.17.0 build.'],
    expect: 'The older build offers 2.17.0 with 下载更新 (only when both exact files exist on the release); 2.17.0 reports up to date.' },
  { id: 'X1b', group: 'X', title: 'The rest of X1: rerun the 2.16.1 scripts (set FANBOX_MATRIX_ROOT / FANBOX_MATRIX_HOME for your machine)',
    steps: ['node experiments\\win-v2161-hooks-202609\\playwright-electron.js   (C1-C11 hooks, quit rules: quitting mid-turn asks, idle quit does not)',
      'node experiments\\win-v2161-hooks-202609\\gatec-process-files.js   (snapshot rollback E1-E5, process model)',
      'node experiments\\winport-parity-202607\\matrix\\phase3i-xss.js   (the Markdown XSS fixture stays inert)'],
    expect: 'Same results as on 2.16.1.' },
  { id: 'G1', group: 'G', title: 'Packages: install paths',
    steps: ['Install the NSIS build into a path with spaces and Chinese characters; run the portable build from another drive.'],
    expect: 'Both start; About shows 2.17.0; S1 passes from both (the portable\'s status line points at its unpacked copy).' },
  { id: 'G2', group: 'G', title: 'Package audit',
    steps: ['npx asar list <install>\\resources\\app.asar and look for lib\\ entries and for tests, docs, experiments, 发布 folders.'],
    expect: 'The archive contains lib/ (three files) and excludes tests/, 发布/, docs/, experiments/; the token breakdown appears in the packaged build (the background thread loads from inside the archive).' },
  { id: 'G3', group: 'G', title: 'Upgrade and uninstall',
    steps: ['Install 2.17.0 over an installed 2.16.1, then uninstall.'],
    expect: 'No duplicate shortcuts; profile kept; uninstall keeps ~/.fanbox.' },
];
function printManual(selectedGroups) {
  for (const m of MANUAL) {
    if (selectedGroups && !selectedGroups.has(m.group)) continue;
    console.log(`MANUAL: [${m.id}] ${m.title}`);
    m.steps.forEach((s, i) => console.log(`        ${i + 1}. ${s}`));
    console.log(`        Expect: ${m.expect}`);
    results.push({ id: m.id, status: 'MANUAL', name: m.title, detail: '', case: 'manual', at: new Date().toISOString() });
  }
}

const CASES = [
  { id: 'S1', group: 'S', plan: ['S1'], run: caseS1, desc: 'stand-in claude + real Git Bash status line (zh and en)' },
  { id: 'S2', group: 'S', plan: ['S2'], run: caseS2, optional: true, desc: 'stand-in status-line soak (--soak N minutes, default 10 when named): no second window / process, refreshes < 1 s' },
  { id: 'S5', group: 'S', plan: ['S5'], run: caseS5, desc: 'Git hidden: no statusLine, one-click still works' },
  { id: 'S6', group: 'S', plan: ['S6'], run: caseS6, desc: 'space+CJK and apostrophe homes run the quoted status line' },
  { id: 'UF', group: 'U', plan: ['U1', 'U2', 'U3', 'U5', 'U7'], run: caseUF, desc: 'usage panel: generated Codex logs, fixtures, expanders, English' },
  { id: 'U6', group: 'U', plan: ['U6'], run: caseU6, desc: 'large Claude log tree, renderer responsiveness' },
  { id: 'W', group: 'W', plan: ['W1', 'W2', 'W4'], run: caseW, desc: '2,000-file burst, identical rewrites, Recycle Bin, node_modules, sub\\a.ts' },
  { id: 'R1', group: 'R', plan: ['R1'], run: caseR1, desc: 'update-check failure dialog, both languages' },
  { id: 'X1', group: 'X', plan: ['X1'], run: caseX1, desc: 'regression subset' },
];
// Optional cases (the long soak) run only when named by id / plan id, or when --soak N is given.
function selectCases(only, soak) {
  if (!only) return CASES.filter((c) => !c.optional || soak > 0);
  return CASES.filter((c) => only.some((t) => t === c.id || c.plan.includes(t) || (t === c.group && (!c.optional || soak > 0))));
}

// ---------------------------------------------------------------------------
// --dry: platform-neutral self-test (any OS)
// ---------------------------------------------------------------------------
async function runDry(opts) {
  const D = 'DRY';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-v2170-dry-'));
  const sub = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
  try {
    // --- arguments
    const a = parseCli(['--only', 's1,u5', '--base=/x/y', '--lang', 'en', '--claude-mb', '5', '--port', '4800', '--keep', '--manual'], { FANBOX_V2170_EVIDENCE: '/ev' });
    check(D, JSON.stringify(a.only) === '["S1","U5"]' && a.base === '/x/y' && a.lang === 'en' && a.claudeMb === 5 && a.port === 4800 && a.keep && a.manual && a.out === '/ev' && a.bad.length === 0, 'args: --only/--base/--lang/--claude-mb/--port/--keep and env defaults parse', JSON.stringify(a));
    check(D, parseCli(['--bogus', '--lang', 'fr'], {}).bad.length === 2, 'args: unknown flags and a bad --lang are reported', '');
    const ids = (only, soak) => selectCases(only, soak).map((c) => c.id).join();
    check(D, ids(['S1', 'U5']) === 'S1,UF' && ids(['W2']) === 'W' && ids(['X']) === 'X1' && ids(['S']) === 'S1,S5,S6' && ids(['S'], 10) === 'S1,S2,S5,S6' && ids(['S2']) === 'S2' && ids(null) === 'S1,S5,S6,UF,U6,W,R1,X1' && ids(null, 10).includes('S2'),
      'cases: --only matches case ids, plan ids and groups; the soak case runs only when named or with --soak', [ids(['S1', 'U5']), ids(['S']), ids(null)].join(' | '));
    check(D, parseCli(['--soak', '3'], {}).soak === 3 && parseCli(['--soak', '999'], {}).bad.length === 1, 'args: --soak is validated', '');

    // --- pure helpers
    const csv = 'Pid,Ppid,Name,CmdKnown,Typed\r\n"10","1","electron.exe","1","0"\r\n"11","10","electron.exe","1","1"\r\n"12","10","powershell.exe","1","0"\r\n"13","12","bash.exe","1","0"\r\n"14","13","electron.exe","1","0"\r\n"15","13","node.exe","1","0"\r\n"20","1","electron.exe","1","0"\r\n';
    const table = csvObjects(csv);
    check(D, table.length === 7 && table[0].Name === 'electron.exe' && parseCsv('a,"b ""q"", c",d\n').flat().join('|') === 'a|b "q", c|d', 'csv: quoted fields and CRLF parse', JSON.stringify(parseCsv('a,"b ""q"", c",d\n')));
    const stray = strayMains(table, 10);
    check(D, stray.length === 1 && stray[0].Pid === '14', 'process census: the electron main spawned under bash is found, Chromium children and unrelated mains are not', JSON.stringify(stray));
    check(D, strayMains(table.filter((p) => p.Pid !== '14'), 10).length === 0, 'process census: no stray when the status-line child is gone', '');
    const withHelper = table.concat([{ Pid: '16', Ppid: '10', Name: 'electron.exe', CmdKnown: '1', Typed: '0', Bridge: '0', ConptyAgent: '1', ConoutWorker: '0' }]);
    check(D, strayMains(withHelper, 10).length === 1 && strayMains(withHelper, 10)[0].Pid === '14', 'process census: node-pty console-list helper is not a second app', '');
    const withConout = table.concat([{ Pid: '17', Ppid: '10', Name: 'electron.exe', CmdKnown: '1', Typed: '0', Bridge: '0', ConptyAgent: '0', ConoutWorker: '1', SameAsParent: '0' }]);
    check(D, strayMains(withConout, 10).length === 1 && strayMains(withConout, 10)[0].Pid === '14', 'process census: node-pty conout worker is not a second app', '');
    const relaunch = table.concat([{ Pid: '18', Ppid: '10', Name: 'electron.exe', CmdKnown: '1', Typed: '0', Bridge: '0', ConptyAgent: '0', ConoutWorker: '0', SameAsParent: '1' }]);
    check(D, strayMains(relaunch, 10).length === 1 && strayMains(relaunch, 10)[0].Pid === '14', 'process census: an Electron child with its parent argv is the conout worker, not a second app', '');
    // Full-table scan (not tree-scoped): a hung bridge or runaway app image whose ancestors exited
    // is an orphan row (Ppid points at a pid no longer in the table) that no tree walk reaches.
    // Attribution is strict: BridgeExact (copied bridge script path) or AppAttr (app exe + the
    // app's script path in the command line), so unrelated Electron processes never flag.
    const fullTable = table.concat([
      { Pid: '30', Ppid: '29', Name: 'electron.exe', CmdKnown: '1', Typed: '0', BridgeExact: '1' }, // hung bridge, orphaned (29 gone)
      { Pid: '31', Ppid: '29', Name: 'electron.exe', CmdKnown: '1', Typed: '0', AppAttr: '1' }, // runaway app image, orphaned
      { Pid: '32', Ppid: '29', Name: 'electron.exe', CmdKnown: '1', Typed: '0', AppAttr: '0' }, // unrelated Electron process: unattributed
      { Pid: '33', Ppid: '10', Name: 'electron.exe', CmdKnown: '1', Typed: '0', AppAttr: '1' }, // attributed, parent alive: not an orphan
      { Pid: '34', Ppid: '29', Name: 'electron.exe', CmdKnown: '1', Typed: '1', AppAttr: '1' }, // Chromium child (--type=): not an app main
      { Pid: '35', Ppid: '0', Name: 'electron.exe', CmdKnown: '1', Typed: '0', AppAttr: '1' }, // no parent recorded (pid 0): not "parent exited"
    ]);
    const full = fullTableStrays(fullTable, 10);
    check(D, full.bridges.map((p) => p.Pid).join() === '30' && full.orphans.map((p) => p.Pid).join() === '30,31',
      'process census: full-table scan finds the orphaned bridge and the orphaned app main anywhere in the table (an orphaned bridge counts in both claims)', JSON.stringify(full.orphans.map((p) => p.Pid)));
    check(D, fullTableStrays(fullTable, 31).orphans.map((p) => p.Pid).join() === '30' && fullTableStrays(fullTable.filter((p) => p.Pid !== '30'), 31).orphans.length === 0,
      'process census: the app main itself is never reported as a stray', '');
    const withoutStrays = fullTableStrays(fullTable.filter((p) => p.Pid !== '30' && p.Pid !== '31'), 10);
    check(D, withoutStrays.bridges.length === 0 && withoutStrays.orphans.length === 0,
      'process census: unattributed Electron processes, live attributed children, Chromium children and pid-0 parents are never flagged', JSON.stringify(withoutStrays));
    const present = new Set(['c:\\program files\\git\\cmd\\git.exe', 'c:\\windows\\system32\\bash.exe', 'd:\\tools\\mygit\\git.exe', 'e:\\portablegit\\cmd\\git.exe']);
    const exists = (f) => present.has(f.toLowerCase());
    const pw = path.win32;
    const hid = hideGitFromPath('C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\usr\\bin;D:\\tools\\mygit;"E:\\PortableGit\\cmd";C:\\nodejs', exists, pw);
    check(D, hid.kept.join('|') === 'C:\\Windows\\System32|C:\\nodejs' && hid.dropped.length === 4, 'hide-Git: drops Git dirs (by git.exe or a \\Git\\ folder) but keeps System32 even though it holds the WSL bash.exe', JSON.stringify(hid));
    const be = buildEnv({ P: pw, baseEnv: { Path: 'C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\node', ProgramFiles: 'C:\\Program Files', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'C:\\real\\.claude', FANBOX_SHELL: 'cmd', USERPROFILE: 'C:\\Users\\real', APPDATA: 'C:\\Users\\real\\AppData\\Roaming' },
      home: 'E:\\fanbox test\\用户', port: 4800, hideGit: true, emptyDir: 'E:\\fanbox test\\用户\\empty', exists, pathFront: ['E:\\fanbox test\\用户\\fb-standin'], nodeDir: 'D:\\nodejs', extra: { FANBOX_STANDIN_NODE: 'D:\\nodejs\\node.exe' } });
    const e = be.env;
    check(D, e.USERPROFILE === 'E:\\fanbox test\\用户' && e.HOME === e.USERPROFILE && e.APPDATA === 'E:\\fanbox test\\用户\\AppData\\Roaming' && e.LOCALAPPDATA.endsWith('AppData\\Local') && e.HOMEDRIVE === 'E:' && e.HOMEPATH === '\\fanbox test\\用户', 'buildEnv: profile variables point into the fake home (space + CJK)', JSON.stringify({ u: e.USERPROFILE, d: e.HOMEDRIVE, p: e.HOMEPATH }));
    check(D, e.CLAUDE_CONFIG_DIR === 'E:\\fanbox test\\用户\\.claude' && e.CODEX_HOME === 'E:\\fanbox test\\用户\\.codex' && !('ELECTRON_RUN_AS_NODE' in e) && !('FANBOX_SHELL' in e) && e.FANBOX_PORT === '4800', 'buildEnv: agent config dirs redirected, ELECTRON_RUN_AS_NODE / FANBOX_* inherited values stripped', '');
    check(D, e.Path === 'E:\\fanbox test\\用户\\fb-standin;C:\\Windows;C:\\node;D:\\nodejs' && !('CLAUDE_CODE_GIT_BASH_PATH' in e) && e.ProgramFiles === 'E:\\fanbox test\\用户\\empty' && e.ProgramW6432 === e.ProgramFiles && e.FANBOX_STANDIN_NODE === 'D:\\nodejs\\node.exe', 'buildEnv(hideGit): stand-in first, Git dirs gone, node dir kept last, override unset, ProgramFiles emptied', e.Path);
    const keepGit = buildEnv({ P: pw, baseEnv: { Path: 'C:\\Program Files\\Git\\cmd', CLAUDE_CODE_GIT_BASH_PATH: 'X:\\b.exe' }, home: 'C:\\h', port: 1, exists });
    check(D, keepGit.env.Path === 'C:\\Program Files\\Git\\cmd' && keepGit.env.CLAUDE_CODE_GIT_BASH_PATH === 'X:\\b.exe', 'buildEnv(default): Git stays on PATH and the Git Bash override is kept (S1 uses the tester\'s Git)', '');
    // safety guard for fake homes
    const bad = (home, real, P) => { try { assertSafeFakeHome(home, real, P); return false; } catch (err) { return true; } };
    check(D, bad('C:\\Users\\me', 'C:\\Users\\me', pw) && bad('C:\\Users', 'C:\\Users\\me', pw) && bad('C:\\', 'C:\\Users\\me', pw) && bad('relative\\x', 'C:\\Users\\me', pw) && !bad('E:\\fanbox-v2170\\home', 'C:\\Users\\me', pw) && !bad('C:\\Users\\me\\fb\\home', 'C:\\Users\\me', pw), 'safety: a fake home equal to / above the real profile, a drive root or a relative path is refused', '');
    const reuse = path.join(tmp, 'plain');
    fs.mkdirSync(reuse); fs.writeFileSync(path.join(reuse, 'precious.txt'), 'x');
    let refused = false; try { resetHome(reuse, '/nonexistent-real-home'); } catch (err) { refused = /refusing to reuse/.test(err.message); }
    check(D, refused && fs.existsSync(path.join(reuse, 'precious.txt')), 'safety: a non-empty directory without the marker is never wiped', '');
    const mine = path.join(tmp, 'mine', 'home');
    resetHome(mine, '/nonexistent-real-home'); fs.writeFileSync(path.join(mine, 'junk'), 'x');
    resetHome(mine, '/nonexistent-real-home');
    check(D, fs.existsSync(path.join(mine, MARKER)) && !fs.existsSync(path.join(mine, 'junk')), 'safety: a marked fake home is reset', '');
    check(D, cleanBase(path.join(tmp, 'mine'), '/nonexistent-real-home').length === 1 && !fs.existsSync(mine) && fs.existsSync(path.join(reuse, 'precious.txt')), '--clean: removes only marked homes', '');

    // --- dictionary
    const dict = loadDict();
    check(D, dict.size > 100 && dict.enOf('刚刚') === 'just now' && dict.enOf('3 分钟前') === '3 min ago' && dict.enOf('87%') === '87%' && dict.enOf('17:30 重置') === 'Resets 17:30', 'dictionary: public/i18n-dict.js loads in a sandbox and enOf mimics i18n.js tr() (static keys, rules, language-neutral text)', `${dict.size} keys`);
    const need = [...new Set([].concat(...usageFixtures().map((f) => f.expect)).concat(['CLI实时回传', '刷新失败，保留上次数据', '读取失败，稍后重试', '未缓存输入', '缓存读取', '缓存写入', '输出', '其中推理', '输入缓存命中率']))];
    const lacking = need.filter((z) => dict.enOf(z) === null);
    info(D, `English coverage of the strings the usage fixtures expect (D4 dictionary): ${need.length - lacking.length} of ${need.length} translated`, lacking.length ? 'missing: ' + lacking.join(' | ') : 'complete');

    // --- fixture generators
    const home = sub('home-gen');
    const cm = gen.genClaudeTree({ home, mb: 4, seed: 3 });
    const xm = gen.genCodex({ home });
    const { scan } = require(path.join(ROOT, 'lib', 'agent-tokens.js'));
    const cs = await scan(path.join(home, '.claude', 'projects'), 'claude');
    const xs = await scan(path.join(home, '.codex', 'sessions'), 'codex');
    const same = (a, b) => ['last5h', 'today', 'week'].every((w) => ['input', 'output', 'cacheRead', 'cacheCreate', 'total', 'msgs'].every((k) => a[w][k] === b[w][k]));
    check(D, cs.week.total > 0 && same(cs, cm.windows) && cs.files === cm.files && !cs.partial, 'gen-fixtures claude: lib/agent-tokens.js scan equals the generator\'s ground truth (dedupe, subagents, old files)', JSON.stringify({ files: cs.files, week: cs.week.total, msgs: cs.week.msgs, today: cs.today.total, last5h: cs.last5h.total }));
    check(D, xs.week.total > 0 && same(xs, xm.windows), 'gen-fixtures codex: scan equals the generator\'s ground truth', JSON.stringify({ files: xs.files, week: xs.week.total, msgs: xs.week.msgs }));
    const wk = (o) => `input ${o.input}, output ${o.output}, cacheRead ${o.cacheRead}, cacheCreate ${o.cacheCreate}, total ${o.total}`;
    info(D, 'Claude fixture week totals', wk(cs.week));
    info(D, 'Codex fixture week totals', wk(xs.week));
    const burstDir = sub('burst');
    const b = await gen.burstWrite({ dir: path.join(burstDir, 'b'), count: 120, seconds: 0.4, dirs: 4, sentinel: path.join(burstDir, 'done.txt') });
    const nFiles = fs.readdirSync(path.join(burstDir, 'b')).reduce((n, d) => n + fs.readdirSync(path.join(burstDir, 'b', d)).length, 0);
    check(D, b.count === 120 && nFiles === 120 && fs.existsSync(path.join(burstDir, 'done.txt')) && b.elapsedMs < 5000, 'gen-fixtures burst: 120 files over 4 dirs plus the sentinel', JSON.stringify({ n: nFiles, ms: b.elapsedMs }));
    const rw = gen.rewriteSame({ file: path.join(burstDir, 'same.txt'), times: 100 });
    check(D, rw.times === 100 && fs.readFileSync(path.join(burstDir, 'same.txt'), 'utf8').length > 10, 'gen-fixtures rewrite: 100 identical rewrites', JSON.stringify(rw));
    const cli = await runChild(path.join(__dirname, 'gen-fixtures.js'), ['burst', '--dir', path.join(burstDir, 'cli'), '--count', '40', '--seconds', '0', '--dirs', '2']);
    check(D, cli.code === 0 && cli.json && cli.json.count === 40, 'gen-fixtures CLI: child-process burst prints a JSON summary', cli.out.trim());

    // --- generated sources are valid JavaScript
    const srcs = { 'claude-standin.js': STANDIN_SRC, 'hide-git-preload.cjs': hideGitPreloadSrc(), 'offline-update-preload.cjs': offlineUpdatePreloadSrc() };
    for (const [n, s] of Object.entries(srcs)) {
      const f = path.join(tmp, n); fs.writeFileSync(f, s);
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      check(D, r.status === 0, `generated ${n} passes node --check`, r.stderr);
    }
    try { new vm.Script(PAGE_LIB_SRC); check(D, true, 'page-side helper library parses', ''); } catch (err) { check(D, false, 'page-side helper library parses', err.message); }
    check(D, STANDIN_CMD.includes('\r\n') && STANDIN_CMD.includes('%FANBOX_STANDIN_NODE%') && STANDIN_CMD.includes('%~dp0') && !/[A-Za-z]:\\/.test(STANDIN_CMD), 'claude.cmd uses an env var for node and %~dp0 for the script (no baked-in or CJK paths)', JSON.stringify(STANDIN_CMD));

    // --- the hide-Git preload, run against a fake child_process
    const logFile = path.join(tmp, 'hide.log');
    const calls = [];
    const fakeCp = { execFile: function (file, args, opts, cb) { calls.push(file); const text = 'C:\\Windows;C:\\Program Files\\Git\\cmd;D:\\keep'; cb(null, /powershell/i.test(file) ? Buffer.from(text, 'utf8').toString('base64') + '\r\n' : 'passed through: ' + file, ''); } };
    const preloadFn = new Function('require', 'process', hideGitPreloadSrc());
    preloadFn((n) => (n === 'child_process' ? fakeCp : n === 'fs' ? { existsSync: () => false, appendFileSync: (f, t) => fs.appendFileSync(f, t) } : n === 'path' ? path : require(n)), { env: { FANBOX_HIDEGIT_LOG: logFile }, pid: 1 });
    let got = null;
    fakeCp.execFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-Command', "$u=[Environment]::GetEnvironmentVariable('Path','User'); ..."], { timeout: 1 }, (err, stdout) => { got = Buffer.from(String(stdout).trim(), 'base64').toString('utf8'); });
    let other = null;
    fakeCp.execFile('git.exe', ['--version'], {}, (err, stdout) => { other = stdout; });
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check(D, got === 'C:\\Windows;D:\\keep' && /"kind":"registry-path"/.test(logText) && /"dropped":1/.test(logText), 'hide-Git preload: the registry-PATH PowerShell call comes back without the Git directory (and logs it)', JSON.stringify({ got, log: trunc(logText.replace(/\s+/g, ' '), 140) }));
    check(D, other === 'passed through: git.exe' && calls.length === 2, 'hide-Git preload: other execFile calls pass through untouched', String(other));

    // --- the offline-update preload: mode "system" becomes a closed proxy and keeps the bypass rules
    const r1log = path.join(tmp, 'r1-proxy.log');
    try { fs.unlinkSync(r1log); } catch { /* none */ }
    const origConfigs = [];
    const ses = { setProxy(config) { origConfigs.push(config); return Promise.resolve('orig'); } };
    let readyFn = null;
    const fakeElectron = {
      app: { isReady: () => false, on: (ev, fn) => { if (ev === 'ready') readyFn = fn; } },
      session: { defaultSession: ses },
    };
    new Function('require', 'process', offlineUpdatePreloadSrc())((n) => (n === 'electron' ? fakeElectron : n === 'fs' ? fs : require(n)), { env: { FANBOX_R1_PROXY_LOG: r1log }, pid: 7 });
    check(D, typeof readyFn === 'function', 'offline-update preload: registers a ready handler before the app sets its proxy', '');
    readyFn();
    const rewritten = ses.setProxy({ mode: 'system', proxyBypassRules: 'localhost;127.0.0.1;[::1]' });
    const passed = ses.setProxy({ mode: 'fixed_servers', proxyRules: 'http://10.1.2.3:9' });
    const r1text = fs.existsSync(r1log) ? fs.readFileSync(r1log, 'utf8') : '';
    const first = origConfigs[0] || {};
    check(D, origConfigs.length === 2 && first.mode === 'fixed_servers' && first.proxyRules === 'http://127.0.0.1:9' && first.proxyBypassRules === 'localhost;127.0.0.1;[::1]' && origConfigs[1].proxyRules === 'http://10.1.2.3:9' && rewritten && typeof rewritten.then === 'function' && passed && typeof passed.then === 'function' && /"kind":"rewritten-system"/.test(r1text) && /"kind":"wrapped"/.test(r1text), 'offline-update preload: setProxy({ mode: "system" }) is a closed proxy that still bypasses loopback', JSON.stringify({ origConfigs, log: trunc(r1text.replace(/\s+/g, ' '), 180) }));

    // --- stand-in against the real bridge, bash and a local HTTP server standing in for FanBox
    const bashOk = spawnSync('bash', ['-c', 'exit 0']).status === 0;
    if (!bashOk) skip(D, 'stand-in dry run needs bash on PATH', 'not found');
    else {
      for (const variant of ['with-statusline', 'without-statusline']) {
        const dir = sub('standin-' + variant), fakeHome = sub('standin-home-' + variant), hooksDir = path.join(dir, 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        const script = path.join(hooksDir, 'claude-statusline.cjs');
        fs.copyFileSync(path.join(ROOT, 'lib', 'claude-statusline.cjs'), script);
        fs.writeFileSync(path.join(dir, 'claude-standin.js'), STANDIN_SRC);
        const posts = [];
        const token = 'dry-token-' + variant;
        const srv = http.createServer((req, res) => { let t = ''; req.on('data', (c) => { t += c; }); req.on('end', () => { posts.push({ url: req.url, token: req.headers['x-fanbox-token'], term: req.headers['x-fanbox-term'], body: t }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const port = srv.address().port;
        const statusLine = variant === 'with-statusline' ? H.winStatusLineCommand(process.execPath, script) : null;
        const settings = H.claudeHttpHookSettings(port, { statusLine });
        // claudeHttpHookSettings points hooks at /api/agent/event on `port`; the real file does the same
        const settingsFile = path.join(hooksDir, 'claude-settings.json');
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        const resultFile = path.join(dir, 'result.json');
        const env = Object.assign({}, process.env, { HOME: fakeHome, USERPROFILE: fakeHome, CLAUDE_CONFIG_DIR: path.join(fakeHome, '.claude'), FANBOX_CTL: `http://127.0.0.1:${port}/api/agent`, FANBOX_CTL_TOKEN: token, FANBOX_TERM_ID: 't7', FANBOX_STANDIN_RESULT: resultFile, FANBOX_STANDIN_RUNS: '2', FANBOX_STANDIN_HELPERS: path.join(ROOT, 'win-port-helpers.js') });
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(process.execPath, [path.join(dir, 'claude-standin.js'), '--dangerously-skip-permissions', '--settings', settingsFile], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; child.stdout.on('data', (c) => { stdout += c; });
        const rec = await waitFor(() => { const r = readJson(resultFile); return r && r.statusDone ? r : null; }, 20000, 100);
        child.stdin.write('y\n'); await sleep(900); child.stdin.write('q\n');
        const code = await new Promise((r) => { const t = setTimeout(() => { child.kill(); r(-9); }, 8000); child.on('close', (c) => { clearTimeout(t); r(c); }); });
        await new Promise((r) => srv.close(r));
        const fin = readJson(resultFile) || {};
        check(D, !!rec && fin.settingsOk && code === 0 && fin.ended, `stand-in (${variant}): reads --settings from argv, replays the hooks, exits 0 on q`, JSON.stringify({ settingsOk: fin.settingsOk, code, ended: fin.ended }));
        const events = posts.filter((p) => p.url === '/api/agent/event');
        check(D, events.length >= 6 && events.every((p) => p.token === token && p.term === 't7'), `stand-in (${variant}): hook POSTs carry the interpolated x-fanbox-token / x-fanbox-term headers`, JSON.stringify(fin.posted && fin.posted.map((p) => p.ev + ':' + p.status)));
        check(D, !JSON.stringify(fin).includes(token), `stand-in (${variant}): the token never appears in the result file`, '');
        if (variant === 'with-statusline') {
          const usage = posts.filter((p) => p.url === '/api/agent/usage');
          const run = fin.runs && fin.runs[0];
          const outOk = (s) => (IS_WIN ? /^5h 23% · (周|7d) 42%\r?\n$/.test(s) : s === '5h 23% · 周 42%\n'); // Windows picks the label from the language; the en label is pinned by contract-bridge.test.js
          check(D, fin.hasStatusLine && fin.runs.length === 2 && fin.runs.every((r) => r.code === 0 && outOk(r.stdout)), 'stand-in: bash -c <statusLine.command> runs the real bridge; output line is "5h 23% · 周 42%"', JSON.stringify(fin.runs && fin.runs.map((r) => r.stdout)));
          check(D, usage.length === 2 && usage.every((u) => u.token === token) && (() => { const b = JSON.parse(usage[0].body); return b.fiveHour.usedPercent === SAMPLE.five && b.sevenDay.usedPercent === SAMPLE.seven && b.fiveHour.resetsAt > Date.now() / 1000 && Object.keys(b).sort().join() === 'fiveHour,sevenDay'; })(), 'stand-in: the bridge POSTs only fiveHour / sevenDay (23.4 / 41.6, future resetsAt) to $FANBOX_CTL/usage with the token header', usage[0] && usage[0].body);
          const ms = fin.runs.map((r) => Math.round(r.ms));
          check(D, ms.every((m) => m < 2000), 'stand-in: refresh timings measured (limit here 2 s; Windows target < 1 s)', ms.join(' / ') + ' ms');
        } else {
          check(D, fin.hasStatusLine === false && fin.runs.length === 0 && posts.every((p) => p.url !== '/api/agent/usage'), 'stand-in (no statusLine, as in S5): nothing runs, no usage POST, hooks still flow', JSON.stringify({ runs: fin.runs.length }));
        }
      }
    }

    // --- optional: usage fixtures in headless Chromium (needs FANBOX_UI_URL, PW_CHROMIUM, NODE_PATH)
    if (opts.dryUi) await dryUi(dict);
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function dryUi(dict) {
  const D = 'DRY-UI';
  const url = process.env.FANBOX_UI_URL, exe = process.env.PW_CHROMIUM;
  let pw; try { pw = require('playwright-core'); } catch { pw = null; }
  if (!url || !pw) { skip(D, 'usage fixtures in Chromium', 'needs FANBOX_UI_URL (npm start in web mode with a fake HOME), PW_CHROMIUM and playwright-core on NODE_PATH'); return; }
  // a stale DISPLAY (X11 forwarding that is not up) stalls headless Chromium's frames, so requestAnimationFrame never fires
  const env = Object.assign({}, process.env); delete env.DISPLAY;
  const browser = await pw.chromium.launch({ executablePath: exe || undefined, headless: true, args: ['--no-sandbox'], env });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    // init scripts run on every navigation: only seed fb_lang once, or the language toggle's reload would be undone
    await page.addInitScript(() => { localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_usage_open', '1'); localStorage.setItem('fb_theme', 'warm'); if (!localStorage.getItem('fb_lang')) localStorage.setItem('fb_lang', 'zh'); });
    await page.goto(url); await page.waitForLoadState('networkidle');
    await quietPanel(page);
    await runFixturePass(page, { tag: 'DRY-UI', lang: 'zh', dict });
    await runExpanders(page, { tag: 'DRY-UI', lang: 'zh', dict });
    await switchLang(page, 'en');
    await quietPanel(page);
    await runFixturePass(page, { tag: 'DRY-UI', lang: 'en', dict });
    await runExpanders(page, { tag: 'DRY-UI', lang: 'en', dict });
    check(D, errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function envInfo(ctx) {
  const git = (args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch { return ''; } };
  let electronVersion = ''; try { electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version; } catch { /* */ }
  const gitExe = H.winFindOnPath('git', process.env);
  const o = {
    candidateCommit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    windows: os.release() + ' ' + os.arch(), node: process.version, electron: electronVersion,
    executable: process.env.FANBOX_V2170_EXE || require(path.join(ROOT, 'node_modules', 'electron')),
    gitForWindows: gitExe ? (() => { try { return execFileSync(gitExe, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim(); } catch { return gitExe; } })() : 'not found on PATH',
    gitBash: H.winGitBash(process.env), base: ctx.base, evidence: ctx.out, appVersion: require(path.join(ROOT, 'package.json')).version,
    claudeCode: cliVersion('claude', ctx), codex: cliVersion('codex', ctx),
  };
  return o;
}
function cliVersion(name, ctx) {
  try {
    // `--version` runs against a throw-away profile so the CLIs never touch the tester's real ~/.claude or ~/.codex
    const probeHome = path.join(ctx.base, 'cli-probe-home');
    fs.mkdirSync(path.join(probeHome, 'AppData', 'Roaming'), { recursive: true });
    fs.mkdirSync(path.join(probeHome, 'AppData', 'Local'), { recursive: true });
    const iso = Object.assign({}, process.env, { USERPROFILE: probeHome, HOME: probeHome, APPDATA: path.join(probeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(probeHome, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: path.join(probeHome, '.claude'), CODEX_HOME: path.join(probeHome, '.codex') });
    const cli = H.resolveWinCli(name, process.env, process.execPath);
    if (!cli) return 'not found';
    const r = spawnSync(cli.file, cli.preArgs.concat(['--version']), { encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: probeHome, env: Object.assign({}, iso, cli.extraEnv || {}) });
    return (r.stdout || r.stderr || '').trim().split('\n')[0] || 'unknown';
  } catch { return 'unknown'; }
}

async function main() {
  const opts = parseCli(process.argv.slice(2), process.env);
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.bad.length) { console.error('unknown or invalid arguments: ' + opts.bad.join(' ') + '\n' + HELP); return 2; }
  if (opts.list) { for (const c of CASES) console.log(`${c.id.padEnd(3)} [${c.plan.join(',')}] ${c.desc}`); for (const m of MANUAL) console.log(`MAN ${m.id} ${m.title}`); return 0; }
  if (opts.dry) {
    console.log(`# --dry on ${process.platform}: platform-neutral pieces only (arguments, helpers, dictionary, fixture generators, stand-in against the real bridge)`);
    await runDry(opts);
    return finish(opts, null);
  }
  if (!IS_WIN) {
    console.log('SKIP: playwright-electron.js drives the Windows port and needs a physical Windows machine. This host is ' + process.platform + '. Use --dry for the platform-neutral self-test.');
    return 0;
  }
  if (!opts.base) { console.error('FAIL: set FANBOX_V2170_BASE (or --base) to a writable folder on a short path, e.g. E:\\fanbox-v2170. Fake homes are created below it.'); return 2; }
  try { require(path.join(ROOT, 'node_modules', 'electron')); } catch { console.error('FAIL: node_modules/electron is missing: run npm install and npm run rebuild in the checkout.'); return 2; }
  const ctx = new Ctx(opts);
  ctx.langs = () => (opts.lang === 'both' ? ['zh', 'en'] : [opts.lang]);
  fs.mkdirSync(ctx.base, { recursive: true });
  if (opts.clean) { const removed = cleanBase(ctx.base, ctx.realHome); console.log('removed ' + removed.length + ' fake home(s): ' + removed.join(', ')); return 0; }
  if (opts.launch) return launchManual(ctx, opts.launch);
  try { ctx.pw = require('playwright-core'); } catch { console.error('FAIL: playwright-core is required (install it outside the repo and set NODE_PATH to its node_modules).'); return 2; }
  ctx.dict = loadDict();
  const cases = selectCases(opts.only, opts.soak);
  if (!cases.length) { console.error('no case matches --only ' + opts.only.join(',') + '\n' + HELP); return 2; }
  process.on('exit', () => ctx.killAll());
  process.on('SIGINT', () => { ctx.killAll(); process.exit(130); });
  setTimeout(() => { console.error('FAIL: watchdog'); ctx.killAll(); process.exit(2); }, (90 + (opts.soak || 10)) * 60000).unref();
  const environment = envInfo(ctx);
  ctx.evidence('environment.json', environment);
  console.log('# FanBox 2.17.0 Windows campaign: ' + cases.map((c) => c.id).join(', '));
  console.log('# commit ' + environment.candidateCommit + (environment.dirty ? ' (dirty)' : '') + ' | ' + environment.windows + ' | node ' + environment.node + ' | electron ' + environment.electron + ' | ' + environment.gitForWindows);
  console.log('# base ' + ctx.base + '\n# evidence ' + ctx.out);
  info('ENV', 'dictionary: "CLI实时回传" -> ' + String(ctx.dict.enOf('CLI实时回传')));
  for (const c of cases) {
    curCase = c.id;
    console.log(`\n## ${c.id}: ${c.desc}`);
    try { await c.run(ctx); }
    catch (err) { check(c.id, false, 'case aborted by an exception', err && err.stack || err); }
    finally { ctx.killAll(); }
  }
  curCase = '';
  console.log('');
  const groups = opts.only ? new Set(cases.map((c) => c.group)) : null;
  printManual(opts.only && !opts.manual ? groups : null);
  return finish(opts, ctx);
}

function finish(opts, ctx) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const fails = count('FAIL');
  console.log(`\nSUMMARY: ${count('PASS')} PASS, ${fails} FAIL, ${count('WARN')} WARN, ${count('SKIP')} SKIP, ${count('MANUAL')} MANUAL`);
  if (ctx) { const f = ctx.evidence('results.json', results); console.log('results: ' + f); }
  console.log(`RESULT: ${fails === 0 ? (count('SKIP') ? 'NO FAILURES (' + count('SKIP') + ' skipped: not a clean pass)' : 'ALL PASS') : fails + ' FAILED'}`);
  return fails ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error('FAIL: exception', e && e.stack || e); process.exit(1); });
}
module.exports = { frameWindowValid, parseCli, parseCsv, csvObjects, strayMains, fullTableStrays, dirHasGit, hideGitFromPath, buildEnv, assertSafeFakeHome, loadDict, usageFixtures, runFixturePass, runExpanders, quietPanel, switchLang, STANDIN_SRC, PAGE_LIB_SRC, hideGitPreloadSrc, offlineUpdatePreloadSrc };

'use strict';
/**
 * Windows-port helpers shared by Electron main/preload and Node tests.
 * Pure path/asset logic: no Electron, no listen, path.win32 so Linux tests match Windows.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process'); // argv spawn only (codexPreferMxcSupport probe), never a shell string
const win32 = path.win32;

function uniqueDest(dest, existsFn, pathMod) {
  const P = pathMod || path;
  const exists = existsFn || ((p) => false);
  if (!exists(dest)) return dest;
  const d = P.dirname(dest), ext = P.extname(dest), base = P.basename(dest, ext);
  for (let i = 2; i < 1000; i++) {
    const c = P.join(d, `${base} ${i}${ext}`);
    if (!exists(c)) return c;
  }
  return P.join(d, `${Date.now()}-${base}${ext}`);
}

function winNorm(p) {
  let s = String(p || '').replace(/\//g, '\\');
  if (s.startsWith('\\\\')) s = '\\\\' + s.slice(2).replace(/\\+/g, '\\');
  else s = s.replace(/\\+/g, '\\');
  if (/^[A-Za-z]:\\$/.test(s)) return s.toLowerCase();
  if (s.length > 3 && s.endsWith('\\')) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

function isNativeWinAbs(p) {
  const n = String(p || '').replace(/\//g, '\\');
  return /^[A-Za-z]:\\/.test(n) || n.startsWith('\\\\');
}

function winDrive(p) {
  const m = /^([a-z]:)\\/.exec(winNorm(p));
  return m ? m[1] : null;
}

function winUncShare(p) {
  const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(winNorm(p));
  return m ? `\\\\${m[1]}\\${m[2]}` : null;
}

function winSameVolume(a, b) {
  const da = winDrive(a), db = winDrive(b);
  if (da && db) return da === db;
  const sa = winUncShare(a), sb = winUncShare(b);
  if (sa && sb) return sa === sb;
  return false;
}

function winSameFile(a, b) {
  return !!a && !!b && winNorm(a) === winNorm(b);
}

function winIsEqualOrDescendant(file, dir) {
  const f = winNorm(file);
  const d = winNorm(dir);
  if (!f || !d) return false;
  if (f === d) return true;
  const prefix = d.endsWith('\\') ? d : d + '\\';
  return f.startsWith(prefix);
}

function winContainDecision(srcPath, dir) {
  if (!srcPath || !dir) return { ok: false, error: 'invalid' };
  if (!isNativeWinAbs(srcPath) || !isNativeWinAbs(dir)) return { ok: false, error: 'not-absolute' };
  if (winIsEqualOrDescendant(srcPath, dir) && winSameVolume(srcPath, dir)) {
    return { ok: true, action: 'keep', path: srcPath };
  }
  return { ok: true, action: 'copy', intended: win32.join(dir, win32.basename(srcPath)) };
}

function applyWinContainment(srcPath, dir, io) {
  const d = winContainDecision(srcPath, dir);
  if (!d.ok) return d;
  if (d.action === 'keep') return { ok: true, path: srcPath, copied: false };
  const exists = io.exists || (() => false);
  const copyFile = io.copyFile;
  const destOf = io.uniqueDest || ((p) => uniqueDest(p, exists, win32));
  if (winSameFile(srcPath, d.intended)) return { ok: true, path: srcPath, copied: false };
  const dest = destOf(d.intended);
  if (typeof copyFile === 'function') copyFile(srcPath, dest);
  return { ok: true, path: dest, copied: true };
}

function winCopyIntoDecision(srcPath, dir, uniqueDestFn) {
  if (!srcPath || !dir) return { ok: false, error: 'invalid' };
  const intended = win32.join(dir, win32.basename(srcPath));
  if (winSameFile(srcPath, intended)) return { ok: true, action: 'keep', path: srcPath, intended };
  const dest = (uniqueDestFn || ((p) => uniqueDest(p, () => false, win32)))(intended);
  return { ok: true, action: 'copy', dest, intended };
}

function encodeWinMdChars(s) {
  return encodeURIComponent(s).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function isCanonicalMarkdownDest(s) {
  if (typeof s !== 'string' || !s || /[\\]/.test(s)) return false;
  return /^[A-Za-z]:%5C/i.test(s) || /^%5C%5C/i.test(s);
}

function isForbiddenPersistSrc(s) {
  const t = String(s || '');
  if (/^file:/i.test(t)) return true;
  if (/^blob:/i.test(t)) return true;
  if (/^data:image:/i.test(t)) return true;
  if (/^pending-upload:/i.test(t)) return true;
  if (/^(?:https?:\/\/localhost:\d+)?\/api\/(?:raw|thumb)(?:\?|$)/i.test(t)) return true;
  if (/^(?:https?:\/\/localhost:\d+)?\/fs(?:\/|$)/i.test(t)) return true;
  return false;
}

function isUriScheme(s) {
  const t = String(s || '');
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\')) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t);
}

function toMarkdownDest(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'empty' };
  const s = input.trim();
  if (isForbiddenPersistSrc(s)) return { ok: false, error: 'forbidden-scheme' };
  if (isCanonicalMarkdownDest(s)) return { ok: false, error: 'already-canonical' };
  if (isUriScheme(s)) return { ok: false, error: 'uri-scheme' };
  const native = s.replace(/\//g, '\\');
  if (!isNativeWinAbs(native)) return { ok: false, error: 'relative' };
  const drive = /^([A-Za-z]:)(\\.*)$/.exec(native);
  if (drive) return { ok: true, dest: drive[1] + encodeWinMdChars(drive[2]) };
  if (native.startsWith('\\\\')) return { ok: true, dest: encodeWinMdChars(native) };
  return { ok: false, error: 'relative' };
}

function fromMarkdownDest(dest) {
  if (typeof dest !== 'string' || !dest) return { ok: false, error: 'empty' };
  try {
    return { ok: true, path: decodeURIComponent(dest) };
  } catch {
    return { ok: false, error: 'decode-failed' };
  }
}

function normalizeForMarkdown(src) {
  if (typeof src !== 'string' || !src) return { ok: false, error: 'empty' };
  const s = src.trim();
  if (isCanonicalMarkdownDest(s)) return { ok: true, dest: s };
  if (isForbiddenPersistSrc(s)) {
    let extracted = '';
    const raw = s.match(/\/api\/(?:raw|thumb)\?path=([^&)\\s]+)/i);
    if (raw) {
      try { extracted = decodeURIComponent(raw[1]); } catch { extracted = raw[1]; }
    } else {
      const fs = s.match(/\/fs\/(.+?)(?:\?|$)/i);
      if (fs) {
        try {
          extracted = '/' + fs[1].split('/').filter(Boolean).map(decodeURIComponent).join('/');
        } catch { extracted = fs[1]; }
      } else if (/^file:\/\//i.test(s)) {
        try {
          extracted = decodeURIComponent(s.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));
        } catch { extracted = ''; }
      }
    }
    if (extracted) {
      const native = extracted.replace(/\//g, '\\');
      if (isNativeWinAbs(native)) return toMarkdownDest(native);
    }
    return { ok: false, error: 'forbidden-scheme' };
  }
  if (isNativeWinAbs(s)) return toMarkdownDest(s);
  return { ok: false, error: 'leave' };
}

function winDisplaySrc(markdownSrc) {
  let rel = String(markdownSrc || '').split('#')[0].split('?')[0];
  try { rel = decodeURIComponent(rel); } catch { /* already native */ }
  return '/api/raw?path=' + encodeURIComponent(rel);
}

// Resolve a Markdown image src against the document directory for Windows display.
// Drive / UNC / already-canonical destinations: decode once, then /api/raw.
// Relative src (./cover.png): fold onto docDir — never pass "./…" to /api/raw (that
// would resolve under $HOME).
function winLocalImageSrc(rawSrc, docDir) {
  const raw = String(rawSrc || '').split('#')[0].split('?')[0];
  let rel = raw;
  try { rel = decodeURIComponent(raw); } catch { /* already native */ }
  const absLike = isCanonicalMarkdownDest(raw) || isCanonicalMarkdownDest(rel)
    || isNativeWinAbs(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\');
  if (absLike) return winDisplaySrc(raw);
  const stack = String(docDir || '').split(/[\\/]/).filter(Boolean);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '..') stack.pop();
    else if (seg && seg !== '.') stack.push(seg);
  }
  return '/api/raw?path=' + encodeURIComponent(stack.join('/'));
}

function posixDisplaySrc(abs) {
  return '/api/raw?path=' + encodeURIComponent(abs);
}

function normalizeVersion(v) {
  return String(v || '').replace(/^v/i, '').trim();
}

function exactWinAssetNames(ver, arch) {
  const v = normalizeVersion(ver);
  if (!/^\d+\.\d+\.\d+$/.test(v)) return [];
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return [`FanBox-${v}-win-${a}.exe`, `FanBox-${v}-win-${a}-portable.exe`];
}

function verifiedWinAssetList(assetNames, ver, arch) {
  const need = exactWinAssetNames(ver, arch);
  if (!need.length) return [];
  const set = new Set((assetNames || []).map((n) => String(n || '')));
  if (need.every((n) => set.has(n))) return need.slice();
  return [];
}

async function probeUrlExists(url, fetchFn, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 4000;
  try {
    const head = await fetchFn(url, { method: 'HEAD', headers: { 'User-Agent': 'fanbox-app' } });
    if (head && head.ok) return true;
    if (head && (head.status === 404 || head.status === 410)) return false;
  } catch { /* HEAD unsupported or network — try bounded GET */ }
  const ac = (opts && opts.AbortController) ? new opts.AbortController() : new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* */ } }, timeoutMs);
  try {
    const get = await fetchFn(url, {
      method: 'GET',
      headers: { 'User-Agent': 'fanbox-app', Range: 'bytes=0-0' },
      signal: ac.signal,
    });
    if (get && get.body && typeof get.body.cancel === 'function') {
      try { await get.body.cancel(); } catch { /* */ }
    } else {
      try { ac.abort(); } catch { /* */ }
    }
    return !!(get && (get.ok || get.status === 206));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function selectWinReleaseAssets({ tag, arch, apiAssets, probeExact }) {
  const ver = normalizeVersion(tag);
  const need = exactWinAssetNames(ver, arch);
  if (!need.length) return [];
  if (Array.isArray(apiAssets)) return verifiedWinAssetList(apiAssets, ver, arch);
  const found = [];
  for (const n of need) {
    if (probeExact && await probeExact(n)) found.push(n);
  }
  return verifiedWinAssetList(found, ver, arch);
}

function spawnGit(execFile, gitBin, env, dir, args) {
  if (!gitBin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(gitBin, args, { cwd: dir, timeout: 8000, env }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

function resolveGitExe(platform, findExe) {
  if (platform !== 'win32') return 'git';
  const found = findExe && findExe('git');
  return found || null;
}

function buildWinReleaseSteps({ version, notesFile, doDist, doPush, doRelease, dir, shellQuote }) {
  const steps = [];
  if (doDist) steps.push('npm run dist:win');
  steps.push('git add -A', `git commit -m ${shellQuote('v' + version)}`);
  if (doPush) steps.push('git push');
  if (doRelease) {
    const nsis = win32.join(dir, 'dist', `FanBox-${version}-win-x64.exe`);
    const portable = win32.join(dir, 'dist', `FanBox-${version}-win-x64-portable.exe`);
    const nsisQ = shellQuote(nsis);
    const portQ = shellQuote(portable);
    steps.push(
      `if(-not ((Test-Path -LiteralPath ${nsisQ}) -and ((Get-Item -LiteralPath ${nsisQ}).Length -gt 0) -and (Test-Path -LiteralPath ${portQ}) -and ((Get-Item -LiteralPath ${portQ}).Length -gt 0))){ throw 'missing FanBox artifacts' }`
    );
    steps.push(`gh release create v${version} --title ${shellQuote('v' + version)} --notes-file ${shellQuote(notesFile)} ${nsisQ} ${portQ}`);
  }
  return steps;
}

function foldPwsh(steps) {
  return steps.reduceRight((acc, s) => (acc ? `${s}; if($?){ ${acc} }` : s), '');
}

function notesLeakInCmd(cmd, notes) {
  if (!notes || !cmd) return false;
  const t = String(notes).trim();
  if (!t) return false;
  return String(cmd).includes(t);
}

// Resolve a Markdown image src to a native Windows absolute path (not a URL).
// Drive / UNC / already-canonical dest: decode once. Relative: fold onto docDir.
function localImageAbs(rawSrc, docDir) {
  const raw = String(rawSrc || '').split('#')[0].split('?')[0];
  let rel = raw;
  try { rel = decodeURIComponent(raw); } catch { /* already native */ }
  if (isCanonicalMarkdownDest(raw) || isCanonicalMarkdownDest(rel)
      || isNativeWinAbs(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
    return rel.replace(/\//g, '\\');
  }
  const stack = String(docDir || '').split(/[\\/]/).filter(Boolean);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '..') stack.pop();
    else if (seg && seg !== '.') stack.push(seg);
  }
  if (stack.length && /^[A-Za-z]:$/.test(stack[0])) return stack[0] + '\\' + stack.slice(1).join('\\');
  if (rel.startsWith('\\\\')) return '\\\\' + stack.join('\\');
  return stack.join('\\');
}

function joinPath(dir, filename, sep) {
  const s = sep || '/';
  if (s === '\\') {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    const f = String(filename || '').replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return d + '\\' + f;
  }
  return String(dir).replace(/\/$/, '') + '/' + filename;
}

function splitRel(full, dir, sep) {
  const s = sep || '/';
  if (s === '\\') {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    const f = String(full || '');
    const dl = d.toLowerCase();
    const fl = f.toLowerCase();
    if (fl === dl) return '';
    if (fl.startsWith((d + '\\').toLowerCase()) || fl.startsWith((d + '/').toLowerCase())) {
      return f.slice(d.length).replace(/^[\\/]+/, '');
    }
    const i = Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/'));
    return i >= 0 ? f.slice(i + 1) : f;
  }
  const d = String(dir).replace(/\/$/, '');
  if (String(full).startsWith(d + '/')) return String(full).slice(d.length + 1);
  return String(full);
}

function pathInDir(full, dir, sep) {
  const s = sep || '/';
  if (s === '\\') {
    const d = String(dir || '').replace(/[\\/]+$/, '');
    const f = String(full || '');
    const dl = d.toLowerCase();
    const fl = f.toLowerCase();
    return fl === dl || fl.startsWith(dl + '\\') || fl.startsWith(dl + '/');
  }
  const d = String(dir).replace(/\/$/, '');
  return full === d || String(full).startsWith(d + '/');
}

function stripTrailingSeps(p, win) {
  return String(p).replace(win ? /[\\/]+$/ : /\/+$/, '');
}

function claudeHttpHookSettings(port, opts) {
  const p = Number(port) || 4567;
  const hook = {
    type: 'http',
    url: 'http://127.0.0.1:' + p + '/api/agent/event',
    headers: { 'x-fanbox-token': '$FANBOX_CTL_TOKEN', 'x-fanbox-term': '$FANBOX_TERM_ID' },
    allowedEnvVars: ['FANBOX_CTL_TOKEN', 'FANBOX_TERM_ID'],
    async: true,
    timeout: 5,
  };
  const on = (matcher) => [{ matcher: matcher, hooks: [Object.assign({}, hook)] }];
  const hooks = {};
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd']) {
    hooks[ev] = on('*');
  }
  hooks.PostToolUse = on('Edit|Write|MultiEdit|NotebookEdit|Bash');
  // 2.19.0 window relay: upstream adds a synchronous curl command hook on UserPromptSubmit and PostToolUse whose
  // stdout is the hook output. Windows uses a synchronous HTTP hook to /api/agent/relay instead (no shell, token
  // only in the header). Verified on Claude Code 2.1.309: a 200 body {hookSpecificOutput:{additionalContext}} is
  // injected into the turn, and an empty 200 body is a plain hook_success.
  const relay = Object.assign({}, hook, { url: 'http://127.0.0.1:' + p + '/api/agent/relay', timeout: 4 });
  delete relay.async;
  hooks.UserPromptSubmit[0].hooks.push(Object.assign({}, relay));
  hooks.PostToolUse[0].hooks.push(Object.assign({}, relay));
  // 2.17.0 status-line bridge: same shape as upstream's statusLine; only when the caller
  // found Git Bash (Claude Code runs status lines through it) and built a safe command.
  if (opts && typeof opts.statusLine === 'string' && opts.statusLine) {
    return { hooks: hooks, statusLine: { type: 'command', command: opts.statusLine } };
  }
  return { hooks: hooks };
}

// Command Claude Code runs for the status line on Windows. Claude Code uses Git Bash
// (PowerShell only when Git Bash is missing), never cmd, and Git Bash eats unquoted
// backslashes: forward slashes plus single quotes. A single quote is represented by ending
// the quoted word, emitting a literal quote, then reopening it. Returns null only for an
// empty path. Spaces, $, backticks, percent, exclamation marks and CJK stay literal.
function winStatusLineCommand(execPath, scriptPath) {
  const a = String(execPath || ''), b = String(scriptPath || '');
  if (!a || !b) return null;
  const fwd = (s) => "'" + s.replace(/\\/g, '/').replace(/'/g, "'\"'\"'") + "'";
  return 'ELECTRON_RUN_AS_NODE=1 ' + fwd(a) + ' ' + fwd(b);
}

// Locate Git Bash in Claude Code's own order: CLAUDE_CODE_GIT_BASH_PATH, then git.exe on
// PATH mapped to <git root>\bin\bash.exe (git.exe lives in <root>\cmd, <root>\bin or
// <root>\mingw64\bin), then %ProgramFiles%\Git\bin\bash.exe. Returns the absolute path
// or null. io.exists is injectable and path.win32 is used so Linux tests match Windows.
function winGitBash(env, io) {
  const e = env || process.env;
  const exists = (io && io.exists) || ((f) => fs.existsSync(f));
  const ok = (f) => { try { return !!f && exists(f); } catch { return false; } };
  // Windows env names are case-insensitive; a spread copy of process.env keeps the real case.
  const get = (k) => {
    if (e[k]) return String(e[k]);
    const hit = Object.keys(e).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit && e[hit] ? String(e[hit]) : '';
  };
  const override = get('CLAUDE_CODE_GIT_BASH_PATH');
  if (ok(override)) return override;
  const git = winFindOnPath('git', e, { exists: exists });
  if (git) {
    const dir = win32.dirname(git);
    for (const up of [['..'], ['..', '..']]) {
      const cand = win32.join.apply(win32, [dir].concat(up, ['bin', 'bash.exe']));
      if (ok(cand)) return cand;
    }
  }
  for (const k of ['ProgramFiles', 'ProgramW6432']) {
    const base = get(k);
    const cand = base ? win32.join(base, 'Git', 'bin', 'bash.exe') : '';
    if (ok(cand)) return cand;
  }
  return null;
}

// Claude Code reads CLAUDE_CODE_GIT_BASH_PATH from the `env` block of its own settings.json
// (${CLAUDE_CONFIG_DIR || ~/.claude}/settings.json) as well as from the process environment.
// Pure parse of that file's text: returns the configured path or ''. Invalid JSON, a missing
// or non-object `env`, or a non-string / blank value all give ''. The value is returned as written
// (winGitBash checks that the file exists). Reads nothing, writes nothing.
function claudeSettingsGitBashPath(settingsText) {
  try {
    const d = JSON.parse(String(settingsText));
    const v = d && typeof d === 'object' && d.env && typeof d.env === 'object' ? d.env.CLAUDE_CODE_GIT_BASH_PATH : '';
    return typeof v === 'string' && v.trim() ? v : '';
  } catch { return ''; }
}

function claudeSettingsFlag(settingsPath) {
  if (!settingsPath) return '';
  return ' --settings "' + String(settingsPath) + '"';
}

// Shell-string form of the Codex notify override. Not used to launch Codex on Windows
// (PowerShell 5.1 strips the inner quotes). Launch uses codexNotifyArgv() as a real
// argv slot via pty.spawn — see buildCodexSpawnSpec. Kept so cmd.exe-typed experiments
// and older tests still have the CRT-quoted building block.
function codexNotifyFlag(nodeExe, scriptPath) {
  const argv = codexNotifyArgv(nodeExe, scriptPath);
  if (!argv.length) return '';
  // argv is ['-c', 'notify=["n","s"]']; wrap the value for a cmd.exe command line
  const v = argv[1].replace(/"/g, '\\"');
  return ' -c "' + v + '"';
}

// One argv pair for Codex: ['-c', 'notify=["node","script"]']. Forward slashes so the
// JSON string needs no backslash escapes; Windows paths cannot contain `"`.
function codexNotifyArgv(nodeExe, scriptPath) {
  if (!nodeExe || !scriptPath) return [];
  const n = String(nodeExe).replace(/\\/g, '/');
  const s = String(scriptPath).replace(/\\/g, '/');
  return ['-c', 'notify=["' + n + '","' + s + '"]'];
}

// Pure-Node PATH walk (PATHEXT). Same rules as electron/wechat/driver.js winFindOnPath:
// no where.exe / Get-Command (OEM codepage mangles CJK user names).
function winFindOnPath(name, env, io) {
  const e = env || process.env;
  // Optional io.exists makes the walk testable off Windows: it also switches to path.win32.
  // Optional io.accept filters hits: a hit it rejects keeps the walk going (first
  // directory with an accepted hit still wins; PATHEXT order is preserved).
  const P = io && io.exists ? win32 : path;
  const has = io && io.exists ? io.exists : (f) => fs.existsSync(f);
  const accept = io && typeof io.accept === 'function' ? io.accept : null;
  const dirs = String(e.Path || e.PATH || '').split(';').map((s) => {
    let t = s.trim();
    if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
      t = t.slice(1, -1);
    }
    return t;
  }).filter(Boolean);
  const exts = String(e.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = /\.[^\\/.]+$/.test(name);
  for (const d of dirs) {
    if (hasExt) {
      const f = P.join(d, name);
      try { if (has(f) && (!accept || accept(f))) return f; } catch { /* */ }
      continue;
    }
    for (const ext of exts) {
      const f = P.join(d, name + ext);
      try { if (has(f) && (!accept || accept(f))) return f; } catch { /* */ }
    }
  }
  return null;
}

// Explorer starts do not inherit the Codex desktop app's private bin directory. Keep the
// recovery deliberately small: the current user's Desktop cache, npm's documented global
// bin and the conventional local-bin location. Do not search the working directory or disk.
function winEnvValue(env, name) {
  const e = env || process.env;
  if (e[name] != null && e[name] !== '') return String(e[name]);
  const key = Object.keys(e).find((k) => k.toLowerCase() === name.toLowerCase());
  return key != null && e[key] != null ? String(e[key]) : '';
}

function winRegularFileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, mtime: Number(stat.mtimeMs) || 0 } : null;
  } catch { return null; }
}

function winRegularFile(file) {
  return !!winRegularFileInfo(file);
}

// A positive winCodexFallback pick is cached per process, keyed by the fallback
// locations it was resolved from: an in-session Codex Desktop update must not flip
// which binary a later launch resolves. The cached file is revalidated on read
// (deleted = re-resolve), and negative results are never cached.
const codexFallbackCache = new Map();

// Explorer starts do not inherit the Codex desktop app's private bin directory. Keep the
// recovery deliberately small: the current user's Desktop cache, npm's documented global
// bin and the conventional local-bin location, in that order. Do not search the working
// directory or disk. `accept` (spawnability) is consulted per candidate, so a broken npm
// shim is skipped instead of shadowing the locations after it. The direct bin\codex.exe
// is preferred over the opaque version/cache dirs; newest-by-mtime only breaks ties
// among those dirs.
function winCodexFallback(name, env, accept) {
  if (String(name).toLowerCase() !== 'codex') return null;
  const ok = typeof accept === 'function' ? accept : () => true;
  const local = winEnvValue(env, 'LOCALAPPDATA');
  const appData = winEnvValue(env, 'APPDATA');
  const profile = winEnvValue(env, 'USERPROFILE');
  const cacheKey = [local, appData, profile].join('|');
  const take = (f) => { codexFallbackCache.set(cacheKey, f); return f; };
  const cached = codexFallbackCache.get(cacheKey);
  if (cached && winRegularFile(cached) && ok(cached)) return cached;
  // The Codex desktop app writes version/cache directories under this fixed parent. Their
  // names are intentionally opaque, so choose the newest valid codex.exe deterministically.
  if (local) {
    const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
    const direct = path.join(bin, 'codex.exe');
    if (winRegularFile(direct) && ok(direct)) return take(direct);
    const choices = [];
    try {
      for (const item of fs.readdirSync(bin, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const file = path.join(bin, item.name, 'codex.exe');
        const info = winRegularFileInfo(file);
        if (info) choices.push(info);
      }
    } catch { /* missing or unreadable desktop cache: continue to other bounded locations */ }
    choices.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
    for (const c of choices) if (ok(c.file)) return take(c.file);
  }
  if (appData) {
    const npm = path.join(appData, 'npm');
    for (const file of ['codex.exe', 'codex.cmd', 'codex.ps1']) {
      const candidate = path.join(npm, file);
      if (winRegularFile(candidate) && ok(candidate)) return take(candidate);
    }
  }
  if (profile) {
    const file = path.join(profile, '.local', 'bin', 'codex.exe');
    if (winRegularFile(file) && ok(file)) return take(file);
  }
  return null;
}

// The node_modules JS entry an npm .cmd/.ps1 shim runs, or null. The regex match is
// resolved against the shim's directory and must land inside that directory's
// node_modules: a match containing '..' segments would otherwise escape it
// (path.resolve(dir, 'node_modules/../../x.js') is anywhere on disk).
function winShimEntry(hit, name) {
  const dir = path.dirname(hit);
  const under = path.join(dir, 'node_modules');
  const texts = [hit, hit.replace(/\.(cmd|ps1)$/i, ''), hit.replace(/\.(cmd|ps1)$/i, '') + '.ps1'];
  for (const f of texts) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const m = txt.match(/node_modules[\\/][^"'\r\n]+?\.[cm]?js/i);
    if (m) {
      const cand = path.resolve(dir, m[0].replace(/\//g, path.sep));
      if (!pathInDir(cand, under, path.sep)) continue;
      if (fs.existsSync(cand)) return cand;
    }
  }
  const guess = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js' }[name];
  if (guess) {
    const cand = path.join(dir, 'node_modules', ...guess.split('/'));
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

// Resolve one discovered candidate to a spawnable {file, preArgs, extraEnv?}, or null
// when it is not spawnable: native .exe/.com is used as-is, an npm .cmd/.ps1 shim only
// when its node_modules JS entry resolves (winShimEntry). A null here must keep the
// search going — a broken shim must not abort discovery and shadow a working fallback.
function winCliSpawnSpec(hit, name, env, execPath) {
  const ext = path.extname(hit).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: hit, preArgs: [] };
  const entry = winShimEntry(hit, name);
  if (!entry) return null;
  const node = winFindOnPath('node', env);
  if (node) return { file: node, preArgs: [entry] };
  return { file: execPath || process.execPath, preArgs: [entry], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

// Resolve claude/codex to a spawnable {file, preArgs, extraEnv?} without a shell.
// Same rules as electron/wechat/driver.js resolveWinCli — this copy is the one the
// desktop PTY launch path calls, so contract tests can drive it without requiring electron/.
// Candidates are tried in order (spawnable PATH hit first — first-directory-wins with
// PATHEXT order preserved — then winCodexFallback's locations) and accepted only when
// spawnable; anything else continues the search instead of returning null.
function resolveWinCli(name, env, execPath) {
  const spec = (f) => { try { return winCliSpawnSpec(f, name, env, execPath); } catch { return null; } };
  // PATH is authoritative: the fallback is only for GUI/Explorer environments where it
  // lacks Codex's private Desktop-app cache directory.
  const hit = winFindOnPath(name, env, { accept: (f) => !!spec(f) });
  if (hit) return spec(hit);
  const fallback = winCodexFallback(name, env, (f) => !!spec(f));
  return fallback ? spec(fallback) : null;
}

// Probe gate for the '--enable prefer_mxc' pair: run the resolved CLI with --help as a
// real argv (windowsHide, short timeout) and keep the pair only when the help text lists
// --enable as its own flag. Older CLIs exit on unknown args instead of falling back to their
// configured sandbox, so the pair is dropped whenever the probe says no, errors, or times out.
// The answer is cached per resolved binary (executable + entry path, mtime and size).
const preferMxcCache = new Map();
function codexPreferMxcSupport(cli, probe) {
  if (!cli || !cli.file) return false;
  if (typeof probe === 'function') return !!probe(cli);
  const entry = (cli.preArgs || [])[0];
  const mt = (f) => String((winRegularFileInfo(f) || {}).mtime || 0);
  const sz = (f) => { try { return String(fs.statSync(f).size); } catch { return '0'; } };
  // size joins the key: a timestamp-preserving binary swap must re-probe, not hit the old cache
  const key = [cli.file].concat(cli.preArgs || []).join('|') + '|' + mt(cli.file) + '|' + mt(entry) + '|' + sz(cli.file) + '|' + sz(entry);
  if (preferMxcCache.has(key)) return preferMxcCache.get(key);
  let help = '';
  try {
    help = String(execFileSync(cli.file, (cli.preArgs || []).concat(['--help']), {
      timeout: 5000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }) || '');
  } catch { preferMxcCache.set(key, false); return false; }
  // word-boundary match: --enable must be its own flag (--enabled or glued help text never passes)
  const supported = /(^|\s)--enable(\s|$)/.test(help);
  preferMxcCache.set(key, supported);
  return supported;
}

// Windows Codex PTY launch spec: real argv, never a PowerShell/cmd string.
// extraArgs stay separate slots (cron/整理 prompts with &, quotes, spaces are not joined).
// notify is omitted when neither node.exe nor execPath can run the script.
function buildCodexSpawnSpec(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const execPath = o.execPath || process.execPath;
  const extraArgs = Array.isArray(o.extraArgs) ? o.extraArgs.map((x) => String(x)).filter((s) => s.length > 0) : [];
  const cli = resolveWinCli('codex', env, execPath);
  if (!cli) return null;
  let notifyArgv = [];
  const script = o.notifyScript && fs.existsSync(o.notifyScript) ? o.notifyScript : '';
  if (script) {
    const nodeExe = winFindOnPath('node', env);
    const notifyProg = nodeExe || execPath;
    if (notifyProg) notifyArgv = codexNotifyArgv(notifyProg, script);
  }
  const extraEnv = Object.assign({}, cli.extraEnv || {});
  if (notifyArgv.length && !winFindOnPath('node', env) && execPath) {
    extraEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  // Prefer the account-free Windows MXC sandbox, as Codex Desktop does — but only on a
  // CLI whose own --help lists --enable (codexPreferMxcSupport probe, cached per binary;
  // opts.preferMxcProbe overrides it for tests). There is no in-CLI fallback when the
  // flag is unknown: older CLIs exit on unknown args, so the pair is appended only when
  // the probe says this CLI accepts it.
  const mxc = codexPreferMxcSupport(cli, typeof o.preferMxcProbe === 'function' ? o.preferMxcProbe : null);
  return {
    file: cli.file,
    args: cli.preArgs.concat(mxc ? ['--enable', 'prefer_mxc'] : [], notifyArgv, extraArgs),
    extraEnv: Object.keys(extraEnv).length ? extraEnv : undefined,
  };
}

// 2.20.0 fanbox-notify launchers. The work is done by lib/win-fanbox-notify.cjs (copied next to them as
// fanbox-notify.cjs) run with FanBox's own exe as Node; FANBOX_EXE comes from the PTY env. Neither launcher
// contains a path or any user data, so the files are identical for every user.
// - fanbox-notify.cmd: found by PowerShell and cmd through PATHEXT (the npm-shim layout: an extensionless sh
//   script and a .cmd side by side). Pure ASCII with CRLF, because cmd reads batch files in the OEM code page;
//   %~dp0 and %FANBOX_EXE% are expanded by cmd as UTF-16, so CJK paths are safe.
// - fanbox-notify (no extension): found by Git Bash, which Claude Code's Bash tool uses on Windows. LF only.
// Console code page: FanBox's exe is a GUI-subsystem program, so as Node it has no TTY stdout (isTTY undefined,
// fstat(1) throws) and writes raw UTF-8 bytes into an inherited console handle, which the console decodes with its
// OEM code page (Chinese notes became mojibake in both PowerShell and Git Bash, seen in the 2.20.1 campaign). Both
// launchers switch the console to UTF-8 (65001) for the call and restore the previous code page afterwards; the
// number is the last token / the digits of chcp's output in every locale. Pipes (agents' tool calls) are unaffected.
function buildFanboxNotifyCmd() {
  return [
    '@echo off',
    'rem Generated by FanBox at startup. Usage: fanbox-notify "message"   or   command | fanbox-notify',
    'setlocal',
    'if not defined FANBOX_EXE (',
    '  echo fanbox-notify: not inside a FanBox terminal, nothing sent 1>&2',
    '  exit /b 1',
    ')',
    'rem FanBox writes UTF-8: switch the console code page for the call, restore it afterwards',
    'set "FB_CP="',
    'set "FB_LINE="',
    "for /f \"tokens=*\" %%a in ('chcp 2^>nul') do set \"FB_LINE=%%a\"",
    'if defined FB_LINE for %%b in (%FB_LINE%) do set "FB_CP=%%b"',
    'if defined FB_CP set "FB_CP=%FB_CP:.=%"',
    'if defined FB_CP chcp 65001 >nul 2>&1',
    'set ELECTRON_RUN_AS_NODE=1',
    '"%FANBOX_EXE%" "%~dp0fanbox-notify.cjs" %*',
    'set FB_RC=%ERRORLEVEL%',
    'if defined FB_CP chcp %FB_CP% >nul 2>&1',
    'exit /b %FB_RC%',
    '',
  ].join('\r\n');
}

function buildFanboxNotifySh() {
  return [
    '#!/bin/sh',
    '# FanBox 启动时生成（Windows / Git Bash）。用法：fanbox-notify "要说的话"，或者 命令 | fanbox-notify',
    '[ -n "$FANBOX_EXE" ] || { echo "fanbox-notify：不在 FanBox 的终端里，没有发" >&2; exit 1; }',
    '# FanBox 输出 UTF-8：输出到控制台时临时把代码页切到 65001，跑完切回',
    "cp=''",
    "if [ -t 1 ]; then cp=$(chcp.com 2>/dev/null | tr -dc '0-9'); fi",
    '[ -n "$cp" ] && chcp.com 65001 >/dev/null 2>&1',
    'ELECTRON_RUN_AS_NODE=1 "$FANBOX_EXE" "$0.cjs" "$@"',
    'rc=$?',
    '[ -n "$cp" ] && chcp.com "$cp" >/dev/null 2>&1',
    'exit $rc',
    '',
  ].join('\n');
}

// 2.20.0 watches: bridge.aoWatch hands driver.run() a free-form shell command line that the WeChat agent wrote and
// tested with its own Bash tool. On Windows that tool is Git Bash when installed (PowerShell otherwise), so the
// watch runs in the same shell: Git Bash as a login shell reading the script from stdin (no command-line quoting
// at all), else Windows PowerShell with -EncodedCommand (UTF-16LE Base64, also quoting-free) and UTF-8 output.
// Absolute PowerShell path: a bare name would resolve against the cwd first.
function winShellSpec(cmd, env, io) {
  const e = env || process.env;
  const bash = winGitBash(e, io);
  if (bash) return { file: bash, args: ['-l', '-s'], stdin: String(cmd), shell: 'bash' };
  const root = winEnvValue(e, 'SystemRoot') || 'C:\\Windows';
  const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n' + String(cmd);
  return {
    file: ps,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    stdin: '',
    shell: 'powershell',
  };
}

function shouldSkipAutoUpdateProbe(platform) {
  return platform === 'win32';
}

function appendNoProxy(env) {
  const extra = '127.0.0.1,localhost';
  const out = Object.assign({}, env || {});
  const cur = out.NO_PROXY || out.no_proxy || '';
  if (!cur) {
    out.NO_PROXY = extra;
    return out;
  }
  let next = String(cur);
  if (!/(^|,)\s*127\.0\.0\.1\s*(,|$)/i.test(next)) next += ',127.0.0.1';
  if (!/(^|,)\s*localhost\s*(,|$)/i.test(next)) next += ',localhost';
  if (out.NO_PROXY != null) out.NO_PROXY = next;
  if (out.no_proxy != null) out.no_proxy = next;
  if (out.NO_PROXY == null) out.NO_PROXY = next;
  return out;
}

function buildCodexNotifyJs() {
  return [
    "'use strict';",
    "const http = require('http');",
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const os = require('os');",
    "const path = require('path');",
    "const last = process.argv[process.argv.length - 1] || '';",
    "function origNotify() {",
    "  try {",
    "    const m = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8').match(/^notify\\s*=\\s*\\[([^\\]]*)\\]/m);",
    "    return m ? [...m[1].matchAll(/\"((?:\\\\.|[^\"\\\\])*)\"/g)].map((x) => x[1].replace(/\\\\([\"\\\\])/g, '$1')) : [];",
    "  } catch { return []; }",
    "}",
    "function postThen(cb) {",
    "  const ctl = process.env.FANBOX_CTL;",
    "  const token = process.env.FANBOX_CTL_TOKEN;",
    "  const term = process.env.FANBOX_TERM_ID || '';",
    "  if (!ctl || !token) return cb();",
    "  let u;",
    "  try { u = new URL(ctl.replace(/\\/?$/, '/event')); } catch { return cb(); }",
    "  const body = Buffer.from(String(last), 'utf8');",
    "  const req = http.request({",
    "    hostname: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''),",
    "    method: 'POST',",
    "    headers: {",
    "      'content-type': 'application/json',",
    "      'content-length': body.length,",
    "      'x-fanbox-token': token,",
    "      'x-fanbox-term': term,",
    "    },",
    "    timeout: 3000,",
    "  }, (res) => { res.resume(); cb(); });",
    "  req.on('error', () => cb());",
    "  req.on('timeout', () => { try { req.destroy(); } catch { /* */ } cb(); });",
    "  req.end(body);",
    "}",
    "function runOrig() {",
    "  const orig = origNotify();",
    "  if (!orig.length) { process.exit(0); return; }",
    "  const child = spawn(orig[0], orig.slice(1).concat(process.argv.slice(2)), { stdio: 'inherit', windowsHide: true });",
    "  child.on('exit', (c) => process.exit(c || 0));",
    "  child.on('error', () => process.exit(0));",
    "}",
    "postThen(runOrig);",
    "",
  ].join('\n');
}

module.exports = {
  uniqueDest,
  winNorm,
  isNativeWinAbs,
  winSameFile,
  winIsEqualOrDescendant,
  winSameVolume,
  winContainDecision,
  applyWinContainment,
  winCopyIntoDecision,
  encodeWinMdChars,
  isCanonicalMarkdownDest,
  isForbiddenPersistSrc,
  toMarkdownDest,
  fromMarkdownDest,
  normalizeForMarkdown,
  winDisplaySrc,
  winLocalImageSrc,
  localImageAbs,
  posixDisplaySrc,
  normalizeVersion,
  exactWinAssetNames,
  verifiedWinAssetList,
  probeUrlExists,
  selectWinReleaseAssets,
  spawnGit,
  resolveGitExe,
  buildWinReleaseSteps,
  foldPwsh,
  notesLeakInCmd,
  joinPath,
  splitRel,
  pathInDir,
  stripTrailingSeps,
  claudeHttpHookSettings,
  winStatusLineCommand,
  winGitBash,
  claudeSettingsGitBashPath,
  claudeSettingsFlag,
  codexNotifyFlag,
  codexNotifyArgv,
  winFindOnPath,
  resolveWinCli,
  codexPreferMxcSupport,
  buildCodexSpawnSpec,
  shouldSkipAutoUpdateProbe,
  appendNoProxy,
  buildCodexNotifyJs,
  buildFanboxNotifyCmd,
  buildFanboxNotifySh,
  winShellSpec,
};

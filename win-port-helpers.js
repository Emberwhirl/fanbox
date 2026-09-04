'use strict';
/**
 * Windows-port helpers shared by Electron main/preload and Node tests.
 * Pure path/asset logic: no Electron, no listen, path.win32 so Linux tests match Windows.
 */
const path = require('path');
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

function claudeHttpHookSettings(port) {
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
  return { hooks: hooks };
}

function claudeSettingsFlag(settingsPath) {
  if (!settingsPath) return '';
  return ' --settings "' + String(settingsPath) + '"';
}

// Reserved (not emitted in v2.16.1, plan D3 option b): the CRT-quoted form that reaches codex
// byte-exact as notify=["node","script"] from cmd.exe, and from PowerShell only after a `--%`
// stop-parsing token. PowerShell 5.1 strips the inner quotes of the single-quoted form
// ('notify=["a","b"]' arrives as notify=[a,b]), which is why the flag stays off on Windows.
function codexNotifyFlag(nodeExe, scriptPath) {
  if (!nodeExe || !scriptPath) return '';
  const n = String(nodeExe).replace(/\\/g, '/');
  const s = String(scriptPath).replace(/\\/g, '/');
  return ' -c "notify=[\\"' + n + '\\",\\"' + s + '\\"]"';
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
  claudeSettingsFlag,
  codexNotifyFlag,
  shouldSkipAutoUpdateProbe,
  appendNoProxy,
  buildCodexNotifyJs,
};

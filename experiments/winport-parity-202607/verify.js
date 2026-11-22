#!/usr/bin/env node
'use strict';
/**
 * Golden-rule audit for Windows port remediation (plan §6).
 * Heuristic: every changed line in core files should either:
 *   (a) sit near a win32/IS_WIN/isWindows/PLATFORM==='win32' guard, or
 *   (b) be a pure addition / dict entry / comment, or
 *   (c) match an explicit whitelist of shared one-liner sites.
 * This is not a full AST proof — it flags suspicious hunks for human review.
 *
 * Exit codes: the per-line heuristic only prints `CHK` lines (exit 0). Exit 1 comes from the HARD checks:
 * a removed line in lib/claude-statusline.cjs, and the four master compares / pins in runHardChecks()
 * (REL_PAGE..pendingUpdate slice, checkUpdate failure branch, usageRequest curl selection, anchored
 * FANBOX_DICT_RULES). experiments/winport-parity-202607/mutation-proof.js proves each one.
 */
const { execSync, execFileSync } = require('child_process');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
// Upstream ref to compare against. Default `master` (the upstream mirror); set PARITY_BASE to the upstream release tag
// being ported when master has moved past it (e.g. PARITY_BASE=v2.20.1 while master carries unreleased PRs).
const BASE = process.env.PARITY_BASE || 'master';
const FILES = [
  'electron/main.js',
  'server.js',
  'public/app.js',
  'public/i18n-dict.js',
  'electron/wechat/driver.js',
  'electron/wechat/env.js',
];

// Category (c) whitelist: shared one-line sites that may differ from master
// when the only behavioral branch is platform/sep-guarded.
const WHITELIST_RES = [
  /^\s*let winStatusLineBridge = null;$/, // inert state; read/write sites are Windows-gated
  /function dirOf/,
  /function fsUrl/,
  /function fileManagerName/,
  /function trashName/,
  /function applyPlatformChrome/,
  /离开电脑/,
  /Away from/,
  /REL_REPO|REL_PAGE|hasWinInstaller/,
  /BARE_SHELL_RE/,
  /SHOT_NAME_RE/,
  /state\.sep/,
  /isWindows\(\)|isMacOS\(\)|IS_WIN|PLATFORM === ['"]win32['"]/,
  /winFindExe|winDirSizes|winPtyBusy|resolveWinCli|winFindOnPath/,
  /FileNameW|FANBOX_CLIP_FILE|FANBOX_TRASH_PATH|FANBOX_DIR_SIZES/,
  /powershell\.exe|taskkill|powerSaveBlocker/,
  /回收站|资源管理器|File Explorer|Recycle Bin/,
  /createOpts\.shell|shellOverride|shell: shell/,
  /Object\.assign\(.*which/,
  /previewPathAllowed|snapEligible/,
  /generateThumb|findFfmpeg|findAgentBin/,
  /winHelpers|winPortHelpers|fanboxWinPath|containImage|selectWinReleaseAssets|spawnGit|FANBOX_HELPERS_ONLY|win-port-helpers/,
  /edStr|winMdDest|normalizeForMarkdown|ed-typeset-btn|typeset-dialog|ts-preview/,
  /exactWinAssetNames|verifiedWinAssetList|probeUrlExists|buildWinReleaseSteps|foldPwsh/,
  /autoUpdater\.on\('error'/,
  /createElement\('template'\)/,
  /maxRetries|retryDelay/,
  /function run\(cmd, args, opts\)/,
  /shouldSkipAutoUpdateProbe|claudeHttpHookSettings|codexNotifyFlag|codexNotifyArgv|buildCodexSpawnSpec|localImageAbs|joinPath|stripTrailingSeps|appendNoProxy/,
  /ALLOWED_URI_REGEXP|MD_URI_RE_WIN|MD_PURIFY/,
  /winOpts|webPreferences|ELECTRON_RUN_AS_NODE|startBackendServer/,
  /claudeHooksFlag|codexHooksFlag|winClaudeHooksFlag|winCodexHooksFlag|winFindDesktopApp|spawnCodexInDir|termAgentKind/,
  /splitRel|pathInDir|parseEnvLines|parseWinProxyServer|sysProxyEnv|dumpShellEnv/,
  /尽量不睡眠|系统照常休眠|有任务时保持唤醒/,
  /fileManagerName\(\)|trashName\(\)|modKey\(\)|shQuote/,
  /WIN_SYS32|WIN_PS|WIN_CMD|WIN_EXPLORER|winGitPath|gitExe/,
  /screenshotDirs|shotWatchers|shotSent|waitStable/,
  /stripAnsi|windowsHide|loginShell|resolveWinCli|fullEnv/,
  /socks5h|HTTP_PROXY|HTTPS_PROXY|all_proxy|ALL_PROXY/,
  /winAssetOk|pendingUpdate|probeAutoUpdate/,
  /WIN_BADGE|winBadgeOn|winPty|termCwds|resolveShell|winProcProbe/,
  /cronShq|moveStep|setOverlayIcon|flashFrame/,
  /cleanImgUrls|updateAssetCandidates|termCwdByPid|newTab/,
  /split\(\/\[\\\\\/\]\/\)/,
  /dangerously-bypass-approvals-and-sandbox/,
  /fanboxEnv|isDesktopApp|needs_permission|resumeCmd|wechatView|createOpts|fsPath/,
  /A-Za-z\]:|decodeURIComponent\(p\.slice\(3\)\)/,
  /require\('child_process'\)|require\('path'\)|require\('fs'\)/,
  /agent:term-create|autorun: cronCommand/,
  /agentBusyIn|busyHere|followScopeRoot|inFollowScope|joinPath/,
  /claudeWinPerm/, // v2.20.1: Windows argv twin of claudeCmd, only called from runClaude's isWin() branch
];

const WIN_GUARD = /IS_WIN|IS_MAC|isWin\(|isWindows\(|isMacOS\(|PLATFORM === ['"]win32['"]|PLATFORM === ['"]darwin['"]|process\.platform === ['"]win32['"]|state\.sep === ['"]\\\\['"]|state\.platform === ['"]win32['"]|winPlat|applyPlatformChrome|fanboxEnv\.platform/;

// v2.17.0 (b): single-line rule tuples added inside the FANBOX_DICT_RULES array of the dictionary.
// Narrow on purpose: the line must sit between `window.FANBOX_DICT_RULES = [` and its closing `];`
// in the working-tree file (hunk line numbers are checked, not just context), and must be exactly
// one `[/regex/, (m) => ...]` tuple. A multi-line or differently shaped addition is still flagged.
const RULES_FILE = 'public/i18n-dict.js';
const RULES_ENTRY = /^\s*\[\/.+\/[a-z]*,\s*\(m\)\s*=>\s*.+\],?\s*$/;
function dictRulesRange() {
  let lines;
  try { lines = fs.readFileSync(path.join(ROOT, RULES_FILE), 'utf8').split('\n'); } catch { return null; }
  const start = lines.findIndex((l) => /^window\.FANBOX_DICT_RULES = \[\s*$/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\];\s*$/.test(l));
  return end < 0 ? null : { from: start + 2, to: end }; // 1-based line numbers strictly between the brackets
}
const RULES_RANGE = dictRulesRange();

function diffUnified(file) {
  try {
    return execSync(`git diff ${BASE} -- ${file}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return e.stdout || '';
  }
}

function analyze(file, diff) {
  if (!diff.trim()) return { file, ok: true, notes: ['no diff vs master'] };
  const suspicious = [];
  const lines = diff.split('\n');
  let inHunk = false;
  let ctx = [];
  let newLine = 0; // line number in the working-tree file of the next ' ' / '+' line
  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; ctx = []; newLine = +((line.match(/\+(\d+)/) || [])[1] || 0); continue; }
    if (!inHunk) continue;
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
      ctx.push(line);
      if (ctx.length > 40) ctx.shift();
    }
    const here = newLine;
    if (line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++'))) newLine++;
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (!body.trim() || body.trim().startsWith('//') || body.trim().startsWith('*')) continue;
    // additions that look purely win-related or whitelisted
    const window = ctx.join('\n');
    if (WIN_GUARD.test(window) || WIN_GUARD.test(body)) continue;
    if (WHITELIST_RES.some((re) => re.test(body) || re.test(window))) continue;
    // pure i18n dict key additions
    if (file.includes('i18n') && /['"][^'"]+['"]\s*:/.test(body)) continue;
    // (b) v2.17.0: a one-line rule tuple inside the FANBOX_DICT_RULES array (position-checked)
    if (file === RULES_FILE && RULES_RANGE && here >= RULES_RANGE.from && here <= RULES_RANGE.to && RULES_ENTRY.test(body)) continue;
    // require powerSaveBlocker import etc.
    if (/powerSaveBlocker|titleBarOverlay|mergeWinUserPath/.test(body)) continue;
    // Generic control-flow leftovers adjacent to a Windows arm (heuristic window).
    if (/^(app\.whenReady|const proc =|pr = \(async|await fsp\.mkdir|let abs;|try \{|if \(!r \|\| !r\.ok\)|window\.fanboxAgentCtl\.onCreate|let cmd;|const raw =|if \(!raw\))/.test(body.trim())) continue;
    suspicious.push(body.trim().slice(0, 140));
  }
  // Cap report
  const uniq = [...new Set(suspicious)].slice(0, 40);
  return { file, ok: uniq.length === 0, suspicious: uniq, addedHints: (diff.match(/^\+[^+]/gm) || []).length };
}

// ---- v2.17.0: lib/claude-statusline.cjs (upstream's status-line bridge, copied verbatim to ~/.fanbox/hooks) ----
// Stricter than analyze(): the file is tiny and runs on every status refresh on macOS/Linux, so
//  - any removed or rewritten upstream line is a HARD failure (exit 1);
//  - every added behavioral line must be gated: inside winBash()/winLang() (win32-only helpers),
//    inside an `if (bash && …) { … }` block, or itself containing process.platform === 'win32',
//    winBash() or winLang();
//  - the gates themselves are checked: winBash() starts with the platform guard, and winLang() is
//    only ever called on a line that also tests process.platform === 'win32'.
const STATUSLINE = 'lib/claude-statusline.cjs';
const SL_GATE = /process\.platform\s*===\s*['"]win32['"]|\bwinBash\(\)|\bwinLang\(\)|^\s*if \(bash &&/;
const stripStrings = (t) => t.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
function analyzeStatusline(diff, source) {
  const out = { file: STATUSLINE, removed: [], suspicious: [], added: 0 };
  if (!diff.trim()) { out.notes = ['no diff vs master']; return out; }
  let inHunk = false, depth = 0, gatedAt = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; depth = 0; gatedAt = null; continue; }
    if (!inHunk) continue;
    if (line.startsWith('-')) { out.removed.push(line.slice(1).trim().slice(0, 140)); continue; }
    if (!line.startsWith('+')) continue;
    const body = line.slice(1), t = body.trim();
    out.added++;
    if (!t || t.startsWith('//')) continue;
    const code = stripStrings(t.replace(/\s\/\/.*$/, ''));
    const net = (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    const gatedLine = gatedAt !== null || SL_GATE.test(body);
    if (!gatedLine) out.suspicious.push(t.slice(0, 140));
    if (gatedAt === null && net > 0 && SL_GATE.test(body)) gatedAt = depth;
    depth += net;
    if (gatedAt !== null && depth <= gatedAt) gatedAt = null;
  }
  if (source != null) {
    source = source.replace(/\r\n/g, '\n');
    const m = source.match(/function winBash\(\) \{\n\s*([^\n]+)/);
    if (!m || !/^if \(process\.platform !== 'win32'\) return null;/.test(m[1])) out.suspicious.push('gate: winBash() must start with `if (process.platform !== \'win32\') return null;`');
    source.split('\n').forEach((l) => {
      if (/\bwinLang\(\)/.test(l) && !/^function winLang\(\)/.test(l.trim()) && !/process\.platform === 'win32'/.test(l)) out.suspicious.push('gate: winLang() called outside a win32 test: ' + l.trim().slice(0, 100));
    });
  }
  return out;
}
function statuslineSource() { try { return fs.readFileSync(path.join(ROOT, STATUSLINE), 'utf8'); } catch { return null; } }

// ---- v2.17.0 review follow-up: HARD checks (any failure exits 1) ----
// The heuristic above only looks at added lines near a guard, so a one-token edit to a line that master
// also has (a changed condition, a console.log inside verbatim upstream code, a platform ternary that now
// matches macOS, a catch-all i18n rule) slipped through. These four checks compare the shared text itself.
// They need a local `master` ref (CLAUDE.md: master = upstream mirror) and fail closed without one.
// CRLF is normalised on both sides so a Windows autocrlf checkout compares equal to the LF blobs.
const lf = (t) => String(t).replace(/\r\n/g, '\n');
function readMaster(rel) {
  try { return lf(execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
}
function readWork(rel) { try { return lf(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } }
function sliceBetween(src, from, to) { // [from, to) like upstream's own test slices main.js
  const a = src.indexOf(from), b = a < 0 ? -1 : src.indexOf(to, a);
  return a < 0 || b < 0 ? null : src.slice(a, b);
}
function fnText(src, header) { // from `header` to the first closing `\n}\n` (top-level function bodies here are not nested at col 0)
  const a = src.indexOf(header), b = a < 0 ? -1 : src.indexOf('\n}\n', a);
  return a < 0 || b < 0 ? null : src.slice(a, b + 3);
}
function firstDiff(want, got) {
  const w = want.split('\n'), g = got.split('\n');
  let i = 0; while (i < w.length && i < g.length && w[i] === g[i]) i++;
  return `first difference at line ${i + 1}:\n     master/expected: ${JSON.stringify((w[i] ?? '<end>').slice(0, 160))}\n     working tree:    ${JSON.stringify((g[i] ?? '<end>').slice(0, 160))}`;
}
function replaceOnce(src, from, to) { return src.split(from).length === 2 ? src.replace(from, () => to) : null; }

// H1: upstream's REL_PAGE .. latestReleaseError .. fetchLatestRelease is verbatim (upstream's test runs this slice in a vm)
function hardRelSlice(devMain, masterMain) {
  const name = 'electron/main.js `const REL_PAGE` .. `let pendingUpdate` is byte-identical to master';
  if (masterMain == null) return { name, errs: ['cannot read master:electron/main.js (a local `master` ref is required)'] };
  const a = sliceBetween(masterMain, 'const REL_PAGE =', 'let pendingUpdate ='), b = devMain == null ? null : sliceBetween(devMain, 'const REL_PAGE =', 'let pendingUpdate =');
  if (a == null) return { name, errs: ['master:electron/main.js has no `const REL_PAGE` .. `let pendingUpdate` slice (scanner needs updating)'] };
  if (b == null) return { name, errs: ['working-tree electron/main.js has no `const REL_PAGE` .. `let pendingUpdate` slice'] };
  return { name, errs: a === b ? [] : [firstDiff(a, b)] };
}

// H2: the failure branch of checkUpdate. Expected text = master's `let info` .. `if (!info) { … }` segment with exactly two
// edits: the fetch dispatch, and the Windows arm placed in front of master's `if (manual) {` (which becomes `} else if (manual) {`).
// Everything else in the segment, i.e. the whole POSIX dialog and the retry line, must match master byte for byte.
function hardUpdateFailure(devMain, masterMain) {
  const name = 'electron/main.js checkUpdate: POSIX failure dialog (`else if (manual) {…}`) is byte-identical to master';
  if (masterMain == null) return { name, errs: ['cannot read master:electron/main.js (a local `master` ref is required)'] };
  const seg = (src) => { const a = src.indexOf('async function checkUpdate(opts) {'); return a < 0 ? null : sliceBetween(src.slice(a), '  let info = null;\n', '  updRetry = 0;\n'); };
  const m = seg(masterMain), d = devMain == null ? null : seg(devMain);
  if (m == null) return { name, errs: ['master:electron/main.js checkUpdate has no `let info` .. `updRetry = 0` segment (scanner needs updating)'] };
  if (d == null) return { name, errs: ['working-tree electron/main.js checkUpdate has no `let info` .. `updRetry = 0` segment'] };
  let want = replaceOnce(m, 'try { info = await fetchLatestRelease(); } catch { info = null; }', 'try { info = await (IS_WIN ? fetchLatestReleaseWin() : fetchLatestRelease()); } catch { info = null; }');
  if (want != null) want = replaceOnce(want, '    if (manual) {\n', '    if (manual && IS_WIN) {\n      winUpdateFailureDialog();\n    } else if (manual) {\n');
  if (want == null) return { name, errs: ['master\'s checkUpdate failure segment no longer has the two anchor lines this check rewrites (scanner needs updating)'] };
  return { name, errs: want === d ? [] : [firstDiff(want, d)] };
}

// H3: server.js usageRequest. The curl selection is pinned verbatim and the rest of the function must equal master's, apart from
// the argument `execFile('curl'` -> `execFile(curlExe` and the two Windows-only spawn options (winSpawnEnv() is undefined off Windows).
const CURL_EXPR = "PLATFORM === 'win32' ? (winFindExe('curl.exe') || path.join(WIN_SYS32, 'curl.exe')) : 'curl'";
function hardUsageRequest(devSrv, masterSrv) {
  const name = 'server.js usageRequest: curl selection pinned, rest of the function identical to master';
  if (masterSrv == null) return { name, errs: ['cannot read master:server.js (a local `master` ref is required)'] };
  const H = 'async function usageRequest(';
  const m = fnText(masterSrv, H), d = devSrv == null ? null : fnText(devSrv, H);
  if (m == null) return { name, errs: ['master:server.js has no usageRequest (scanner needs updating)'] };
  if (d == null) return { name, errs: ['working-tree server.js has no usageRequest'] };
  const errs = [];
  const open = 'const out = await new Promise((resolve, reject) => {\n', call = '    const cp = execFile(curlExe, ';
  const i = d.indexOf(open), j = d.indexOf(call);
  if (i < 0 || j < i) return { name, errs: ['usageRequest no longer has `const out = await new Promise(…{` followed by `execFile(curlExe, …`'] };
  const pre = d.slice(i + open.length, j).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  if (pre.length !== 1 || !/^    const curlExe = (.*);$/.test(pre[0])) errs.push('between the Promise opener and execFile there must be exactly one `const curlExe = …;` (plus // comments), found: ' + JSON.stringify(pre));
  else {
    const expr = pre[0].match(/^    const curlExe = (.*);$/)[1];
    if (!expr.startsWith("PLATFORM === 'win32' ?")) errs.push("curl selection must begin with `PLATFORM === 'win32' ?`: " + expr);
    if (!expr.endsWith(": 'curl'")) errs.push("curl selection must end with `: 'curl'`: " + expr);
    if (expr !== CURL_EXPR) errs.push(`curl selection differs from the pinned text\n     pinned: ${CURL_EXPR}\n     found:  ${expr}`);
  }
  // the function without the curlExe lines must be master's function with the two known substitutions
  const stripped = d.slice(0, i + open.length) + d.slice(j);
  let want = replaceOnce(m, "    const cp = execFile('curl', ", call);
  if (want != null) want = replaceOnce(want, '{ timeout: 14000, maxBuffer: 1024 * 1024 }', '{ timeout: 14000, maxBuffer: 1024 * 1024, env: winSpawnEnv(), windowsHide: true }');
  if (want == null) errs.push('master\'s usageRequest no longer has the lines this check rewrites (scanner needs updating)');
  else if (want !== stripped) errs.push(firstDiff(want, stripped));
  return { name, errs };
}

// H4: every FANBOX_DICT_RULES regex is anchored ^…$ as a whole: no 'm' flag, an unescaped trailing $, and no top-level `|`
// (`^a|b$` is anchored text but matches "b" anywhere before the end). Non-RegExp (legacy string) rules are allowed only
// when master already has the same rule. The dictionary file is browser script; it runs in a vm with a bare `window`.
function loadRules(src) { try { const w = {}; vm.runInNewContext(src, { window: w }, { timeout: 2000 }); return Array.isArray(w.FANBOX_DICT_RULES) ? w.FANBOX_DICT_RULES : null; } catch { return null; } }
function topLevelAlternation(source) {
  let depth = 0, cls = false;
  for (let k = 0; k < source.length; k++) {
    const c = source[k];
    if (c === '\\') { k++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return true;
  }
  return false;
}
function hardDictRules(devDict, masterDict) {
  const name = 'public/i18n-dict.js FANBOX_DICT_RULES: every entry anchored ^…$ (no catch-all rules)';
  if (masterDict == null) return { name, errs: ['cannot read master:public/i18n-dict.js (a local `master` ref is required)'] };
  const rules = devDict == null ? null : loadRules(devDict), legacy = loadRules(masterDict);
  if (!rules) return { name, errs: ['public/i18n-dict.js did not load a FANBOX_DICT_RULES array'] };
  const inMaster = new Set((legacy || []).filter(([re]) => Object.prototype.toString.call(re) !== '[object RegExp]').map(([re]) => String(re)));
  const errs = [];
  for (const [re] of rules) {
    if (Object.prototype.toString.call(re) !== '[object RegExp]') { if (!inMaster.has(String(re))) errs.push('non-RegExp rule that master does not have (use an anchored regex): ' + JSON.stringify(String(re).slice(0, 80))); continue; }
    const src = re.source, why = [];
    if (!src.startsWith('^')) why.push('no leading ^');
    if (!/(?:^|[^\\])(?:\\\\)*\$$/.test(src)) why.push('no unescaped trailing $');
    if (re.flags.includes('m')) why.push("'m' flag");
    if (topLevelAlternation(src)) why.push('top-level | (one side is unanchored)');
    if (why.length) errs.push(`${re} — ${why.join(', ')}`);
  }
  return { name, errs };
}

function runHardChecks() {
  return [
    hardRelSlice(readWork('electron/main.js'), readMaster('electron/main.js')),
    hardUpdateFailure(readWork('electron/main.js'), readMaster('electron/main.js')),
    hardUsageRequest(readWork('server.js'), readMaster('server.js')),
    hardDictRules(readWork('public/i18n-dict.js'), readMaster('public/i18n-dict.js')),
  ];
}

function main() {
  console.log('Classified accepted shared edits (v2.16.1 round; PR #60 sanitizer deviation retired):');
  console.log('  (1) autoUpdater.on(\'error\')');
  console.log('  (2) inert <template> semanticSig()');
  console.log('  (3) fsp.rm maxRetries/retryDelay platform ternary');
  console.log('  (4) optional third parameter on run()');
  console.log('Classified accepted shared edits (v2.17.0 round, plan §6.7 + earlier update-code rewrites):');
  console.log('  (5) lib/claude-statusline.cjs: win32-only inserted lines (bash -c chaining, 7d label) — pure additions, checked below');
  console.log('  (6) electron/main.js checkUpdate dispatch + Windows tail: fetchLatestReleaseWin / winUpdateFailureDialog (upstream fetchLatestRelease verbatim)');
  console.log('  (7) server.js usageRequest: platform ternary for the curl path (winFindExe("curl.exe"), exact name), env: winSpawnEnv(), windowsHide');
  console.log('  (8) public/i18n-dict.js: new keys + single-line FANBOX_DICT_RULES tuples (additive, position-checked)');
  console.log('  (9) electron/main.js update:download + updateAssetCandidates (pre-existing 2.16.1 rewrite, now listed)');
  console.log('Classified accepted shared edits (v2.20.1 round):');
  console.log('  (10) electron/wechat/driver.js claudeWinPerm(): argv twin of upstream claudeCmd()\'s permission slots (Windows-only caller)');
  const results = FILES.map((f) => analyze(f, diffUnified(f)));
  let bad = 0, hard = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`OK  ${r.file}${r.notes ? ' — ' + r.notes.join('; ') : ''}`);
    } else {
      bad++;
      console.log(`CHK ${r.file} — ${r.suspicious.length} non-obvious added line(s) (review):`);
      for (const s of r.suspicious) console.log('   +', s);
    }
  }
  const sl = analyzeStatusline(diffUnified(STATUSLINE), statuslineSource());
  if (sl.removed.length) {
    hard++;
    console.log(`FAIL ${sl.file} — ${sl.removed.length} upstream line(s) removed or rewritten (must be pure additions):`);
    for (const s of sl.removed) console.log('   -', s);
  }
  if (sl.suspicious.length) {
    bad++;
    console.log(`CHK ${sl.file} — ${sl.suspicious.length} ungated added line(s) (review):`);
    for (const s of sl.suspicious) console.log('   +', s);
  }
  if (!sl.removed.length && !sl.suspicious.length) {
    console.log(`OK  ${sl.file} — ${sl.notes ? sl.notes.join('; ') : `${sl.added} added line(s), 0 removed, all behind win32 / winBash() / winLang() gates`}`);
  }
  console.log('\nHard checks (exit 1 on failure):');
  for (const h of runHardChecks()) {
    if (!h.errs.length) { console.log(`OK  ${h.name}`); continue; }
    hard++;
    console.log(`FAIL ${h.name}`);
    for (const e of h.errs) console.log('   ' + e);
  }
  if (hard) { console.log(`\n${hard} hard check(s) failed (golden rule: shared text must stay identical to master) — hard failure.`); process.exit(1); }
  console.log(bad ? `\n${bad} file(s) need human review (heuristic, not hard fail).` : '\nAll files pass heuristic golden-rule scan.');
  // The per-line heuristic exits 0; only removed statusline lines and the four hard checks above fail the run
  process.exit(0);
}

if (require.main === module) main();
module.exports = { analyze, analyzeStatusline, runHardChecks, hardRelSlice, hardUpdateFailure, hardUsageRequest, hardDictRules };

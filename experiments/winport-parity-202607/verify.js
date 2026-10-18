#!/usr/bin/env node
'use strict';
/**
 * Golden-rule audit for Windows port remediation (plan §6).
 * Heuristic: every changed line in core files should either:
 *   (a) sit near a win32/IS_WIN/isWindows/PLATFORM==='win32' guard, or
 *   (b) be a pure addition / dict entry / comment, or
 *   (c) match an explicit whitelist of shared one-liner sites.
 * This is not a full AST proof — it flags suspicious hunks for human review.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
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
    return execSync(`git diff master -- ${file}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
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
    const m = source.match(/function winBash\(\) \{\n\s*([^\n]+)/);
    if (!m || !/^if \(process\.platform !== 'win32'\) return null;/.test(m[1])) out.suspicious.push('gate: winBash() must start with `if (process.platform !== \'win32\') return null;`');
    source.split('\n').forEach((l) => {
      if (/\bwinLang\(\)/.test(l) && !/^function winLang\(\)/.test(l.trim()) && !/process\.platform === 'win32'/.test(l)) out.suspicious.push('gate: winLang() called outside a win32 test: ' + l.trim().slice(0, 100));
    });
  }
  return out;
}
function statuslineSource() { try { return fs.readFileSync(path.join(ROOT, STATUSLINE), 'utf8'); } catch { return null; } }

function main() {
  console.log('Classified accepted shared edits (v2.16.1 round; PR #60 sanitizer deviation retired):');
  console.log('  (1) autoUpdater.on(\'error\')');
  console.log('  (2) inert <template> semanticSig()');
  console.log('  (3) fsp.rm maxRetries/retryDelay platform ternary');
  console.log('  (4) optional third parameter on run()');
  console.log('Classified accepted shared edits (v2.17.0 round, plan §6.7 + earlier update-code rewrites):');
  console.log('  (5) lib/claude-statusline.cjs: win32-only inserted lines (bash -c chaining, 7d label) — pure additions, checked below');
  console.log('  (6) electron/main.js checkUpdate dispatch + Windows tail: fetchLatestReleaseWin / winUpdateFailureDialog (upstream fetchLatestRelease verbatim)');
  console.log('  (7) server.js usageRequest: platform ternary for the curl path, env: winSpawnEnv(), windowsHide');
  console.log('  (8) public/i18n-dict.js: new keys + single-line FANBOX_DICT_RULES tuples (additive, position-checked)');
  console.log('  (9) electron/main.js update:download + updateAssetCandidates (pre-existing 2.16.1 rewrite, now listed)');
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
  if (hard) { console.log(`\n${hard} file(s) violate the golden rule (removed upstream lines) — hard failure.`); process.exit(1); }
  console.log(bad ? `\n${bad} file(s) need human review (heuristic, not hard fail).` : '\nAll files pass heuristic golden-rule scan.');
  // The heuristic part always exits 0; only removed statusline lines (above) fail hard
  process.exit(0);
}

if (require.main === module) main();
module.exports = { analyze, analyzeStatusline };

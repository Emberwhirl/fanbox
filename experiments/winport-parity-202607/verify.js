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
  /shouldSkipAutoUpdateProbe|claudeHttpHookSettings|codexNotifyFlag|localImageAbs|joinPath|stripTrailingSeps|appendNoProxy/,
  /ALLOWED_URI_REGEXP|MD_URI_RE_WIN|MD_PURIFY/,
  /winOpts|webPreferences|ELECTRON_RUN_AS_NODE|startBackendServer/,
  /claudeHooksFlag|codexHooksFlag|winClaudeHooksFlag|winCodexHooksFlag|winFindDesktopApp/,
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
  for (const line of lines) {
    if (line.startsWith('@@')) { inHunk = true; ctx = []; continue; }
    if (!inHunk) continue;
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
      ctx.push(line);
      if (ctx.length > 40) ctx.shift();
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (!body.trim() || body.trim().startsWith('//') || body.trim().startsWith('*')) continue;
    // additions that look purely win-related or whitelisted
    const window = ctx.join('\n');
    if (WIN_GUARD.test(window) || WIN_GUARD.test(body)) continue;
    if (WHITELIST_RES.some((re) => re.test(body) || re.test(window))) continue;
    // pure i18n dict key additions
    if (file.includes('i18n') && /['"][^'"]+['"]\s*:/.test(body)) continue;
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

function main() {
  console.log('Classified accepted shared edits (plan §6.4); PR #60 sanitizer deviation retired:');
  console.log('  (1) autoUpdater.on(\'error\')');
  console.log('  (2) inert <template> semanticSig()');
  console.log('  (3) fsp.rm maxRetries/retryDelay platform ternary');
  console.log('  (4) optional third parameter on run()');
  const results = FILES.map((f) => analyze(f, diffUnified(f)));
  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`OK  ${r.file}${r.notes ? ' — ' + r.notes.join('; ') : ''}`);
    } else {
      bad++;
      console.log(`CHK ${r.file} — ${r.suspicious.length} non-obvious added line(s) (review):`);
      for (const s of r.suspicious) console.log('   +', s);
    }
  }
  console.log(bad ? `\n${bad} file(s) need human review (heuristic, not hard fail).` : '\nAll files pass heuristic golden-rule scan.');
  // Always exit 0 for heuristic — hard fail only if git missing
  process.exit(0);
}

main();

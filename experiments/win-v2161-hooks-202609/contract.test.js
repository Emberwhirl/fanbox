#!/usr/bin/env node
'use strict';
/**
 * Linux contracts for the v2.16.1 Windows port (D1–D3, path join, git spawn, thumbs, packaging).
 * Drives shipped win-port-helpers.js and source of shipped functions. No mocks of units under test.
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));

let failed = 0;
let passed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('# HTTP hook file (D2)');
{
  const settings = H.claudeHttpHookSettings(4567);
  const hook = settings.hooks.SessionStart[0].hooks[0];
  check(hook.type === 'http', 'hook type is http', hook.type);
  check(hook.url === 'http://127.0.0.1:4567/api/agent/event', 'loopback event URL', hook.url);
  check(hook.headers['x-fanbox-token'] === '$FANBOX_CTL_TOKEN', 'token via header interpolation', hook.headers['x-fanbox-token']);
  check(hook.headers['x-fanbox-term'] === '$FANBOX_TERM_ID', 'term id via header interpolation');
  check(Array.isArray(hook.allowedEnvVars) && hook.allowedEnvVars.indexOf('FANBOX_CTL_TOKEN') >= 0
    && hook.allowedEnvVars.indexOf('FANBOX_TERM_ID') >= 0, 'allowedEnvVars lists both names');
  const dumped = JSON.stringify(settings);
  check(!/"[0-9a-f]{20,}"/i.test(dumped), 'no hex token literal in the file', dumped.slice(0, 200));
  check(dumped.indexOf('FANBOX_CTL_TOKEN') >= 0 && dumped.indexOf('$FANBOX_CTL_TOKEN') >= 0,
    'placeholder $FANBOX_CTL_TOKEN present, not a concrete secret');
  check(settings.hooks.PostToolUse[0].matcher.indexOf('Edit') >= 0, 'PostToolUse matcher includes Edit');
}

console.log('# launch-flag builders (D2/D3)');
{
  const abs = 'C:\\Users\\foo\\.fanbox\\hooks\\claude-settings.json';
  const flag = H.claudeSettingsFlag(abs);
  check(flag === ' --settings "' + abs + '"', 'quoted absolute --settings for cmd and PowerShell', JSON.stringify(flag));
  check(H.claudeSettingsFlag('') === '', 'missing settings path omits the flag');
  check(H.codexNotifyFlag('', 'C:\\x\\codex-notify.js') === '', 'Codex flag omitted without node.exe');
  check(H.codexNotifyFlag(null, 'C:\\x\\codex-notify.js') === '', 'Codex flag omitted when node is null');
  check(H.codexNotifyFlag('C:\\nodejs\\node.exe', '') === '', 'Codex flag omitted without script');
  const nf = H.codexNotifyFlag('C:\\nodejs\\node.exe', 'C:\\Users\\a\\.fanbox\\hooks\\codex-notify.js');
  check(nf === ' -c \'notify=["C:/nodejs/node.exe","C:/Users/a/.fanbox/hooks/codex-notify.js"]\'',
    'Codex notify argv uses forward slashes', JSON.stringify(nf));
  const js = H.buildCodexNotifyJs();
  check(js.indexOf('http.request') >= 0 && js.indexOf('x-fanbox-token') >= 0, 'generated notify script POSTs with headers');
  check(!/"[0-9a-f]{24}"/.test(js), 'notify script contains no token literal');
}

console.log('# 本回合 path join/split on sep');
{
  check(H.joinPath('C:\\proj', 'sub\\a.ts', '\\') === 'C:\\proj\\sub\\a.ts', 'win join nested');
  check(H.joinPath('C:\\proj\\', 'a.ts', '\\') === 'C:\\proj\\a.ts', 'win join strips trailing sep');
  check(H.splitRel('C:\\proj\\sub\\a.ts', 'C:\\proj', '\\') === 'sub\\a.ts', 'win splitRel');
  check(H.pathInDir('C:\\proj\\sub\\a.ts', 'C:\\proj', '\\') === true, 'win pathInDir descendant');
  check(H.pathInDir('C:\\proj-extra\\a.ts', 'C:\\proj', '\\') === false, 'win pathInDir sibling-prefix is not descendant');
  check(H.joinPath('/home/p', 'a.ts', '/') === '/home/p/a.ts', 'posix join matches master expression');
  check(H.splitRel('/home/p/a.ts', '/home/p', '/') === 'a.ts', 'posix splitRel');
  check(H.pathInDir('/home/p/a.ts', '/home/p', '/') === true, 'posix pathInDir');
}

console.log('# shipped app.js joinPath / pathInDir / agentBusyIn');
{
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  function sliceFn(src, startNeedle, endNeedle) {
    const a = src.indexOf(startNeedle);
    const b = src.indexOf(endNeedle, a + startNeedle.length);
    return (a >= 0 && b > a) ? src.slice(a, b) : '';
  }
  const helpersSrc = sliceFn(app, 'function joinPath(dir, filename)', 'function applyPlatformChrome');
  const busySrc = sliceFn(app, 'function agentBusyIn(project)', 'async function openRoundPanel');
  check(helpersSrc.indexOf('function pathInDir') >= 0 && busySrc.indexOf('pathInDir') >= 0,
    'extracted shipped joinPath/pathInDir/agentBusyIn from app.js');

  function loadSep(sep, cwdBusy) {
    const box = {
      state: { sep: sep },
      term: { sessions: [
        { dead: false, status: 'busy', cwd: cwdBusy, startDir: '' },
        { dead: false, status: 'idle', cwd: cwdBusy, startDir: '' },
      ] },
    };
    vm.runInNewContext(
      helpersSrc + '\n' + busySrc
      + '\nthis.joinPath=joinPath; this.splitRel=splitRel; this.pathInDir=pathInDir; this.agentBusyIn=agentBusyIn;',
      box,
    );
    return box;
  }
  const win = loadSep('\\', 'C:\\proj\\src');
  check(win.joinPath('C:\\proj', 'sub\\a.ts') === 'C:\\proj\\sub\\a.ts', 'app.js joinPath win nested');
  check(win.joinPath('C:\\proj\\', 'a.ts') === 'C:\\proj\\a.ts', 'app.js joinPath win trailing sep');
  check(win.splitRel('C:\\proj\\sub\\a.ts', 'C:\\proj') === 'sub\\a.ts', 'app.js splitRel win');
  check(win.pathInDir('C:\\proj\\src\\a.ts', 'C:\\proj') === true, 'app.js pathInDir win descendant');
  check(win.pathInDir('C:\\proj-extra\\a.ts', 'C:\\proj') === false, 'app.js pathInDir win sibling-prefix');
  check(win.agentBusyIn('C:\\proj') === true,
    'app.js agentBusyIn: busy cwd C:\\proj\\src counts as in project C:\\proj');
  check(win.agentBusyIn('C:\\other') === false, 'app.js agentBusyIn: other project not busy');

  const posix = loadSep('/', '/home/p/src');
  check(posix.joinPath('/home/p', 'a.ts') === '/home/p/a.ts', 'app.js joinPath posix');
  check(posix.pathInDir('/home/p/src/a.ts', '/home/p') === true, 'app.js pathInDir posix');
  check(posix.agentBusyIn('/home/p') === true, 'app.js agentBusyIn posix descendant cwd');

  const fcStart = app.indexOf('function followChange(dir, sub)');
  const fcEnd = app.indexOf('\nfunction ', fcStart + 10);
  const fc = fcStart >= 0 ? app.slice(fcStart, fcEnd > fcStart ? fcEnd : fcStart + 800) : '';
  check(/joinPath\(dir,\s*sub\)/.test(fc), 'followChange joins with joinPath', fc.slice(0, 200));
  const ifs = sliceFn(app, 'function inFollowScope(full)', 'function boundAgentActive');
  check(/pathInDir\(full,\s*root\)/.test(ifs), 'inFollowScope uses pathInDir', ifs.slice(0, 250));
  const spStart = app.indexOf('async function snapshotPanel');
  const spEnd = app.indexOf('\nasync function ', spStart + 10);
  const snap = spStart >= 0 ? app.slice(spStart, spEnd > spStart ? spEnd : spStart + 4000) : '';
  check(/agentBusyIn\(d\.project\)/.test(snap), 'snapshotPanel.busyHere delegates to agentBusyIn',
    snap.indexOf('busyHere') >= 0 ? snap.slice(snap.indexOf('busyHere'), snap.indexOf('busyHere') + 80) : 'no busyHere');
  check(!/d\.project\s*\+\s*'\/'/.test(snap) && !/startsWith\(d\.project/.test(snap),
    'snapshotPanel has no startsWith(d.project + "/")');

  const jpStart = app.indexOf('function joinPath(dir, filename)');
  const jpEnd = app.indexOf('function applyPlatformChrome');
  const rest = app.slice(0, jpStart) + app.slice(jpEnd);
  const leftover = [];
  const reStarts = /\.startsWith\([^;]*\+\s*'\/'\s*\)/g;
  const reJoin = /\+\s*'\/'\s*\+/g;
  const reTrail = /replace\(\/\\\/\$\/,\s*''\)\s*\+\s*'\/'/g;
  let m;
  while ((m = reStarts.exec(rest))) leftover.push(m[0]);
  while ((m = reJoin.exec(rest))) leftover.push(m[0]);
  while ((m = reTrail.exec(rest))) leftover.push(m[0]);
  check(leftover.length === 0,
    'app.js has no unguarded startsWith(x + "/") or dir + "/" + filename outside joinPath/pathInDir',
    leftover.join(' | '));
}

console.log('# snap-clean trailing-sep normalize');
{
  check(H.stripTrailingSeps('C:\\proj\\', true) === 'C:\\proj', 'win trailing backslash');
  check(H.stripTrailingSeps('C:\\proj/', true) === 'C:\\proj', 'win trailing slash');
  check(H.stripTrailingSeps('/home/p/', false) === '/home/p', 'posix trailing slash');
  check(H.stripTrailingSeps('/home/p\\', false) === '/home/p\\', 'posix does not strip backslash');
}

console.log('# updater / probe / exact-pair (D1)');
{
  check(H.shouldSkipAutoUpdateProbe('win32') === true, 'probe skipped on win32');
  check(H.shouldSkipAutoUpdateProbe('darwin') === false, 'probe allowed on darwin');
  check(H.shouldSkipAutoUpdateProbe('linux') === false, 'probe allowed on linux');
  const need = H.exactWinAssetNames('2.16.1', 'x64');
  check(need[0] === 'FanBox-2.16.1-win-x64.exe' && need[1] === 'FanBox-2.16.1-win-x64-portable.exe',
    'exact pair names', JSON.stringify(need));
  check(H.verifiedWinAssetList(['FanBox-2.16.1-win-x64.exe'], '2.16.1', 'x64').length === 0,
    'single asset fails closed');
  check(H.verifiedWinAssetList(['FanBox-2.16.1-win-x64.exe', 'FanBox-2.16.1-win-x64-portable.exe'], '2.16.1', 'x64').length === 2,
    'exact pair accepted');
  check(H.verifiedWinAssetList(['FanBox-2.16.1-win-arm64.exe', 'FanBox-2.16.1-win-arm64-portable.exe'], '2.16.1', 'x64').length === 0,
    'wrong arch fails closed');
}

console.log('# localImageAbs + NO_PROXY');
{
  check(H.localImageAbs('cover.png', 'C:\\proj\\docs') === 'C:\\proj\\docs\\cover.png', 'relative folds onto docDir');
  check(H.localImageAbs('C:\\Users\\a\\x.png', 'C:\\proj').toLowerCase() === 'c:\\users\\a\\x.png',
    'drive-absolute kept', H.localImageAbs('C:\\Users\\a\\x.png', 'C:\\proj'));
  const env = H.appendNoProxy({ PATH: 'x' });
  check(/127\.0\.0\.1/.test(env.NO_PROXY) && /localhost/.test(env.NO_PROXY), 'NO_PROXY append', env.NO_PROXY);
}

console.log('# shipped source assertions');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const pkgRaw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);

  const execSnap = server.slice(server.indexOf('function execSnap'), server.indexOf('function snapEligible'));
  check(/gitExe\(\)/.test(execSnap) && /winSpawnEnv\(\)/.test(execSnap),
    'execSnap Windows arm uses gitExe()+winSpawnEnv()');
  check(/code: -1/.test(execSnap), 'execSnap returns code:-1 when git missing');
  check(/execFile\('git'/.test(execSnap), 'execSnap POSIX still spawns literal git');

  const baseBlob = server.slice(server.indexOf('function baseBlob'), server.indexOf('async function changeStat'));
  check(/gitExe\(\)/.test(baseBlob) && /winSpawnEnv\(\)/.test(baseBlob) && /encoding:'buffer'/.test(baseBlob.replace(/\s/g, '')),
    'baseBlob Windows arm uses gitExe()+winSpawnEnv() with encoding buffer');
  check(/execFile\('git'/.test(baseBlob), 'baseBlob POSIX still spawns literal git');

  const gen = server.slice(server.indexOf('async function generateThumb'), server.indexOf('// 缩略图缓存按总体积上限'));
  check(/await run\(magick/.test(gen) && /await run\(ffmpeg/.test(gen),
    'Windows thumbs go through run()');
  check(/function run\(cmd, args, opts\)/.test(server), 'run() accepts optional third opts param');

  const snapClean = server.slice(server.indexOf('async function snapClean'), server.indexOf('async function snapResolveProject'));
  check(/PLATFORM === 'win32' \? \/\[\\\\\/\]\+\$\/ : \/\\\/\+\$\//.test(snapClean)
    || /win32 \? \/\[\\\/\]\+\$\//.test(snapClean),
    'snapClean uses win32 trailing-sep regex', snapClean.slice(snapClean.indexOf('replace'), snapClean.indexOf('replace') + 80));

  check((app.match(/function mdHtml\(/g) || []).length === 1, 'exactly one mdHtml');
  check((app.match(/const powerBar =/g) || []).length === 1, 'exactly one powerBar');
  check(/ctrlKey && e.altKey/.test(app) && /Ctrl\+Alt\+M/.test(app), 'Ctrl+Alt+M maximize mapping');
  check(/localImageAbs/.test(app), 'fixLocalImages calls localImageAbs');

  check(/shouldSkipAutoUpdateProbe\(process\.platform\)/.test(main), 'probeAutoUpdate short-circuits via helper');
  check(/autoUpdater\.on\('error'/.test(main), 'autoUpdater error listener registered');
  check(/claudeHttpHookSettings\(PORT\)/.test(main), 'Windows writeHookFiles uses HTTP settings');
  check(/appendNoProxy/.test(main), 'PTY env appends NO_PROXY');

  const filesOcc = (pkgRaw.match(/"files"\s*:/g) || []).length;
  check(filesOcc === 1, 'package.json has a single files key', 'count=' + filesOcc);
  check(pkg.scripts['dist:win'] && /--publish never/.test(pkg.scripts['dist:win']),
    'dist:win restored with --publish never', pkg.scripts['dist:win']);
  check(pkg.scripts['dist:win:arm64'] && /--publish never/.test(pkg.scripts['dist:win:arm64']),
    'dist:win:arm64 restored with --publish never');
  check(Array.isArray(pkg.build.files) && pkg.build.files.some((x) => /node-pty/.test(x))
    && pkg.build.files.some((x) => /experiments/.test(x)),
    'files array merges upstream exclusions and node-pty exclusions');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

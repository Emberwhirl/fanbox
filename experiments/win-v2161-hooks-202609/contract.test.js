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
  check(nf === ' -c "notify=[\\"C:/nodejs/node.exe\\",\\"C:/Users/a/.fanbox/hooks/codex-notify.js\\"]"',
    'reserved Codex notify argv is the CRT-quoted form with forward slashes', JSON.stringify(nf));
  const na = H.codexNotifyArgv('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a\\.fanbox\\hooks\\codex-notify.js');
  check(Array.isArray(na) && na.length === 2 && na[0] === '-c', 'codexNotifyArgv is a two-slot pair', JSON.stringify(na));
  check(na[1] === 'notify=["C:/Program Files/nodejs/node.exe","C:/Users/a/.fanbox/hooks/codex-notify.js"]',
    'notify JSON is one argv slot (spaces in node.exe stay inside the quotes)', na[1]);
  const js = H.buildCodexNotifyJs();
  check(js.indexOf('http.request') >= 0 && js.indexOf('x-fanbox-token') >= 0, 'generated notify script POSTs with headers');
  check(!/"[0-9a-f]{24}"/.test(js), 'notify script contains no token literal');
}

console.log('# buildCodexSpawnSpec argv spawn (Approach 1)');
{
  const os = require('os');
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-codex-argv-'));
  const bin = path.join(tmp, 'bin');
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const hooks = path.join(tmp, 'hooks');
  const dump = path.join(tmp, 'argv.json');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  const nodeExe = process.execPath;
  const nodeDir = path.dirname(nodeExe);
  const nodeName = path.basename(nodeExe);
  fs.writeFileSync(path.join(bin, 'codex.cmd'),
    '@ECHO off\r\n"' + nodeName + '" "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  fs.writeFileSync(entry, [
    "'use strict';",
    "const fs = require('fs');",
    "fs.writeFileSync(process.env.FANBOX_ARGV_DUMP, JSON.stringify(process.argv.slice(2)), 'utf8');",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(hooks, 'codex-notify.js'), H.buildCodexNotifyJs());
  const env = {
    Path: bin + path.delimiter + nodeDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
    PATH: bin + path.delimiter + nodeDir + path.delimiter + (process.env.PATH || ''),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  const prompt = "backup logs & prune 'old' ones";
  const spec = H.buildCodexSpawnSpec({
    env,
    execPath: nodeExe,
    notifyScript: path.join(hooks, 'codex-notify.js'),
    extraArgs: ['--full-auto', prompt],
  });
  check(!!spec && spec.file, 'spawn spec resolves a file', JSON.stringify(spec && { file: spec.file, n: spec.args && spec.args.length }));
  check(spec && spec.args && spec.args.indexOf('-c') >= 0, 'spawn spec includes -c', spec && spec.args && spec.args.join(' | '));
  const cIdx = spec ? spec.args.indexOf('-c') : -1;
  const notifyVal = cIdx >= 0 ? spec.args[cIdx + 1] : '';
  check(/^notify=\["[^"]+","[^"]+"\]$/.test(notifyVal) && notifyVal.indexOf('codex-notify.js') >= 0,
    'notify value is one JSON-array slot pointing at the script', notifyVal);
  check(spec && spec.args[spec.args.length - 1] === prompt,
    'cron prompt with & and quotes is its own argv slot (not joined into a shell string)',
    spec && spec.args[spec.args.length - 1]);
  check(spec && spec.args[spec.args.length - 2] === '--full-auto', '--full-auto stays a separate slot');
  const ran = spawnSync(spec.file, spec.args, {
    env: Object.assign({}, process.env, env, spec.extraEnv || {}, { FANBOX_ARGV_DUMP: dump }),
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  check(!ran.error && ran.status === 0, 'spawnSync of the spec runs the shim', (ran.error && ran.error.message) || ran.stderr || ('status=' + ran.status));
  let dumped = [];
  try { dumped = JSON.parse(fs.readFileSync(dump, 'utf8')); } catch (e) { dumped = ['parse-fail:' + e.message]; }
  check(Array.isArray(dumped) && dumped.indexOf('-c') >= 0, 'shim received -c in argv', JSON.stringify(dumped));
  const di = dumped.indexOf('-c');
  check(di >= 0 && dumped[di + 1] === notifyVal, 'shim received the notify JSON as one argument (quotes intact)', JSON.stringify(dumped[di + 1]));
  check(dumped[dumped.length - 1] === prompt, 'shim received the prompt byte-exact as the last argument', JSON.stringify(dumped[dumped.length - 1]));
  const noNodeEnv = { Path: bin, PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const specNoNode = H.buildCodexSpawnSpec({
    env: noNodeEnv,
    execPath: nodeExe,
    notifyScript: path.join(hooks, 'codex-notify.js'),
    extraArgs: ['hi'],
  });
  check(!!specNoNode && specNoNode.args.indexOf('-c') >= 0,
    'without node.exe on PATH, notify still uses execPath (Electron-as-node)', specNoNode && specNoNode.args.join(' | '));
  check(H.buildCodexSpawnSpec({ env: { Path: '', PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, extraArgs: [] }) === null,
    'missing Codex CLI returns null (no PowerShell fallback)');
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

  // D3 argv: typed `-c notify=[…]` still empty on win32; launch is pty.spawn with a real argv
  check(/function codexHooksFlag\(\) \{[^]*?if \(PLATFORM === 'win32'\) return '';/.test(server), 'server codexHooksFlag returns empty on win32 (never typed into a shell)');
  check(/function winCodexHooksFlag\(\) \{[^]*?return '';/.test(app), 'renderer winCodexHooksFlag returns empty (never typed into a shell)');
  const wh = main.slice(main.indexOf('function writeHookFiles'), main.indexOf('function codexUserNotify'));
  check(/codex-notify\.js/.test(wh) && /buildCodexNotifyJs\(\)/.test(wh), 'Windows writeHookFiles writes codex-notify.js');
  check(/buildCodexSpawnSpec\(/.test(main) && /agent === 'codex'/.test(main), 'main argv-spawns Codex via buildCodexSpawnSpec');
  check(/termAgentKind/.test(main) && /spawnCodexInDir/.test(app), 'agent PTY kind is tracked; renderer has spawnCodexInDir');
  check(/createOpts\.agent = 'codex'/.test(server) && /extraArgs/.test(server), 'cron Codex on win32 uses extraArgs, not a typed notify flag');
  // hooks flag only when the file exists (claude exits on a missing --settings)
  const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
  check(/hooksReady: process\.platform === 'win32' \? !!ipcRenderer\.sendSync\('env:hooksReady'\)/.test(preload), 'preload exposes fanboxEnv.hooksReady');
  check(/ipcMain\.on\('env:hooksReady'/.test(main) && /claude-settings\.json/.test(main.slice(main.indexOf("ipcMain.on('env:hooksReady'"), main.indexOf("ipcMain.on('env:hooksReady'") + 400)), 'main answers env:hooksReady from the hooks dir');
  check(/function winClaudeHooksFlag\(\) \{\s*if \(!\(window\.fanboxEnv && window\.fanboxEnv\.hooksReady\)\) return '';/.test(app), 'renderer gates --settings on hooksReady');
  // Windows quit/sleep: idle shells are not active agents; unknown probe still counts as busy
  const aat = main.slice(main.indexOf('function activeAgentTerms'), main.indexOf('function termBusyAny'));
  check(/winProbeKids\(p && p\.pid\)/.test(aat) && /kids\.length === 0\) continue;/.test(aat), 'activeAgentTerms consults the cached child-process probe on win32');
  check(/function winProbeKids\(pid\) \{\s*if \(winProbeStale\(\)\) \{ winPtyChildMap\(\)/.test(main), 'stale probe returns unknown and refreshes');
  const bq = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('window-all-closed'"));
  check(/IS_WIN && !quitConfirmed && terminals\.size && winProbeStale\(\)/.test(bq) && /winPtyChildMap\(\)\.catch\(\(\) => null\)\.then\(\(\) => app\.quit\(\)\)/.test(bq), 'before-quit refreshes a stale probe before deciding on win32');
  check(/IS_WIN && !isQuitting && !quitConfirmed && terminals\.size\) \{ e\.preventDefault\(\); app\.quit\(\); \}/.test(main), 'window close on win32 routes through before-quit');

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

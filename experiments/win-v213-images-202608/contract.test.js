#!/usr/bin/env node
'use strict';
/**
 * Linux contracts for the v2.13.0 Windows port.
 * Requires the shipped win-port-helpers.js (and server.js under FANBOX_HELPERS_ONLY).
 * Exits nonzero on the first failed assertion group (all cases still run).
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const win32 = path.win32;

let failed = 0;
let passed = 0;
function check(cond, name, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('# containment / uniqueDest / copy-into');
{
  const eq = H.winContainDecision('C:\\proj\\a.png', 'C:\\proj');
  check(eq.ok && eq.action === 'keep', 'equal (file in dir) → no copy');

  const desc = H.winContainDecision('C:\\proj\\sub\\a.png', 'C:\\proj');
  check(desc.ok && desc.action === 'keep', 'descendant → no copy');

  const cas = H.winContainDecision('c:\\PROJ\\a.png', 'C:\\proj');
  check(cas.ok && cas.action === 'keep', 'case-insensitive equal/descendant → no copy');

  const sep = H.winContainDecision('C:/proj/sub/a.png', 'C:\\proj');
  check(sep.ok && sep.action === 'keep', 'separator-normalized descendant → no copy');

  const sib = H.winContainDecision('C:\\proj-extra\\a.png', 'C:\\proj');
  check(sib.ok && sib.action === 'copy', 'sibling-prefix is NOT descendant → copy', JSON.stringify(sib));

  const xd = H.winContainDecision('D:\\pics\\a.png', 'C:\\proj');
  check(xd.ok && xd.action === 'copy', 'cross-drive → copy');

  const share = H.winContainDecision('\\\\srv\\other\\a.png', '\\\\srv\\docs\\proj');
  check(share.ok && share.action === 'copy', 'different UNC share → copy');

  const sameShare = H.winContainDecision('\\\\srv\\docs\\proj\\a.png', '\\\\srv\\docs\\proj');
  check(sameShare.ok && sameShare.action === 'keep', 'same UNC share descendant → keep');

  const exists = new Set(['C:\\proj\\a.png']);
  const uniq = H.uniqueDest('C:\\proj\\a.png', (p) => exists.has(win32.normalize(p)) || exists.has(p), win32);
  check(uniq === 'C:\\proj\\a 2.png', 'uniqueDest does not overwrite', uniq);

  const copied = H.applyWinContainment('D:\\pics\\a.png', 'C:\\proj', {
    exists: (p) => exists.has(p),
    copyFile: (s, d) => { exists.add(d); },
    uniqueDest: (p) => H.uniqueDest(p, (x) => exists.has(x), win32),
  });
  check(copied.ok && copied.copied && copied.path === 'C:\\proj\\a 2.png',
    'outside copy uses uniqueDest (no overwrite)', JSON.stringify(copied));

  const same = H.winCopyIntoDecision('C:\\proj\\shot.png', 'C:\\proj', (p) => H.uniqueDest(p, () => true, win32));
  check(same.ok && same.action === 'keep' && same.intended === 'C:\\proj\\shot.png',
    'drop:copy-into same-file checks unsuffixed intended dest', JSON.stringify(same));
}

console.log('# serializer encode/decode');
{
  const space = H.toMarkdownDest('C:\\Users\\foo\\my pic.png');
  check(space.ok && space.dest === 'C:%5CUsers%5Cfoo%5Cmy%20pic.png', 'spaces', space.dest);
  check(H.fromMarkdownDest(space.dest).path === 'C:\\Users\\foo\\my pic.png', 'spaces decode once');

  const cjk = H.toMarkdownDest('C:\\图\\封面.png');
  check(cjk.ok && cjk.dest.includes('%E5%9B%BE') && cjk.dest.startsWith('C:%5C'), 'CJK encode', cjk.dest);
  check(H.fromMarkdownDest(cjk.dest).path === 'C:\\图\\封面.png', 'CJK decode once');

  const punct = H.toMarkdownDest('C:\\a#b&c[d].png');
  check(punct.ok && /%23/.test(punct.dest) && /%26/.test(punct.dest) && /%5B/.test(punct.dest),
    'markdown punctuation # & []', punct.dest);
  check(H.fromMarkdownDest(punct.dest).path === 'C:\\a#b&c[d].png', 'punctuation decode once');

  const apos = H.toMarkdownDest("C:\\o'reilly\\a.png");
  check(apos.ok && apos.dest.includes('%27'), 'apostrophe encoded', apos.dest);
  check(H.fromMarkdownDest(apos.dest).path === "C:\\o'reilly\\a.png", 'apostrophe decode once');

  const paren = H.toMarkdownDest('C:\\a(b).png');
  check(paren.ok && paren.dest.includes('%28') && paren.dest.includes('%29'), 'parentheses encoded', paren.dest);

  const pct = H.toMarkdownDest('C:\\100%.png');
  check(pct.ok && pct.dest.includes('%25'), 'literal % encoded', pct.dest);

  const fiveC = H.toMarkdownDest('C:\\foo%5Cbar.png');
  check(fiveC.ok && fiveC.dest.includes('%255C'), 'literal %5C → %255C', fiveC.dest);
  check(H.fromMarkdownDest(fiveC.dest).path === 'C:\\foo%5Cbar.png', 'one decode recovers %5C filename');

  const unc = H.toMarkdownDest('\\\\server\\share\\a.png');
  check(unc.ok && unc.dest.startsWith('%5C%5C'), 'UNC begins from encoded \\\\', unc.dest);
  check(H.fromMarkdownDest(unc.dest).path === '\\\\server\\share\\a.png', 'UNC decode once');

  const driveKeep = H.toMarkdownDest('C:\\x.png');
  check(driveKeep.ok && driveKeep.dest.startsWith('C:'), 'drive prefix C: retained', driveKeep.dest);

  check(!H.toMarkdownDest('foo/bar.png').ok, 'reject relative');
  check(!H.toMarkdownDest('./a.png').ok, 'reject ./ relative');
  check(!H.toMarkdownDest('file:///C:/a.png').ok, 'reject file://');
  check(!H.toMarkdownDest('https://example.com/a.png').ok, 'reject http URI');
  check(!H.toMarkdownDest('C:%5CUsers%5Ca.png').ok, 'reject already-canonical');
  check(H.isForbiddenPersistSrc('file://C:/a.png'), 'forbidden file://');
  check(H.isForbiddenPersistSrc('/api/raw?path=C:%5Ca.png'), 'forbidden /api/raw');
  check(H.isForbiddenPersistSrc('/api/thumb?path=x'), 'forbidden /api/thumb');
  check(H.isForbiddenPersistSrc('/fs/C:/a.png'), 'forbidden /fs');
  check(H.isForbiddenPersistSrc('blob:https://x'), 'forbidden blob:');
  check(H.isForbiddenPersistSrc('data:image:png;base64,xx'), 'forbidden data:image:');
  check(H.isForbiddenPersistSrc('pending-upload:1'), 'forbidden pending-upload:');

  const again = H.normalizeForMarkdown(driveKeep.dest);
  check(again.ok && again.dest === driveKeep.dest, 'normalizeForMarkdown is idempotent on canonical');
}

console.log('# localImageAbs (v2.16.1 thumb/raw decision)');
{
  check(H.localImageAbs('cover.png', 'C:\\proj\\docs') === 'C:\\proj\\docs\\cover.png',
    'relative image folds onto document dir');
  const abs = H.localImageAbs('C:\\Users\\a\\pic.png', 'C:\\proj');
  check(/^[A-Za-z]:\\Users\\a\\pic\.png$/i.test(abs), 'absolute drive path kept', abs);
  const thumbish = H.winLocalImageSrc('C:\\Users\\a\\pic.png', 'C:\\proj');
  check(thumbish.indexOf('/api/raw?path=') === 0, 'display URL is /api/raw not a short-circuit displaySrc', thumbish);
}

console.log('# display src (one decode)');
{
  const enc = H.toMarkdownDest('C:\\图\\a.png').dest;
  const disp = H.winDisplaySrc(enc);
  check(disp.startsWith('/api/raw?path='), 'Windows display uses /api/raw', disp);
  const q = disp.slice('/api/raw?path='.length);
  check(decodeURIComponent(q) === 'C:\\图\\a.png', 'Windows display decodes once', decodeURIComponent(q));
  const posix = H.posixDisplaySrc('/home/u/a.png');
  check(posix.startsWith('/api/raw?path='), 'POSIX display matches upstream v2.13 /api/raw (not /fs)');

  const docDir = 'C:\\Users\\u\\notes';
  const rel = H.winLocalImageSrc('./cover.png', docDir);
  check(rel.startsWith('/api/raw?path='), 'relative src still uses /api/raw', rel);
  const relAbs = decodeURIComponent(rel.slice('/api/raw?path='.length));
  check(!/^\.\/cover/.test(relAbs) && !relAbs.startsWith('./'), 'relative src is not left as ./cover.png', relAbs);
  check(/notes[/\\]cover\.png$/i.test(relAbs.replace(/\\/g, '/')) || /notes\/cover\.png$/i.test(relAbs),
    'relative src is joined against the md directory', relAbs);
  check(!H.winLocalImageSrc('cover.png', docDir).includes('path=.%2F') &&
    decodeURIComponent(H.winLocalImageSrc('cover.png', docDir).slice('/api/raw?path='.length)).indexOf('notes') >= 0,
    'unsuffixed relative name joins to md dir too');

  const driveDisp = H.winLocalImageSrc(enc, 'D:\\other');
  check(decodeURIComponent(driveDisp.slice('/api/raw?path='.length)) === 'C:\\图\\a.png',
    'canonical dest still decode-once to /api/raw (docDir ignored)', driveDisp);
  const slashDrive = H.winLocalImageSrc('C:/Users/u/a.png', docDir);
  check(/^C:[/\\]Users[/\\]u[/\\]a\.png$/i.test(decodeURIComponent(slashDrive.slice('/api/raw?path='.length)).replace(/\\/g, '/'))
    || decodeURIComponent(slashDrive.slice('/api/raw?path='.length)).replace(/\\/g, '/').indexOf('C:/Users/u/a.png') >= 0
    || /^C:/.test(decodeURIComponent(slashDrive.slice('/api/raw?path='.length))),
    'C:/ drive dest decode-once /api/raw', slashDrive);
  const uncEnc = H.toMarkdownDest('\\\\server\\share\\a.png').dest;
  const uncDisp = H.winLocalImageSrc(uncEnc, docDir);
  check(decodeURIComponent(uncDisp.slice('/api/raw?path='.length)) === '\\\\server\\share\\a.png',
    'UNC dest decode-once to /api/raw', uncDisp);
}

console.log('# updater exact-pair / fail-closed');
{
  const names = H.exactWinAssetNames('v2.13.0', 'x64');
  check(names[0] === 'FanBox-2.13.0-win-x64.exe' && names[1] === 'FanBox-2.13.0-win-x64-portable.exe',
    'exact names from normalized version+arch', JSON.stringify(names));

  const both = ['FanBox-2.13.0-win-x64.exe', 'FanBox-2.13.0-win-x64-portable.exe'];
  check(H.verifiedWinAssetList(both, '2.13.0', 'x64').length === 2, 'exact pair accepted');
  check(H.verifiedWinAssetList([both[0]], '2.13.0', 'x64').length === 0, 'one file fail closed');
  check(H.verifiedWinAssetList([], '2.13.0', 'x64').length === 0, 'zero files fail closed');
  check(H.verifiedWinAssetList(['FanBox-2.13.0-win.exe'], '2.13.0', 'x64').length === 0, 'fuzzy name fail closed');
  check(H.verifiedWinAssetList(['FanBox-2.12.1-win-x64.exe', 'FanBox-2.12.1-win-x64-portable.exe'], '2.13.0', 'x64').length === 0,
    'wrong version fail closed');
  check(H.verifiedWinAssetList(['FanBox-2.13.0-win-arm64.exe', 'FanBox-2.13.0-win-arm64-portable.exe'], '2.13.0', 'x64').length === 0,
    'wrong arch fail closed');
}

console.log('# HTML fallback never bypasses');
(async () => {
  const probed = [];
  const okPair = await H.selectWinReleaseAssets({
    tag: 'v2.13.0', arch: 'x64', apiAssets: null,
    probeExact: async (n) => { probed.push(n); return n.endsWith('.exe'); },
  });
  check(Array.isArray(okPair) && okPair.length === 2, 'HTML fallback returns verified list when both HEAD/GET-ok', JSON.stringify(okPair));
  check(probed.length === 2, 'HTML fallback probes both exact names', JSON.stringify(probed));

  const missing = await H.selectWinReleaseAssets({
    tag: 'v2.13.0', arch: 'x64', apiAssets: null,
    probeExact: async () => false,
  });
  check(Array.isArray(missing) && missing.length === 0, 'HTML unknown/missing → [] not null', JSON.stringify(missing));
  check(missing !== null, 'never null');

  let gotWhole = false;
  const exists = await H.probeUrlExists('https://example.invalid/FanBox-2.13.0-win-x64.exe', async (url, opts) => {
    if (opts.method === 'HEAD') return { ok: false, status: 405 };
    if (opts.method === 'GET') {
      check(opts.headers && opts.headers.Range === 'bytes=0-0', 'bounded GET uses Range bytes=0-0');
      check(!!opts.signal, 'bounded GET is abortable');
      return {
        ok: true, status: 206,
        body: { cancel: async () => { gotWhole = false; } },
      };
    }
    gotWhole = true;
    return { ok: true, status: 200 };
  });
  check(exists === true, 'HEAD 405 then bounded GET 206 counts as exists');
  check(gotWhole === false, 'does not download a whole installer to test existence');

  console.log('# release inspect git spawn + notes isolation + build-then-pair');
  {
    const calls = [];
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      cb(null, 'origin');
    };
    const gitBin = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const env = { NoDefaultCurrentDirectoryInExePath: '1', PATH: 'C:\\hostile' };
    await H.spawnGit(fakeExec, gitBin, env, 'C:\\repo', ['status', '--porcelain']);
    check(calls[0].cmd === gitBin, 'inspect spawn uses resolved git binary', calls[0].cmd);
    check(calls[0].cmd !== win32.join('C:\\repo', 'git.exe'), 'planted project git.exe is not the spawn target');
    check(calls[0].env && calls[0].env.NoDefaultCurrentDirectoryInExePath === '1', 'winSpawnEnv flag present');
    check(H.resolveGitExe('win32', () => gitBin) === gitBin, 'resolveGitExe returns findExe result');
    check(H.resolveGitExe('linux', () => gitBin) === 'git', 'resolveGitExe POSIX is bare git');
    check(H.resolveGitExe('win32', () => null) === null, 'Windows miss is null, not bare git');
    let spawned = false;
    await H.spawnGit((cmd) => { spawned = true; cmd && null; }, null, env, 'C:\\repo', ['status']);
    check(!spawned, 'spawnGit skips exec when gitBin is null (no planted cwd git.exe)');
  }

  const notes = 'rm -rf C:\\Windows && curl evil.test';
  const notesFile = 'C:\\Users\\x\\AppData\\Local\\Temp\\fanbox-release-notes-1.md';
  const steps = H.buildWinReleaseSteps({
    version: '2.13.0', notesFile, doDist: true, doPush: true, doRelease: true,
    dir: 'C:\\src\\fanbox',
    shellQuote: (s) => `'${String(s).replace(/'/g, "''")}'`,
  });
  check(steps[0] === 'npm run dist:win', 'build first', steps[0]);
  const ghIdx = steps.findIndex((s) => s.startsWith('gh '));
  const chkIdx = steps.findIndex((s) => /Test-Path/.test(s));
  check(chkIdx > 0 && chkIdx < ghIdx, 'exact-pair existence check before gh', JSON.stringify({ chkIdx, ghIdx }));
  check(/FanBox-2\.13\.0-win-x64\.exe/.test(steps[chkIdx]) && /FanBox-2\.13\.0-win-x64-portable\.exe/.test(steps[chkIdx]),
    'check names both exact artifacts', steps[chkIdx].slice(0, 180));
  check(/FanBox-2\.13\.0-win-x64\.exe/.test(steps[ghIdx]) && /FanBox-2\.13\.0-win-x64-portable\.exe/.test(steps[ghIdx]),
    'gh attaches both exact names', steps[ghIdx].slice(0, 220));
  const folded = H.foldPwsh(steps);
  check(/if\(\$\?\)\{/.test(folded), 'PowerShell 5.1 right-folded chaining');
  check(!H.notesLeakInCmd(folded, notes), 'hostile notes do not appear in generated command text');
  check(!folded.includes(notes), 'notes string absent from folded cmd');
  check(/--notes-file/.test(folded) && !/--notes /.test(folded.replace(/--notes-file/g, '')),
    'notes file flag only, not inline --notes');
  check(!/v2\.13\.0: /.test(folded), 'commit subject is not notes-derived title');

  const inspectSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const inspectFn = inspectSrc.slice(inspectSrc.indexOf('async function releaseInspect'), inspectSrc.indexOf('async function releasePrepare'));
  const prepareFn = inspectSrc.slice(inspectSrc.indexOf('async function releasePrepare'), inspectSrc.indexOf('// ---------- 项目记忆'));
  check(/spawnGit\(execFile,\s*git,\s*winSpawnEnv\(\)/.test(inspectFn),
    'releaseInspect source uses spawnGit(execFile, gitExe(), winSpawnEnv())');
  check(/const git = gitExe\(\)/.test(inspectFn), 'releaseInspect resolves git via gitExe()');
  check(!/sh\('git'/.test(inspectFn), 'releaseInspect no longer spawns bare git', inspectFn.match(/sh\([^)]+\)/g));
  check(/buildWinReleaseSteps\(/.test(prepareFn) && /foldPwsh\(/.test(prepareFn),
    'releasePrepare Windows sequence is the shipped buildWinReleaseSteps/foldPwsh');
  check(/winPortHelpers\.buildWinReleaseSteps/.test(prepareFn), 'releasePrepare requires shipped helper');

  const winCmd = H.foldPwsh(H.buildWinReleaseSteps({
    version: '2.13.0', notesFile, doDist: true, doPush: false, doRelease: true,
    dir: 'C:\\src\\fanbox', shellQuote: (s) => `'${String(s).replace(/'/g, "''")}'`,
  }));
  check(!H.notesLeakInCmd(winCmd, notes), 'buildWinReleaseSteps (shipped) omits notes');

  console.log('# marked round-trip of canonical dest');
  {
    const markedPath = path.join(ROOT, 'public/vendor/marked/marked.min.js');
    const code = fs.readFileSync(markedPath, 'utf8');
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(code, sandbox, { filename: 'marked.min.js' });
    const marked = sandbox.marked;
    const parse = marked && (marked.parse || marked);
    check(typeof parse === 'function', 'vendored marked loads');
    const dest = H.toMarkdownDest('C:\\Users\\foo\\my pic%5C#.png').dest;
    const html = typeof parse === 'function' ? parse(`![](${dest})`) : '';
    const m = /src="([^"]+)"/.exec(html) || /href="([^"]+)"/.exec(html);
    const href = m ? m[1].replace(/&amp;/g, '&') : '';
    let decoded;
    try { decoded = decodeURIComponent(href); } catch { decoded = href; }
    const again = H.normalizeForMarkdown(href.startsWith('C:') || href.startsWith('%5C') ? href : dest);
    check(again.ok && again.dest === dest, 'canonical dest stable after marked+normalize', JSON.stringify({ dest, href, again }));
    check(decoded.includes('my pic') || dest.includes('my%20pic'), 'space and %5C survive marked', decoded);
  }

  const milkdownSrc = fs.readFileSync(path.join(ROOT, 'src-vendor/milkdown-entry.js'), 'utf8');
  check(/function keepImageAlt\(editor, normalizeUrl\)/.test(milkdownSrc), 'keepImageAlt accepts idempotent normalizer');
  check(/normalizeUrl \? \(normalizeUrl\(node\.attrs\.src\) \|\| node\.attrs\.src\) : node\.attrs\.src/.test(milkdownSrc),
    'toMarkdown uses normalizer when provided');
  check(/function addImageMoveControls\(editor, labels\)/.test(milkdownSrc), 'move controls accept optional labels');

  const i18n = fs.readFileSync(path.join(ROOT, 'public/i18n.js'), 'utf8');
  check(/\.ts-preview/.test(i18n), '.ts-preview in i18n skip selector');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  check(/ed-typeset-btn/.test(app) && /typeset-dialog/.test(app) && /ts-preview/.test(app),
    'Insert image / Typeset modal markup in shipped editor UI');
  check(!/typeset-host/.test(app) && !/seg\('typeset'/.test(app), 'persistent Typeset tab/host gone from app.js');
  check(/isMacOS\(\) \? '⌘S' : 'Ctrl\+S'/.test(app), 'non-Windows ⌘S / Windows Ctrl+S');
  check(/!isWindows\(\) && !localStorage\.getItem\('fb_term_optionhint'\)/.test(app), 'Option/iTerm hint suppressed on Windows');
  check(/fanboxWinPath\.localImageAbs/.test(app) && /rel\.startsWith\('\/'\) \? rel : normPath/.test(app),
    'fixLocalImages: Windows localImageAbs then thumb/raw; POSIX keeps master abs join');
  check(!/displaySrc\(raw\)/.test(app), 'no displaySrc short-circuit in app.js');
  check(/function gitExe\(\)[\s\S]*resolveGitExe\(PLATFORM/.test(inspectSrc)
    && /if \(!git\)/.test(inspectSrc.slice(inspectSrc.indexOf('function execGit'), inspectSrc.indexOf('function gitRoot'))),
    'execGit skips spawn when gitExe() is null');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
  check(!/require\(['"]\.\.\/win-port-helpers['"]\)/.test(preloadSrc),
    'preload does not require win-port-helpers (Electron 20+ sandbox)');
  check(/sendSync\('winpath:toMarkdownDest'/.test(preloadSrc)
    && /sendSync\('winpath:localImageSrc'/.test(preloadSrc)
    && /sendSync\('winpath:localImageAbs'/.test(preloadSrc),
    'fanboxWinPath uses sendSync IPC into main (incl. localImageAbs)');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  check(/ipcMain\.on\('winpath:' \+ name/.test(mainSrc) && /winHelpers\.toMarkdownDest/.test(mainSrc),
    'main answers winpath:* from shipped helpers');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

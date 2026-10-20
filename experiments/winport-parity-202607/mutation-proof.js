#!/usr/bin/env node
'use strict';
/**
 * Mutation proof for the HARD checks in verify.js (v2.17.0 review follow-up).
 *
 *   node experiments/winport-parity-202607/mutation-proof.js [scratch-dir]
 *
 * Clones this repo into a scratch directory (git clone --local; the checkout you run it from is
 * never modified), recreates the `master` branch there, overlays the working-tree copies of the
 * files under test, then:
 *   1. runs verify.js on the clean copy         -> must exit 0
 *   2. applies one mutation at a time, reruns   -> each must exit 1 and print a FAIL line
 * The first four mutations are the ones a reviewer applied to a clone while the scanner still
 * printed "All files pass": a changed condition in the POSIX update-failure dialog, a console.log
 * inside upstream's verbatim fetchLatestRelease, the curl ternary opened up to macOS, and an
 * unanchored catch-all i18n rule. The rest probe the neighbours of the same checks.
 * Exits 1 if the clean copy fails or any mutation goes unnoticed.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const VERIFY = 'experiments/winport-parity-202607/verify.js';
const OVERLAY = ['electron/main.js', 'server.js', 'public/i18n-dict.js', 'lib/claude-statusline.cjs', VERIFY];

const MUTATIONS = [
  { id: 'a', what: 'POSIX update-failure dialog: `else if (manual)` gains a condition', file: 'electron/main.js',
    from: '    } else if (manual) {\n      const choice', to: '    } else if (manual && updRetry >= 0) {\n      const choice' },
  { id: 'b', what: "console.log('x') inside upstream's verbatim fetchLatestRelease", file: 'electron/main.js',
    from: 'async function fetchLatestRelease() {\n', to: "async function fetchLatestRelease() {\n  console.log('x');\n" },
  { id: 'c', what: "usageRequest curl ternary becomes `PLATFORM !== 'darwin'`", file: 'server.js',
    from: "PLATFORM === 'win32' ? (winFindExe('curl.exe')", to: "PLATFORM !== 'darwin' ? (winFindExe('curl.exe')" },
  { id: 'd', what: 'unanchored catch-all rule in FANBOX_DICT_RULES', file: 'public/i18n-dict.js',
    from: 'window.FANBOX_DICT_RULES = [\n', to: 'window.FANBOX_DICT_RULES = [\n  [/已记录/, (m) => "Recorded"],\n' },
  { id: 'e', what: 'curl lookup reverts to the PATHEXT name `curl`', file: 'server.js',
    from: "winFindExe('curl.exe')", to: "winFindExe('curl')" },
  { id: 'f', what: 'POSIX failure dialog: openExternal target changed', file: 'electron/main.js',
    from: '      if (choice === 0) shell.openExternal(REL_PAGE);\n    } else if (updRetry < 3)', to: '      if (choice === 0) shell.openExternal(WIN_REL_PAGE);\n    } else if (updRetry < 3)' },
  { id: 'g', what: 'usageRequest POSIX options object edited (timeout)', file: 'server.js',
    from: '{ timeout: 14000, maxBuffer: 1024 * 1024, env: winSpawnEnv()', to: '{ timeout: 9000, maxBuffer: 1024 * 1024, env: winSpawnEnv()' },
  { id: 'h', what: 'rule anchored only on one side via top-level alternation `^a|b$`', file: 'public/i18n-dict.js',
    from: 'window.FANBOX_DICT_RULES = [\n', to: 'window.FANBOX_DICT_RULES = [\n  [/^已记录|完成$/, (m) => "Recorded"],\n' },
  { id: 'i', what: 'rule with the multiline flag', file: 'public/i18n-dict.js',
    from: 'window.FANBOX_DICT_RULES = [\n', to: 'window.FANBOX_DICT_RULES = [\n  [/^已记录$/m, (m) => "Recorded"],\n' },
  { id: 'j', what: 'upstream line removed from lib/claude-statusline.cjs (existing hard check)', file: 'lib/claude-statusline.cjs',
    from: "    if (parts.length) process.stdout.write(parts.join(' · ') + '\\n');\n", to: '' },
];

// This explicitly selected checkout can belong to another Windows SID. Scope its ownership
// exception to every command that reads this repo, never the global Git config — and exempt the
// work tree ROOT, not <ROOT>/.git: git validates the work tree too and matches safe.directory per
// validated path, so an entry for <ROOT>/.git does not exempt <ROOT>. Forward slashes keep the
// -c value unambiguous.
const SAFE_ROOT = ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function runVerify(dir) {
  const r = spawnSync(process.execPath, [VERIFY], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-parity-mut-'));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error(`scratch dir ${dir} is not empty`); process.exit(2); }
  const masterSha = git(ROOT, ...SAFE_ROOT, 'rev-parse', 'master').trim();
  git(ROOT, ...SAFE_ROOT, 'rev-parse', '--git-dir'); // fails early outside a git checkout
  // The clone also reads this checkout, so it carries the same command-scoped exception.
  execFileSync('git', SAFE_ROOT.concat(['clone', '--quiet', '--local', '--no-hardlinks', ROOT, dir]), { stdio: ['ignore', 'ignore', 'inherit'] });
  git(dir, 'branch', '-f', 'master', masterSha);
  for (const f of OVERLAY) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  console.log(`scratch clone: ${dir} (master = ${masterSha.slice(0, 7)})`);

  let failed = 0;
  const base = runVerify(dir);
  const baseOk = base.status === 0;
  console.log(`${baseOk ? 'ok  ' : 'FAIL'} clean copy exits ${base.status} (want 0)`);
  if (!baseOk) { console.log(base.out); failed++; }
  for (const m of MUTATIONS) {
    const file = path.join(dir, m.file), orig = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (orig.split(m.from).length !== 2) { console.log(`FAIL (${m.id}) ${m.what}: mutation anchor not found exactly once in ${m.file}`); failed++; continue; }
    fs.writeFileSync(file, orig.replace(m.from, () => m.to));
    const r = runVerify(dir);
    fs.writeFileSync(file, orig);
    const caught = r.status === 1 && /^FAIL /m.test(r.out);
    if (!caught) failed++;
    console.log(`${caught ? 'ok  ' : 'FAIL'} (${m.id}) exit ${r.status} (want 1)  ${m.what}`);
    if (caught) for (const l of r.out.split('\n').filter((x) => /^FAIL /.test(x))) console.log('        ' + l.slice(0, 150));
    else console.log(r.out.split('\n').slice(-4).join('\n'));
  }
  const after = runVerify(dir);
  console.log(`${after.status === 0 ? 'ok  ' : 'FAIL'} restored copy exits ${after.status} (want 0)`);
  if (after.status !== 0) failed++;
  if (!process.argv[2]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} mutation check(s) failed.` : `\nAll ${MUTATIONS.length} mutations are caught; the clean copy passes.`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

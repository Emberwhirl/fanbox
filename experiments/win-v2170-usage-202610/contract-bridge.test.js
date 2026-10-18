'use strict';
/**
 * Linux contracts for the Windows status-line bridge (plan v2.17.0, D1 + D2, 6.3 / 6.4 / 6.7 / 6.8).
 *
 *   node --test experiments/win-v2170-usage-202610/contract-bridge.test.js
 *
 * Drives the shipped code, nothing re-implemented:
 *   - win-port-helpers.js: winStatusLineCommand, winGitBash, claudeHttpHookSettings(port, opts)
 *   - electron/main.js writeHookFiles: its source is sliced out and run with fake fs/os/process
 *     (Electron cannot load on Linux), so the real Windows branch makes the decisions
 *   - lib/claude-statusline.cjs: loaded as a CommonJS body with a fake process (platform 'win32'
 *     or 'linux'), fake require (stub spawnSync, http, fs) and fake Intl, so production code
 *     carries no test hooks
 * Paths are path.win32 throughout; the fake file trees are plain sets of Windows paths.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const BRIDGE_FILE = path.join(ROOT, 'lib', 'claude-statusline.cjs');
const MAIN_FILE = path.join(ROOT, 'electron', 'main.js');
const BRIDGE_SRC = fs.readFileSync(BRIDGE_FILE, 'utf8');
const w = path.win32;

// A fake Windows file tree: case-insensitive set of paths.
function tree(paths) {
  const s = new Set(paths.map((p) => p.toLowerCase()));
  return { exists: (p) => s.has(String(p).toLowerCase()) };
}

const TOKEN = 'deadbeef'.repeat(6); // a token-shaped secret that must never appear in generated files

// ---------------------------------------------------------------------------
// winStatusLineCommand
// ---------------------------------------------------------------------------
test('winStatusLineCommand: forward slashes, single quotes, ELECTRON_RUN_AS_NODE prefix', () => {
  const cmd = H.winStatusLineCommand('C:\\Users\\u\\AppData\\Local\\Programs\\FanBox\\FanBox.exe', 'C:\\Users\\u\\.fanbox\\hooks\\claude-statusline.cjs');
  assert.equal(cmd, "ELECTRON_RUN_AS_NODE=1 'C:/Users/u/AppData/Local/Programs/FanBox/FanBox.exe' 'C:/Users/u/.fanbox/hooks/claude-statusline.cjs'");
  assert.ok(!cmd.includes('\\'), 'no backslash survives (Git Bash eats them)');
});

test('winStatusLineCommand: space + CJK path stays whole inside single quotes', () => {
  const cmd = H.winStatusLineCommand('E:\\fanbox test\\用户\\FanBox.exe', 'E:\\fanbox test\\用户\\.fanbox\\hooks\\claude-statusline.cjs');
  assert.equal(cmd, "ELECTRON_RUN_AS_NODE=1 'E:/fanbox test/用户/FanBox.exe' 'E:/fanbox test/用户/.fanbox/hooks/claude-statusline.cjs'");
});

test('winStatusLineCommand: $ and backtick are literal inside single quotes (left untouched)', () => {
  const cmd = H.winStatusLineCommand('C:\\a $HOME\\x`y\\FanBox.exe', 'C:\\a $HOME\\x`y\\s.cjs');
  assert.equal(cmd, "ELECTRON_RUN_AS_NODE=1 'C:/a $HOME/x`y/FanBox.exe' 'C:/a $HOME/x`y/s.cjs'");
});

test('winStatusLineCommand: an apostrophe in either path, or an empty path, returns null', () => {
  assert.equal(H.winStatusLineCommand("C:\\Users\\O'Brien\\FanBox.exe", 'C:\\h\\s.cjs'), null);
  assert.equal(H.winStatusLineCommand('C:\\FanBox.exe', "C:\\Users\\O'Brien\\.fanbox\\hooks\\s.cjs"), null);
  assert.equal(H.winStatusLineCommand('', 'C:\\h\\s.cjs'), null);
  assert.equal(H.winStatusLineCommand('C:\\FanBox.exe', ''), null);
  assert.equal(H.winStatusLineCommand(undefined, undefined), null);
});

test('winStatusLineCommand: the real quoting survives bash with space, CJK, $ and backtick in the path', { skip: !fs.existsSync('/usr/bin/bash') && !fs.existsSync('/bin/bash') }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-q-'));
  const dir = path.join(base, 'fanbox test', '用户 $HOME `x`');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'node'); fs.symlinkSync(process.execPath, exe);
  const script = path.join(dir, 'echo-args.cjs');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), ran: process.env.ELECTRON_RUN_AS_NODE }));');
  const cmd = H.winStatusLineCommand(exe, script);
  assert.ok(cmd);
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { argv: [], ran: '1' });
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claudeHttpHookSettings(port, opts)
// ---------------------------------------------------------------------------
test('claudeHttpHookSettings: unchanged without the option (2.16.1 shape, hooks only)', () => {
  const s = H.claudeHttpHookSettings(4567);
  assert.deepEqual(Object.keys(s), ['hooks']);
  assert.equal(s.hooks.SessionStart[0].hooks[0].url, 'http://127.0.0.1:4567/api/agent/event');
  assert.deepEqual(H.claudeHttpHookSettings(4567, {}), s);
  assert.deepEqual(H.claudeHttpHookSettings(4567, { statusLine: null }), s);
  assert.deepEqual(H.claudeHttpHookSettings(4567, { statusLine: '' }), s);
  assert.deepEqual(H.claudeHttpHookSettings(4567, { statusLine: 42 }), s);
});

test('claudeHttpHookSettings: statusLine option adds upstream-shaped { type: "command", command }', () => {
  const cmd = H.winStatusLineCommand('C:\\FanBox\\FanBox.exe', 'C:\\h\\claude-statusline.cjs');
  const s = H.claudeHttpHookSettings(4567, { statusLine: cmd });
  assert.deepEqual(s.statusLine, { type: 'command', command: cmd });
  assert.deepEqual(s.hooks, H.claudeHttpHookSettings(4567).hooks, 'hooks are identical with and without the status line');
});

test('claudeHttpHookSettings: no token literal, only $FANBOX_CTL_TOKEN references', () => {
  const cmd = H.winStatusLineCommand('C:\\FanBox\\FanBox.exe', 'C:\\h\\claude-statusline.cjs');
  const text = JSON.stringify(H.claudeHttpHookSettings(4567, { statusLine: cmd }));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!/[0-9a-f]{32,}/i.test(text), 'no long hex string');
  assert.ok(text.includes('$FANBOX_CTL_TOKEN'));
  assert.ok(!cmd.includes('FANBOX_CTL_TOKEN'), 'the status-line command itself carries no token reference');
});

// ---------------------------------------------------------------------------
// winGitBash
// ---------------------------------------------------------------------------
const PF = 'C:\\Program Files';
const BASH = PF + '\\Git\\bin\\bash.exe';

test('winGitBash: CLAUDE_CODE_GIT_BASH_PATH wins when the file exists', () => {
  const custom = 'D:\\工具 box\\Git\\bin\\bash.exe';
  const io = tree([custom, PF + '\\Git\\cmd\\git.exe', BASH]);
  const env = { CLAUDE_CODE_GIT_BASH_PATH: custom, Path: PF + '\\Git\\cmd', ProgramFiles: PF };
  assert.equal(H.winGitBash(env, io), custom);
});

test('winGitBash: a stale override falls through to the PATH search', () => {
  const io = tree([PF + '\\Git\\cmd\\git.exe', BASH]);
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe', Path: 'C:\\Windows\\System32;' + PF + '\\Git\\cmd' };
  assert.equal(H.winGitBash(env, io), BASH);
});

test('winGitBash: git.exe in <root>\\cmd maps to <root>\\bin\\bash.exe', () => {
  const io = tree([PF + '\\Git\\cmd\\git.exe', BASH]);
  assert.equal(H.winGitBash({ Path: 'C:\\Windows;' + PF + '\\Git\\cmd' }, io), BASH);
});

test('winGitBash: git.exe in <root>\\bin maps to <root>\\bin\\bash.exe', () => {
  const io = tree([PF + '\\Git\\bin\\git.exe', BASH]);
  assert.equal(H.winGitBash({ Path: PF + '\\Git\\bin' }, io), BASH);
});

test('winGitBash: git.exe in <root>\\mingw64\\bin maps to <root>\\bin\\bash.exe', () => {
  const io = tree([PF + '\\Git\\mingw64\\bin\\git.exe', BASH]);
  assert.equal(H.winGitBash({ Path: PF + '\\Git\\mingw64\\bin' }, io), BASH);
});

test('winGitBash: non-default install root with CJK and spaces, quoted PATH entry, PATHEXT honored', () => {
  const root = 'D:\\开发 tools\\Git';
  const io = tree([root + '\\cmd\\git.exe', root + '\\bin\\bash.exe']);
  const env = { Path: 'C:\\Windows;"' + root + '\\cmd"', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(H.winGitBash(env, io), root + '\\bin\\bash.exe');
});

test('winGitBash: git on PATH without a sibling bash falls back to %ProgramFiles%\\Git', () => {
  const io = tree(['E:\\scoop\\shims\\git.exe', BASH]);
  assert.equal(H.winGitBash({ Path: 'E:\\scoop\\shims', ProgramFiles: PF }, io), BASH);
});

test('winGitBash: %ProgramFiles% fallback, ProgramW6432 fallback, case-insensitive env names', () => {
  assert.equal(H.winGitBash({ Path: 'C:\\Windows', ProgramFiles: PF }, tree([BASH])), BASH);
  assert.equal(H.winGitBash({ Path: 'C:\\Windows', ProgramW6432: PF }, tree([BASH])), BASH);
  assert.equal(H.winGitBash({ Path: 'C:\\Windows', PROGRAMFILES: PF }, tree([BASH])), BASH);
  assert.equal(H.winGitBash({ Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: PF }, tree([BASH])), BASH);
});

test('winGitBash: not found returns null (no git, no ProgramFiles Git, no override)', () => {
  assert.equal(H.winGitBash({ Path: 'C:\\Windows;C:\\Windows\\System32', ProgramFiles: PF }, tree([])), null);
  assert.equal(H.winGitBash({}, tree([])), null);
  // git exists but there is no bash anywhere
  assert.equal(H.winGitBash({ Path: PF + '\\Git\\cmd', ProgramFiles: PF }, tree([PF + '\\Git\\cmd\\git.exe'])), null);
  // an existence check that throws counts as missing, never propagates
  assert.equal(H.winGitBash({ Path: PF + '\\Git\\cmd', CLAUDE_CODE_GIT_BASH_PATH: 'X:\\b.exe' }, { exists: () => { throw new Error('EACCES'); } }), null);
});

test('winFindOnPath without io keeps its real-filesystem behavior (lower-case PATHEXT: Linux fs is case-sensitive)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-fop-'));
  fs.writeFileSync(path.join(dir, 'gitx.exe'), '');
  assert.equal(H.winFindOnPath('gitx', { Path: dir, PATHEXT: '.com;.exe' }), path.join(dir, 'gitx.exe'));
  assert.equal(H.winFindOnPath('nope', { Path: dir, PATHEXT: '.com;.exe' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// claudeSettingsGitBashPath: Claude Code's own settings.json `env` block (review follow-up)
// ---------------------------------------------------------------------------
test('claudeSettingsGitBashPath: reads CLAUDE_CODE_GIT_BASH_PATH from the env block, as written', () => {
  const p = 'D:\\开发 tools\\Git\\bin\\bash.exe';
  assert.equal(H.claudeSettingsGitBashPath(JSON.stringify({ model: 'x', env: { A: '1', CLAUDE_CODE_GIT_BASH_PATH: p } })), p);
  assert.equal(H.claudeSettingsGitBashPath(JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: p } }, null, 2)), p, 'pretty-printed file');
  assert.equal(H.claudeSettingsGitBashPath(Buffer.from(JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: p } }))), p, 'a Buffer is accepted too');
});
test('claudeSettingsGitBashPath: invalid JSON, empty, non-JSON values, missing or malformed env all give an empty string', () => {
  for (const bad of ['{not json', '', undefined, null, 42, '[]', 'null', '"str"', '{}', '{"env":null}', '{"env":"x"}', '{"env":[]}', '{"env":{}}',
    '{"env":{"CLAUDE_CODE_GIT_BASH_PATH":""}}', '{"env":{"CLAUDE_CODE_GIT_BASH_PATH":"   "}}', '{"env":{"CLAUDE_CODE_GIT_BASH_PATH":5}}', '{"env":{"CLAUDE_CODE_GIT_BASH_PATH":null}}',
    '{"env":{"claude_code_git_bash_path":"C:\\\\x\\\\bash.exe"}}']) {
    assert.equal(H.claudeSettingsGitBashPath(bad), '', 'input: ' + String(bad));
  }
});
test('claudeSettingsGitBashPath: pure (no fs, no process.env access)', () => {
  const src = H.claudeSettingsGitBashPath.toString();
  assert.ok(!/\bfs\b|process\.env|writeFile/.test(src));
});

// ---------------------------------------------------------------------------
// writeHookFiles (Windows branch of electron/main.js, run with fakes)
// ---------------------------------------------------------------------------
const mainSrc = fs.readFileSync(MAIN_FILE, 'utf8');
const hookSlice = mainSrc.slice(mainSrc.indexOf('const HOOKS_DIR = () =>'), mainSrc.indexOf('// 只读 ~/.codex/config.toml'));
assert.ok(hookSlice.includes('function writeHookFiles()') && hookSlice.length < 12000, 'writeHookFiles slice found');
const makeWriteHookFiles = new Function('path', 'os', 'fs', 'winHelpers', 'IS_WIN', 'PORT', 'process', 'console', '__dirname', 'codexUserNotify', hookSlice + '\nreturn writeHookFiles;');

function runWriteHookFiles({ home = 'C:\\Users\\u', execPath = 'C:\\Users\\u\\AppData\\Local\\Programs\\FanBox\\FanBox.exe', winTree = [BASH], env = { Path: 'C:\\Windows', ProgramFiles: PF }, readFails = false, settingsText, settingsDir } = {}) {
  const written = {}; const logs = []; const dirs = []; const settingsReads = [];
  const asarBridge = w.join('C:\\app\\resources\\app.asar\\electron', '..', 'lib', 'claude-statusline.cjs');
  // Claude Code's own settings file: ${CLAUDE_CONFIG_DIR || ~/.claude}/settings.json. settingsText undefined = the file does not exist.
  const settingsFile = w.join(settingsDir || env.CLAUDE_CONFIG_DIR || w.join(home, '.claude'), 'settings.json');
  const fakeFs = {
    mkdirSync: (d) => { dirs.push(d); },
    writeFileSync: (f, data) => { written[f] = data; },
    readFileSync: (f) => {
      if (/settings\.json$/i.test(String(f))) { settingsReads.push(f); if (f === settingsFile && settingsText !== undefined) return settingsText; throw Object.assign(new Error('ENOENT ' + f), { code: 'ENOENT' }); }
      if (readFails) throw new Error('ENOENT asar'); assert.equal(f, asarBridge, 'the bridge is read from the app (asar) lib dir'); return fs.readFileSync(BRIDGE_FILE);
    },
    copyFileSync: () => { throw new Error('copyFileSync must not be used (does not work from app.asar)'); },
    chmodSync: () => {},
  };
  const winHelpers = Object.assign({}, H, { winGitBash: (e) => H.winGitBash(e, tree(winTree)) });
  const proc = { platform: 'win32', execPath, env: Object.assign({}, env, { FANBOX_CTL_TOKEN: TOKEN, PORTABLE_EXECUTABLE_FILE: 'D:\\download\\FanBox-portable.exe' }) };
  const fakeOs = { homedir: () => home };
  const fakeConsole = { error: (...a) => logs.push(a.join(' ')) };
  const write = makeWriteHookFiles(w, fakeOs, fakeFs, winHelpers, true, 4567, proc, fakeConsole, 'C:\\app\\resources\\app.asar\\electron', () => []);
  write();
  const hooksDir = w.join(home, '.fanbox', 'hooks');
  return { written, logs, dirs, hooksDir, settingsReads, settingsFile, procEnv: proc.env, settings: written[w.join(hooksDir, 'claude-settings.json')] && JSON.parse(written[w.join(hooksDir, 'claude-settings.json')]) };
}

test('writeHookFiles (win32) with Git Bash: copies the bridge and writes a Git Bash safe statusLine', () => {
  const r = runWriteHookFiles({});
  const script = w.join(r.hooksDir, 'claude-statusline.cjs');
  assert.equal(r.written[script].toString(), BRIDGE_SRC, 'bridge copied byte-for-byte (read+write, asar-safe)');
  assert.equal(r.settings.statusLine.type, 'command');
  assert.equal(r.settings.statusLine.command,
    "ELECTRON_RUN_AS_NODE=1 'C:/Users/u/AppData/Local/Programs/FanBox/FanBox.exe' 'C:/Users/u/.fanbox/hooks/claude-statusline.cjs'");
  assert.ok(r.settings.hooks.Stop, 'HTTP hooks still written');
  assert.ok(w.join(r.hooksDir, 'codex-notify.js') in r.written, 'codex-notify.js still written');
  assert.deepEqual(r.logs, []);
});

test('writeHookFiles (win32): uses process.execPath, never PORTABLE_EXECUTABLE_FILE', () => {
  const r = runWriteHookFiles({ execPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\2abc\\FanBox.exe' });
  assert.ok(r.settings.statusLine.command.includes("'C:/Users/u/AppData/Local/Temp/2abc/FanBox.exe'"));
  assert.ok(!JSON.stringify(r.settings).includes('FanBox-portable.exe'));
});

test('writeHookFiles (win32) without Git Bash: no statusLine, no bridge copy, 2.16.1 shape', () => {
  const r = runWriteHookFiles({ winTree: [] });
  assert.deepEqual(Object.keys(r.settings), ['hooks']);
  assert.ok(!(w.join(r.hooksDir, 'claude-statusline.cjs') in r.written));
  assert.ok(w.join(r.hooksDir, 'codex-notify.js') in r.written);
  assert.deepEqual(r.settings, H.claudeHttpHookSettings(4567));
});

test('writeHookFiles (win32): home with an apostrophe gets no statusLine and no copy, hook file still written', () => {
  const r = runWriteHookFiles({ home: "C:\\Users\\O'Brien" });
  assert.deepEqual(Object.keys(r.settings), ['hooks']);
  assert.ok(!Object.keys(r.written).some((f) => f.endsWith('claude-statusline.cjs')));
});

test('writeHookFiles (win32): space + CJK home gets a quoted, forward-slash command', () => {
  const r = runWriteHookFiles({ home: 'E:\\fanbox test\\用户' });
  assert.ok(r.settings.statusLine.command.endsWith("'E:/fanbox test/用户/.fanbox/hooks/claude-statusline.cjs'"));
});

test('writeHookFiles (win32): a failed bridge copy degrades to the 2.16.1 file and does not throw', () => {
  const r = runWriteHookFiles({ readFails: true });
  assert.deepEqual(Object.keys(r.settings), ['hooks']);
  assert.ok(w.join(r.hooksDir, 'codex-notify.js') in r.written);
  assert.ok(r.logs.some((l) => /status-line bridge skipped/.test(l)));
});

test('writeHookFiles (win32): no generated file contains the token, only $FANBOX_CTL_TOKEN references', () => {
  for (const opts of [{}, { winTree: [] }]) {
    const r = runWriteHookFiles(opts);
    for (const [f, data] of Object.entries(r.written)) {
      assert.ok(!String(data).includes(TOKEN), f + ' leaks the token');
    }
    assert.ok(JSON.stringify(r.settings).includes('$FANBOX_CTL_TOKEN'));
  }
});

// review follow-up: Claude Code also honors CLAUDE_CODE_GIT_BASH_PATH from the env block of its own settings.json
const GB_CUSTOM = 'D:\\开发 tools\\Git\\bin\\bash.exe';
const GB_SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: GB_CUSTOM } }, null, 2);
const GB_CMD = "ELECTRON_RUN_AS_NODE=1 'C:/Users/u/AppData/Local/Programs/FanBox/FanBox.exe' 'C:/Users/u/.fanbox/hooks/claude-statusline.cjs'";

test('writeHookFiles (win32): Git Bash set only in ~/.claude/settings.json env still yields the statusLine and the bridge copy', () => {
  const r = runWriteHookFiles({ winTree: [GB_CUSTOM], settingsText: GB_SETTINGS });
  assert.deepEqual(r.settingsReads, [w.join('C:\\Users\\u', '.claude', 'settings.json')]);
  assert.equal(r.settings.statusLine.command, GB_CMD);
  assert.equal(r.written[w.join(r.hooksDir, 'claude-statusline.cjs')].toString(), BRIDGE_SRC);
  assert.deepEqual(r.logs, []);
});

test('writeHookFiles (win32): the same machine without that settings entry has no statusLine (so the entry is what matters)', () => {
  for (const settingsText of [undefined, '{}', '{"env":{}}', '{not json', '{"env":{"CLAUDE_CODE_GIT_BASH_PATH":""}}']) {
    const r = runWriteHookFiles({ winTree: [GB_CUSTOM], settingsText });
    assert.deepEqual(Object.keys(r.settings), ['hooks'], 'settingsText: ' + settingsText);
    assert.ok(!Object.keys(r.written).some((f) => f.endsWith('claude-statusline.cjs')));
    assert.ok(w.join(r.hooksDir, 'codex-notify.js') in r.written, 'hook files still written');
    assert.deepEqual(r.logs, [], 'a missing or broken settings file is silent, not an error');
  }
});

test('writeHookFiles (win32): a settings path that does not exist falls through to PATH / ProgramFiles like any stale override', () => {
  const r = runWriteHookFiles({ winTree: [BASH], settingsText: JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe' } }) });
  assert.equal(r.settings.statusLine.command, GB_CMD, 'ProgramFiles Git still found');
});

test('writeHookFiles (win32): CLAUDE_CONFIG_DIR moves the settings file; the default ~/.claude one is then not read', () => {
  const dir = 'D:\\cc 配置';
  const r = runWriteHookFiles({ winTree: [GB_CUSTOM], settingsText: GB_SETTINGS, env: { Path: 'C:\\Windows', CLAUDE_CONFIG_DIR: dir } });
  assert.deepEqual(r.settingsReads, [w.join(dir, 'settings.json')]);
  assert.equal(r.settings.statusLine.command, GB_CMD);
});

test('writeHookFiles (win32): CLAUDE_CODE_GIT_BASH_PATH in the process env wins and the settings file is not even read', () => {
  const real = 'E:\\mine\\bash.exe';
  const r = runWriteHookFiles({ winTree: [real], env: { Path: 'C:\\Windows', CLAUDE_CODE_GIT_BASH_PATH: real }, settingsText: GB_SETTINGS });
  assert.deepEqual(r.settingsReads, []);
  assert.equal(r.settings.statusLine.command, GB_CMD);
});

test('writeHookFiles (win32): the value goes into a copy of the env, process.env is untouched, and the user settings file is never written', () => {
  let seen;
  const winHelpers = Object.assign({}, H, { winGitBash: (e, io) => { seen = e; return H.winGitBash(e, tree([GB_CUSTOM])); } });
  const written = {};
  const proc = { platform: 'win32', execPath: 'C:\\FanBox.exe', env: { Path: 'C:\\Windows' } };
  const fakeFs = { mkdirSync() {}, writeFileSync: (f, d) => { written[f] = d; }, readFileSync: (f) => (/settings\.json$/.test(f) ? GB_SETTINGS : fs.readFileSync(BRIDGE_FILE)) };
  makeWriteHookFiles(w, { homedir: () => 'C:\\Users\\u' }, fakeFs, winHelpers, true, 4567, proc, console, 'C:\\a', () => [])();
  assert.notEqual(seen, proc.env, 'winGitBash got a copy');
  assert.equal(seen.CLAUDE_CODE_GIT_BASH_PATH, GB_CUSTOM);
  assert.equal(seen.Path, 'C:\\Windows', 'the rest of the env is carried over');
  assert.equal(proc.env.CLAUDE_CODE_GIT_BASH_PATH, undefined, 'process.env itself is not modified');
  assert.deepEqual(Object.keys(written).filter((f) => !f.startsWith(w.join('C:\\Users\\u', '.fanbox', 'hooks'))), [], 'only ~/.fanbox/hooks is written');
  assert.ok(!Object.keys(written).some((f) => /settings\.json$/.test(f) && !f.endsWith('claude-settings.json')), 'the user settings file is never written');
});

test('writeHookFiles: Git Bash is looked up in process.env (the env the PTYs inherit after the registry PATH merge)', () => {
  let seen;
  const winHelpers = Object.assign({}, H, { winGitBash: (e) => { seen = e; return null; } });
  const proc = { platform: 'win32', execPath: 'C:\\FanBox.exe', env: { Path: 'MERGED' } };
  const write = makeWriteHookFiles(w, { homedir: () => 'C:\\Users\\u' }, { mkdirSync() {}, writeFileSync() {}, readFileSync() {} }, winHelpers, true, 4567, proc, console, 'C:\\a', () => []);
  write();
  assert.equal(seen, proc.env);
  // ordering: writeHookFiles() runs after `await mergeWinUserPath(process.env)` in app.whenReady
  const ready = mainSrc.slice(mainSrc.indexOf('app.whenReady().then('));
  assert.ok(ready.indexOf('await mergeWinUserPath(process.env)') >= 0 && ready.indexOf('await mergeWinUserPath(process.env)') < ready.indexOf('writeHookFiles();'));
});

// ---------------------------------------------------------------------------
// The bridge (lib/claude-statusline.cjs) with a fake process
// ---------------------------------------------------------------------------
const WIN_HOME = 'C:\\Users\\u';
const SAMPLE = { cwd: 'C:\\proj', prompt: 'must-not-forward', rate_limits: { five_hour: { used_percentage: 23.2, resets_at: 2000000000 }, seven_day: { used_percentage: 41.4, resets_at: 2000000000 } } };

function runBridge({ platform = 'win32', env = {}, files = {}, exists = [], input = SAMPLE, locale = 'en-US', spawnResult = { stdout: 'stub-out' }, home = WIN_HOME } = {}) {
  const pathMod = platform === 'win32' ? path.win32 : path.posix;
  const out = []; const posts = []; const spawns = []; const handlers = {};
  const present = new Set(exists.map((p) => p.toLowerCase()));
  const fakeFs = {
    existsSync: (p) => (p in files) || present.has(String(p).toLowerCase()),
    readFileSync: (p) => { if (p in files) return files[p]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  };
  const fakeHttp = { request: (url, options, cb) => { const rec = { url: String(url), options, body: '' }; posts.push(rec); return { on() {}, setTimeout() {}, destroy() {}, end(b) { rec.body = b; } }; } };
  const fakeCp = { spawnSync: (...a) => { spawns.push(a); return spawnResult; } };
  const mods = { fs: fakeFs, path: pathMod, os: { homedir: () => home }, http: fakeHttp, child_process: fakeCp };
  const module_ = { exports: {} };
  const req = (n) => { if (!(n in mods)) throw new Error('unexpected require ' + n); return mods[n]; };
  req.main = module_; // so `require.main === module` and the stdin driver runs
  const proc = {
    platform, env, cwd: () => (platform === 'win32' ? 'C:\\proj' : '/proj'),
    stdin: { setEncoding() {}, on(ev, cb) { handlers[ev] = cb; } },
    stdout: { write: (s) => out.push(s) },
  };
  const fakeIntl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ locale }) }) };
  const fn = new Function('require', 'module', 'exports', 'process', 'Intl', 'URL', BRIDGE_SRC);
  fn(req, module_, module_.exports, proc, fakeIntl, URL);
  handlers.data(typeof input === 'string' ? input : JSON.stringify(input));
  handlers.end();
  return { out: out.join(''), posts, spawns };
}

const CFG = (lang) => ({ [w.join(WIN_HOME, '.fanbox', 'config.json')]: JSON.stringify(lang === undefined ? {} : { lang }) });
const SETTINGS = (statusLine) => ({ [w.join(WIN_HOME, '.claude', 'settings.json')]: JSON.stringify({ statusLine }) });
const WIN_ENV = { Path: 'C:\\Windows', ProgramFiles: PF };

test('bridge win32 + Git Bash: the user statusLine runs as spawnSync(bash, ["-c", cmd]) with windowsHide', () => {
  const cmd = '~/.claude/statusline.sh';
  const r = runBridge({ env: { ...WIN_ENV, ELECTRON_RUN_AS_NODE: '1', FANBOX_CTL: 'http://127.0.0.1:4567/api/agent', FANBOX_CTL_TOKEN: 'tok' }, files: SETTINGS({ type: 'command', command: cmd }), exists: [BASH] });
  assert.equal(r.spawns.length, 1);
  const [file, args, opts] = r.spawns[0];
  assert.equal(file, BASH);
  assert.deepEqual(args, ['-c', cmd]);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.shell, undefined, 'not the cmd.exe shell:true path');
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined, 'ELECTRON_RUN_AS_NODE is not passed to the user script');
  assert.equal(opts.env.FANBOX_CTL_TOKEN, 'tok', 'the rest of the environment is passed through');
  assert.equal(opts.encoding, 'utf8'); assert.equal(opts.timeout, 3000); assert.equal(opts.maxBuffer, 1024 * 1024);
  assert.equal(opts.cwd, 'C:\\proj');
  assert.equal(opts.input, JSON.stringify(SAMPLE), 'the raw status JSON goes to the user script');
  assert.equal(r.out, 'stub-out', 'the user script output replaces the quota text');
});

test('bridge win32: CLAUDE_CODE_GIT_BASH_PATH and git.exe-on-PATH both locate bash', () => {
  const custom = 'D:\\gb\\bin\\bash.exe';
  let r = runBridge({ env: { ...WIN_ENV, CLAUDE_CODE_GIT_BASH_PATH: custom }, files: SETTINGS({ type: 'command', command: 'x' }), exists: [custom, BASH] });
  assert.equal(r.spawns[0][0], custom);
  for (const gitDir of [PF + '\\Git\\cmd', PF + '\\Git\\bin', PF + '\\Git\\mingw64\\bin']) {
    r = runBridge({ env: { Path: 'C:\\Windows;' + gitDir }, files: SETTINGS({ type: 'command', command: 'x' }), exists: [gitDir + '\\git.exe', BASH] });
    assert.equal(r.spawns[0][0], BASH, gitDir);
  }
  r = runBridge({ env: { Path: 'C:\\Windows', ProgramW6432: PF }, files: SETTINGS({ type: 'command', command: 'x' }), exists: [BASH] });
  assert.equal(r.spawns[0][0], BASH);
});

test('bridge win32 without Git Bash: falls back to upstream\'s shell:true line', () => {
  const cmd = 'printf original-status';
  const r = runBridge({ env: WIN_ENV, files: SETTINGS({ type: 'command', command: cmd }), exists: [] });
  assert.equal(r.spawns.length, 1);
  const [file, opts] = r.spawns[0];
  assert.equal(file, cmd);
  assert.equal(opts.shell, true);
  assert.equal(opts.windowsHide, undefined, 'upstream line is untouched');
  assert.equal(r.out, 'stub-out');
});

test('bridge win32: the loop guard still skips a command that points at claude-statusline.cjs', () => {
  const r = runBridge({ env: WIN_ENV, files: SETTINGS({ type: 'command', command: "ELECTRON_RUN_AS_NODE=1 'C:/h/claude-statusline.cjs'" }), exists: [BASH], locale: 'zh-CN' });
  assert.equal(r.spawns.length, 0);
  assert.equal(r.out, '5h 23% · 周 41%\n');
});

test('bridge win32: statusLine null (user disabled it) prints nothing and spawns nothing', () => {
  const r = runBridge({ env: WIN_ENV, files: SETTINGS(null), exists: [BASH] });
  assert.equal(r.spawns.length, 0); assert.equal(r.out, '');
});

test('bridge win32: only the two limit numbers leave the process', () => {
  const r = runBridge({ env: { ...WIN_ENV, FANBOX_CTL: 'http://127.0.0.1:4567/api/agent', FANBOX_CTL_TOKEN: 'tok' }, files: {} });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, 'http://127.0.0.1:4567/api/agent/usage');
  assert.equal(r.posts[0].options.headers['x-fanbox-token'], 'tok');
  assert.deepEqual(JSON.parse(r.posts[0].body), { fiveHour: { usedPercent: 23.2, resetsAt: 2000000000 }, sevenDay: { usedPercent: 41.4, resetsAt: 2000000000 } });
  assert.ok(!r.posts[0].body.includes('must-not-forward') && !r.posts[0].body.includes('proj'));
  // not inside FanBox (no loopback FANBOX_CTL): nothing is sent
  assert.equal(runBridge({ env: WIN_ENV, files: {} }).posts.length, 0);
});

// D2: label follows FanBox's language on Windows
test('D2 label: config lang zh -> 周', () => {
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('zh'), locale: 'en-US' }).out, '5h 23% · 周 41%\n');
});
test('D2 label: config lang en -> 7d (even on a zh system locale)', () => {
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('en'), locale: 'zh-CN' }).out, '5h 23% · 7d 41%\n');
});
test('D2 label: no config + zh locale -> 周', () => {
  assert.equal(runBridge({ env: WIN_ENV, files: {}, locale: 'zh-CN' }).out, '5h 23% · 周 41%\n');
  assert.equal(runBridge({ env: WIN_ENV, files: CFG(undefined), locale: 'zh-Hans-CN' }).out, '5h 23% · 周 41%\n', 'config without lang behaves like missing');
});
test('D2 label: no config + en locale -> 7d', () => {
  assert.equal(runBridge({ env: WIN_ENV, files: {}, locale: 'en-US' }).out, '5h 23% · 7d 41%\n');
  assert.equal(runBridge({ env: WIN_ENV, files: {}, locale: 'de-DE' }).out, '5h 23% · 7d 41%\n');
});
test('D2 label: an invalid config lang or unreadable config falls back to the locale', () => {
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('fr'), locale: 'zh-CN' }).out, '5h 23% · 周 41%\n');
  assert.equal(runBridge({ env: WIN_ENV, files: { [w.join(WIN_HOME, '.fanbox', 'config.json')]: '{not json' }, locale: 'en-GB' }).out, '5h 23% · 7d 41%\n');
});
test('D2 label: the 5h part and a missing weekly window are untouched', () => {
  const only5h = { cwd: 'C:\\proj', rate_limits: { five_hour: { used_percentage: 7, resets_at: 2000000000 } } };
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('en'), input: only5h }).out, '5h 7%\n');
  const only7d = { cwd: 'C:\\proj', rate_limits: { seven_day: { used_percentage: 9, resets_at: 2000000000 } } };
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('en'), input: only7d }).out, '7d 9%\n');
  assert.equal(runBridge({ env: WIN_ENV, files: CFG('zh'), input: only7d }).out, '周 9%\n');
});

// review follow-up: config.lang is only written when the user clicks the toggle. For everyone else the UI follows Chromium's
// locale, which main.js hands to the PTY env as FANBOX_LANG (the bridge's own Intl locale is the Windows regional format).
test('D2 label: FANBOX_LANG decides when there is no config.lang (even against the process locale)', () => {
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'en' }, files: {}, locale: 'zh-CN' }).out, '5h 23% · 7d 41%\n', 'UI is English, regional format is Chinese');
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'zh' }, files: {}, locale: 'en-US' }).out, '5h 23% · 周 41%\n', 'UI is Chinese, regional format is English');
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'en' }, files: CFG(undefined), locale: 'zh-CN' }).out, '5h 23% · 7d 41%\n', 'config without lang behaves like missing');
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'en' }, files: { [w.join(WIN_HOME, '.fanbox', 'config.json')]: '{not json' }, locale: 'zh-CN' }).out, '5h 23% · 7d 41%\n', 'unreadable config behaves like missing');
});
test('D2 label: config.lang beats FANBOX_LANG (an explicit, later choice is read live)', () => {
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'en' }, files: CFG('zh'), locale: 'en-US' }).out, '5h 23% · 周 41%\n');
  assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: 'zh' }, files: CFG('en'), locale: 'zh-CN' }).out, '5h 23% · 7d 41%\n');
});
test('D2 label: an invalid FANBOX_LANG is ignored and the locale decides', () => {
  for (const bad of ['fr', 'EN', 'zh-CN', '', ' en']) {
    assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: bad }, files: {}, locale: 'zh-CN' }).out, '5h 23% · 周 41%\n', JSON.stringify(bad));
    assert.equal(runBridge({ env: { ...WIN_ENV, FANBOX_LANG: bad }, files: {}, locale: 'en-US' }).out, '5h 23% · 7d 41%\n', JSON.stringify(bad));
  }
});
test('D2 label: resolution order in the source is config.lang, then FANBOX_LANG, then Intl', () => {
  const body = BRIDGE_SRC.slice(BRIDGE_SRC.indexOf('function winLang()'), BRIDGE_SRC.indexOf('function run(input)'));
  const at = (needle) => { const i = body.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('.fanbox') < at('process.env.FANBOX_LANG') && at('process.env.FANBOX_LANG') < at('Intl.DateTimeFormat'));
});

// POSIX behavior is exactly upstream's
for (const platform of ['linux', 'darwin']) {
  test(`bridge ${platform}: unchanged. Label stays 周 (config and locale ignored), chaining uses shell:true`, () => {
    const home = '/home/u';
    const cfgEn = { [path.join(home, '.fanbox', 'config.json')]: JSON.stringify({ lang: 'en' }) };
    const base = { platform, home, env: { Path: '/usr/bin', PATH: '/usr/bin', FANBOX_LANG: 'en' }, locale: 'en-US', input: { ...SAMPLE, cwd: '/proj' } }; // FANBOX_LANG is a Windows-only variable and must change nothing here
    let r = runBridge({ ...base, files: cfgEn });
    assert.equal(r.out, '5h 23% · 周 41%\n');
    assert.equal(r.spawns.length, 0);
    const cmd = 'printf original-status';
    r = runBridge({ ...base, files: { ...cfgEn, [path.join(home, '.claude', 'settings.json')]: JSON.stringify({ statusLine: { type: 'command', command: cmd } }) }, exists: ['C:\\Program Files\\Git\\bin\\bash.exe', '/usr/bin/bash'] });
    assert.equal(r.spawns.length, 1);
    const [file, opts] = r.spawns[0];
    assert.equal(file, cmd);
    assert.equal(opts.shell, true);
    assert.equal(opts.windowsHide, undefined);
    assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(r.out, 'stub-out');
  });
}

// ---------------------------------------------------------------------------
// Source contracts for the two Windows-only lines in shared files (Electron and the server cannot run on Linux)
// ---------------------------------------------------------------------------
// the text between `{` at `openIdx` and its matching `}` (no braces occur in strings/comments of the blocks sliced here)
function braceBlock(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(openIdx, i + 1);
  }
  throw new Error('unbalanced braces');
}

test('pty:spawn: FANBOX_LANG is added to the PTY env under the IS_WIN guard only, never in the shared env object', () => {
  assert.equal(mainSrc.split('FANBOX_LANG').length - 1, 1, 'exactly one mention in electron/main.js');
  const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('pty:spawn'"));
  const envObj = handler.slice(handler.indexOf('const env = {'), handler.indexOf('\n  };') + 5);
  assert.ok(envObj.includes('FANBOX_CTL_TOKEN: AGENT_TOKEN') && envObj.includes('FANBOX_TERM_ID: id'), 'sliced the shared env object');
  assert.ok(!envObj.includes('FANBOX_LANG'), 'the shared env object does not carry it');
  // the single assignment sits inside the `if (IS_WIN) {` block that follows it
  const open = handler.indexOf('\n  if (IS_WIN) {', handler.indexOf(envObj) + envObj.length) + 1;
  assert.ok(open > 0, 'found the IS_WIN block after the env object');
  const block = braceBlock(handler, handler.indexOf('{', open));
  assert.ok(block.includes('env.FANBOX_LANG = uiLang();'), 'FANBOX_LANG = uiLang() is inside the IS_WIN block');
  assert.ok(handler.indexOf('FANBOX_LANG') > open && handler.indexOf('FANBOX_LANG') < open + block.length);
  // uiLang() is the same resolution the UI uses (config.lang, else Chromium's locale)
  const ui = mainSrc.slice(mainSrc.indexOf('function uiLang()'), mainSrc.indexOf('const M = (zh, en)'));
  assert.ok(ui.includes('c.lang') && ui.includes('app.getLocale()'));
});

test('usageRequest: the curl on Windows is the exact name curl.exe (PATH first, System32 second), bare curl elsewhere', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fn = srv.slice(srv.indexOf('async function usageRequest('), srv.indexOf('const officialCache = new Map()'));
  assert.ok(fn.includes("const curlExe = PLATFORM === 'win32' ? (winFindExe('curl.exe') || path.join(WIN_SYS32, 'curl.exe')) : 'curl';"));
  assert.ok(!fn.includes("winFindExe('curl')"), 'no PATHEXT lookup (it would pick curl.cmd / curl.bat, which execFile cannot run without a shell)');
  assert.ok(fn.includes('execFile(curlExe, ['), 'the request goes through the selected binary');
  assert.equal(srv.split("winFindExe('curl").length - 1, 1, 'no other curl lookup in server.js');
});

test('winFindExe: a name with an extension is an exact lookup (no PATHEXT expansion, curl.cmd never stands in for curl.exe)', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const src = srv.slice(srv.indexOf('function winFindExe(name, extraDirs) {'), srv.indexOf('// VS Code 真身'));
  assert.ok(src.length > 100 && src.length < 3000, 'sliced winFindExe');
  const make = (files, Path, PATHEXT) => new Function('path', 'fs', 'process', src + '\nreturn winFindExe;')(
    w, { existsSync: (f) => files.map((x) => x.toLowerCase()).includes(String(f).toLowerCase()) }, { env: { Path, PATHEXT } });
  const find = make(['C:\\shim\\curl.cmd', 'C:\\shim\\curl.bat', 'C:\\Windows\\System32\\curl.exe'], 'C:\\shim;C:\\Windows\\System32', '.COM;.EXE;.BAT;.CMD');
  assert.equal(find('curl.exe'), 'C:\\Windows\\System32\\curl.exe', 'the earlier curl.cmd / curl.bat are skipped');
  assert.equal(find('curl').toLowerCase(), 'c:\\shim\\curl.bat', 'whereas the bare name does expand PATHEXT (the bug this avoids)');
  assert.equal(make(['C:\\shim\\curl.cmd'], 'C:\\shim', '.COM;.EXE;.BAT;.CMD')('curl.exe'), null, 'only a .cmd on PATH: null, so the System32 fallback applies');
  assert.equal(make(['C:\\tools\\curl.exe', 'C:\\Windows\\System32\\curl.exe'], '"C:\\tools";C:\\Windows\\System32', '.EXE')('curl.exe'), 'C:\\tools\\curl.exe', 'PATH first (quoted entry handled)');
});

test('bridge file: the Windows branches are the only difference from master (only added lines)', () => {
  const r = spawnSync('git', ['diff', '--numstat', 'master', '--', 'lib/claude-statusline.cjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) return; // no git / no master ref: nothing to compare
  const [added, removed] = r.stdout.trim().split(/\s+/);
  assert.equal(removed, '0', 'upstream lines must stay byte-identical (insert-only)');
  assert.ok(Number(added) > 0);
});

// ---------------------------------------------------------------------------
// End to end on Linux: the command the helper produces, run through bash, with a real bridge
// ---------------------------------------------------------------------------
test('e2e: bash -c <winStatusLineCommand> prints the quota text and POSTs only the two limits', { skip: !fs.existsSync('/usr/bin/bash') && !fs.existsSync('/bin/bash') }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-e2e-'));
  const dir = path.join(base, 'fanbox test', '用户 $x');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'node'); fs.symlinkSync(process.execPath, exe);
  const script = path.join(dir, 'claude-statusline.cjs'); fs.writeFileSync(script, fs.readFileSync(BRIDGE_FILE));
  const claudeDir = path.join(base, 'claude-config'); fs.mkdirSync(claudeDir);
  const cmd = H.winStatusLineCommand(exe, script);
  assert.ok(cmd);
  let received, token;
  const server = http.createServer((req, res) => { let t = ''; req.on('data', (x) => { t += x; }); req.on('end', () => { received = JSON.parse(t); token = req.headers['x-fanbox-token']; res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const child = spawn('bash', ['-c', cmd], { cwd: base, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, FANBOX_CTL: `http://127.0.0.1:${server.address().port}/api/agent`, FANBOX_CTL_TOKEN: 'e2e-token' } });
    let output = ''; child.stdout.on('data', (s) => { output += s; });
    child.stdin.end(JSON.stringify({ cwd: base, prompt: 'must-not-forward', rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 2000000000 }, seven_day: { used_percentage: 41.6, resets_at: 2000000000 } } }));
    await new Promise((resolve, reject) => { child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('exit ' + code)))); child.once('error', reject); });
    assert.equal(output, '5h 23% · 周 42%\n');
    assert.deepEqual(received, { fiveHour: { usedPercent: 23.4, resetsAt: 2000000000 }, sevenDay: { usedPercent: 41.6, resetsAt: 2000000000 } });
    assert.equal(token, 'e2e-token');
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(base, { recursive: true, force: true }); }
});

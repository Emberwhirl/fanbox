'use strict';
/**
 * Explorer/portable Windows Codex discovery contracts.
 *
 * node --test experiments/win-v2170-usage-202610/contract-codex-discovery.test.js
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require(path.resolve(__dirname, '../..', 'win-port-helpers.js'));

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-codex-discovery-'));
  roots.push(root);
  return root;
}
function file(name, text) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, text == null ? 'exe' : text);
  return name;
}
function guiEnv(root, extra) {
  return Object.assign({
    // lower-case PATHEXT: fixtures are lower-case and the Linux gate fs is case-sensitive
    // (same choice as contract-bridge.test.js's real-filesystem winFindOnPath test)
    Path: '', PATH: '', PATHEXT: '.com;.exe;.bat;.cmd',
    LOCALAPPDATA: path.join(root, 'Local'),
    APPDATA: path.join(root, 'Roaming'),
    USERPROFILE: path.join(root, 'Profile'),
  }, extra || {});
}
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

test('GUI-like PATH finds the newest complete Codex Desktop cache entry and skips stale entries', () => {
  const root = fixture();
  const env = guiEnv(root);
  const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  fs.mkdirSync(path.join(bin, 'incomplete-cache', 'codex.exe'), { recursive: true }); // a directory is never spawnable
  const old = file(path.join(bin, 'old-cache', 'codex.exe'));
  const newest = file(path.join(bin, 'current-cache', 'codex.exe'));
  fs.utimesSync(old, new Date(1000), new Date(1000));
  fs.utimesSync(newest, new Date(2000), new Date(2000));

  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.deepEqual(cli, { file: newest, preArgs: [] });
  const specOn = H.buildCodexSpawnSpec({ env, execPath: process.execPath, extraArgs: ['--full-auto', 'keep & quote'], preferMxcProbe: () => true });
  assert.equal(specOn.file, newest);
  assert.deepEqual(specOn.args, ['--enable', 'prefer_mxc', '--full-auto', 'keep & quote'], 'probe reports --enable: the MXC pair is kept and real argv slots are preserved');
  const specOff = H.buildCodexSpawnSpec({ env, execPath: process.execPath, extraArgs: ['--full-auto', 'keep & quote'], preferMxcProbe: () => false });
  assert.deepEqual(specOff.args, ['--full-auto', 'keep & quote'], 'probe reports no --enable: the pair is dropped (old CLIs exit on unknown args)');
});

test('PATH native executable takes precedence over desktop and npm fallbacks', () => {
  const root = fixture();
  const env = guiEnv(root);
  const onPath = file(path.join(root, 'preferred', 'codex.exe'));
  const desktop = file(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'cache', 'codex.exe'));
  const npm = file(path.join(env.APPDATA, 'npm', 'codex.cmd'));
  env.Path = path.dirname(onPath);

  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.ok(H.winSameFile(cli.file, onPath), 'Windows PATH extension casing is immaterial');
  assert.deepEqual(cli.preArgs, []);
  assert.ok(fs.existsSync(desktop) && fs.existsSync(npm), 'fixture has lower-priority candidates');
});

test('npm global shim is used when the GUI PATH and Desktop cache are absent', () => {
  const root = fixture();
  const env = guiEnv(root);
  const npm = path.join(env.APPDATA, 'npm');
  const entry = file(path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '// entry');
  const shim = file(path.join(npm, 'codex.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.equal(cli.file, process.execPath);
  assert.deepEqual(cli.preArgs, [entry]);
  assert.deepEqual(cli.extraEnv, { ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(fs.existsSync(shim));
});

test('discovery honors the supplied profile homes and does not borrow process environment locations', () => {
  const selected = fixture();
  const ignored = fixture();
  const env = guiEnv(selected);
  const expected = file(path.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'));
  file(path.join(ignored, 'Local', 'OpenAI', 'Codex', 'bin', 'other', 'codex.exe'));
  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.equal(cli.file, expected);
});

test('prefer_mxc is probe-gated: kept on --enable CLIs, dropped otherwise and when the probe fails', () => {
  const root = fixture();
  const env = guiEnv(root);
  const exe = file(path.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'));
  const base = { env, execPath: process.execPath, extraArgs: ['x'] };
  assert.deepEqual(H.buildCodexSpawnSpec(Object.assign({}, base, { preferMxcProbe: () => true })).args, ['--enable', 'prefer_mxc', 'x']);
  assert.deepEqual(H.buildCodexSpawnSpec(Object.assign({}, base, { preferMxcProbe: () => false })).args, ['x']);
  // the fixture binary is not runnable: the real --help probe fails closed (no flag, no throw)
  assert.deepEqual(H.buildCodexSpawnSpec(base).args, ['x']);
  assert.ok(fs.existsSync(exe));
});

test('a non-spawnable PATH shim falls through to the Desktop cache instead of returning null', () => {
  const root = fixture();
  const env = guiEnv(root);
  const broken = path.join(root, 'path-broken');
  file(path.join(broken, 'codex.cmd'), 'node "%~dp0node_modules/@openai/codex/bin/codex.js" %*'); // its entry is not on disk
  env.Path = broken;
  const desktop = file(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin', 'cache', 'codex.exe'));
  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.equal(cli.file, desktop);
  assert.deepEqual(cli.preArgs, []);
});

test('a broken npm-global shim does not shadow the local-bin fallback', () => {
  const root = fixture();
  const env = guiEnv(root);
  file(path.join(env.APPDATA, 'npm', 'codex.cmd'), 'node "%~dp0node_modules/@openai/codex/bin/codex.js" %*'); // its entry is not on disk
  const local = file(path.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'));
  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.equal(cli.file, local);
  assert.deepEqual(cli.preArgs, []);
});

test('shim entry matches that escape the shim directory are rejected', () => {
  const root = fixture();
  const env = guiEnv(root);
  const npm = path.join(env.APPDATA, 'npm');
  const evil = file(path.resolve(npm, '..', 'outside', 'evil.js'), '// evil');
  file(path.join(npm, 'codex.cmd'), 'node "%~dp0node_modules/../../outside/evil.js" %*');
  const local = file(path.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'));
  const cli = H.resolveWinCli('codex', env, process.execPath);
  assert.equal(cli.file, local, 'the escaped entry is never used; discovery continues to the local-bin candidate');
  assert.deepEqual(cli.preArgs, []);
  assert.ok(fs.existsSync(evil));
});

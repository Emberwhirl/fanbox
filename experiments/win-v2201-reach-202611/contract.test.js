'use strict';
/**
 * v2.20.1 Windows port contracts (Linux-runnable: `node --test experiments/win-v2201-reach-202611/contract.test.js`).
 *   - win-port-helpers.js: claudeHttpHookSettings relay hooks, buildFanboxNotifyCmd / buildFanboxNotifySh, winShellSpec
 *   - electron/wechat/driver.js: claudeWinPerm is the argv twin of upstream claudeCmd's permission slots
 *   - lib/win-fanbox-notify.cjs: behaviour against a loopback stand-in for /api/agent/notify
 *   - source wiring in electron/main.js and driver.js (Windows-gated, upstream POSIX lines intact)
 * live-windows.js in this directory exercises the same pieces through real PowerShell / cmd / Git Bash on Windows.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const driver = require(path.join(ROOT, 'electron', 'wechat', 'driver.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const NOTIFY_JS = path.join(ROOT, 'lib', 'win-fanbox-notify.cjs');

// ---------------------------------------------------------------------------
// window relay hook (2.19.0)
// ---------------------------------------------------------------------------
test('relay: synchronous HTTP hook on UserPromptSubmit and PostToolUse only', () => {
  const s = H.claudeHttpHookSettings(4567);
  for (const ev of ['UserPromptSubmit', 'PostToolUse']) {
    const hs = s.hooks[ev][0].hooks;
    assert.equal(hs.length, 2, ev + ' has the event hook plus the relay hook');
    assert.equal(hs[0].url, 'http://127.0.0.1:4567/api/agent/event');
    assert.equal(hs[0].async, true, 'event hook stays async');
    const r = hs[1];
    assert.equal(r.type, 'http');
    assert.equal(r.url, 'http://127.0.0.1:4567/api/agent/relay');
    assert.equal(r.async, undefined, 'relay hook is synchronous: its response body is the hook output');
    assert.equal(r.timeout, 4);
    assert.deepEqual(r.headers, { 'x-fanbox-token': '$FANBOX_CTL_TOKEN', 'x-fanbox-term': '$FANBOX_TERM_ID' });
    assert.deepEqual(r.allowedEnvVars, ['FANBOX_CTL_TOKEN', 'FANBOX_TERM_ID']);
  }
  for (const ev of ['SessionStart', 'PreToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd']) {
    assert.equal(s.hooks[ev][0].hooks.length, 1, ev + ' has no relay hook');
  }
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash', 'same matcher as upstream');
  assert.notEqual(s.hooks.UserPromptSubmit[0].hooks[0], s.hooks.UserPromptSubmit[0].hooks[1]);
  assert.notEqual(s.hooks.UserPromptSubmit[0].hooks[1], s.hooks.PostToolUse[0].hooks[1], 'no shared hook objects');
});

test('relay: matches upstream hook placement (UserPromptSubmit + PostToolUse in the POSIX writer)', () => {
  const main = read('electron/main.js');
  assert.ok(main.includes('hooks.UserPromptSubmit[0].hooks.push(relayHook);'), 'upstream POSIX relay hook line intact');
  assert.ok(main.includes('hooks.PostToolUse[0].hooks.push(relayHook);'), 'upstream POSIX relay hook line intact');
});

// ---------------------------------------------------------------------------
// read-only WeChat runs (2.20.0)
// ---------------------------------------------------------------------------
test('claudeWinPerm: same permission tokens, same order as upstream claudeCmd', () => {
  for (const readOnly of [true, false]) {
    const posix = driver.claudeCmd('', '', { readOnly }).replace(/^claude -p --output-format stream-json --verbose /, '').trim().split(/\s+/);
    assert.deepEqual(driver.claudeWinPerm({ readOnly }), posix, 'readOnly=' + readOnly);
  }
  assert.deepEqual(driver.claudeWinPerm(), ['--dangerously-skip-permissions']);
  assert.ok(!driver.claudeWinPerm({ readOnly: true }).includes('--dangerously-skip-permissions'), 'read-only never skips permissions');
});

test('runClaude Windows branch uses claudeWinPerm(opts); POSIX branch uses upstream claudeCmd', () => {
  const src = read('electron/wechat/driver.js');
  assert.ok(src.includes("cmd = ['claude', '-p', '--output-format', 'stream-json', '--verbose', ...claudeWinPerm(opts)];"));
  assert.ok(src.includes('cmd = claudeCmd(sys, flag, opts);'));
  assert.ok(!/'--dangerously-skip-permissions'\];\s*\n\s*if \(persona\) cmd\.push/.test(src), 'no hard-coded skip-permissions on the Windows argv');
});

// ---------------------------------------------------------------------------
// fanbox-notify launchers (2.20.0)
// ---------------------------------------------------------------------------
test('fanbox-notify.cmd: ASCII, CRLF, no paths or user data, runs the .cjs beside it', () => {
  const c = H.buildFanboxNotifyCmd();
  assert.ok(/^[\x00-\x7f]*$/.test(c), 'pure ASCII (cmd reads batch files in the OEM code page)');
  assert.ok(!/[^\r]\n/.test(c) && c.includes('\r\n'), 'CRLF line endings');
  assert.ok(c.startsWith('@echo off\r\n'));
  assert.ok(c.includes('setlocal'));
  assert.ok(c.includes('if not defined FANBOX_EXE ('));
  assert.ok(c.includes('set ELECTRON_RUN_AS_NODE=1'));
  assert.ok(c.includes('"%FANBOX_EXE%" "%~dp0fanbox-notify.cjs" %*'));
  assert.ok(c.includes('exit /b %ERRORLEVEL%'));
  assert.ok(!/[A-Za-z]:\\/.test(c) && !c.includes('FANBOX_CTL_TOKEN'), 'no absolute path, no token reference');
});

test('fanbox-notify (sh): LF, Git Bash launcher of the same .cjs', () => {
  const s = H.buildFanboxNotifySh();
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.ok(!s.includes('\r'), 'LF only');
  assert.ok(s.includes('[ -n "$FANBOX_EXE" ] ||'));
  assert.ok(s.includes('ELECTRON_RUN_AS_NODE=1 exec "$FANBOX_EXE" "$0.cjs" "$@"'));
  assert.ok(!s.includes('FANBOX_CTL_TOKEN'), 'token stays out of the command line');
});

test('main.js: Windows hook writer emits the three bin files; pty:spawn adds the bin dir and FANBOX_EXE', () => {
  const main = read('electron/main.js');
  const win = main.slice(main.indexOf('    if (IS_WIN) {\n      // D2: HTTP hook'), main.indexOf('      return;\n    }\n    // async：hook'));
  assert.ok(win.length > 0, 'Windows block of writeHookFiles found');
  assert.ok(win.includes("path.join(binDir, 'fanbox-notify.cjs'), fs.readFileSync(path.join(__dirname, '..', 'lib', 'win-fanbox-notify.cjs'))"));
  assert.ok(win.includes("path.join(binDir, 'fanbox-notify.cmd'), winHelpers.buildFanboxNotifyCmd()"));
  assert.ok(win.includes("path.join(binDir, 'fanbox-notify'), winHelpers.buildFanboxNotifySh()"));
  assert.ok(main.includes("if (process.platform !== 'win32') env.PATH = (env.PATH || '/usr/bin:/bin') + ':' + BIN_DIR();"), 'upstream POSIX PATH line intact');
  const spawnWin = main.slice(main.indexOf('  if (IS_WIN) {\n    // ConPTY'), main.indexOf('  if (spawnExtraEnv && Object.keys(spawnExtraEnv).length)'));
  assert.ok(spawnWin.includes("Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path'"));
  assert.ok(spawnWin.includes("env[pathKey] = (env[pathKey] ? env[pathKey] + ';' : '') + BIN_DIR();"));
  assert.ok(spawnWin.includes('env.FANBOX_EXE = process.execPath;'));
});

// ---------------------------------------------------------------------------
// lib/win-fanbox-notify.cjs behaviour
// ---------------------------------------------------------------------------
function stand() {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const text = new URLSearchParams(b).get('text');
      got.push({ url: req.url, method: req.method, ct: req.headers['content-type'], tok: req.headers['x-fanbox-token'], term: req.headers['x-fanbox-term'], text });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(text === 'decline' ? { ok: false, delivered: 'reject', note: '没有内容' } : { ok: true, delivered: 'phone' }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, got, port: srv.address().port })));
}
function runNotify(args, env, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [NOTIFY_JS, ...args], { env });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(input == null ? '' : input);
  });
}

test('win-fanbox-notify.cjs: args, stdin, headers, exit codes', async () => {
  const { srv, got, port } = await stand();
  const env = { PATH: process.env.PATH, FANBOX_CTL: `http://127.0.0.1:${port}/api/agent`, FANBOX_CTL_TOKEN: 'tok-1', FANBOX_TERM_ID: 't4' };
  try {
    let r = await runNotify(['构建失败', '50%', '&', '"x"'], env);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(got.at(-1), { url: '/api/agent/notify', method: 'POST', ct: 'application/x-www-form-urlencoded', tok: 'tok-1', term: 't4', text: '构建失败 50% & "x"' });
    assert.ok(r.out.includes('"ok":true') && r.out.endsWith('\n'), 'prints the answer');
    r = await runNotify([], env, 'line1\n测试\n\n');
    assert.equal(r.code, 0, r.err);
    assert.equal(got.at(-1).text, 'line1\n测试', 'stdin, trailing newlines dropped like $(cat)');
    r = await runNotify(['decline'], env);
    assert.equal(r.code, 2, 'declined -> 2');
    assert.ok(r.out.includes('"ok":false'));
    r = await runNotify(['x'], { ...env, FANBOX_CTL: `http://127.0.0.1:${port}/api/agent/` });
    assert.equal(got.at(-1).url, '/api/agent/notify', 'trailing slash tolerated');
  } finally { srv.close(); }
  const off = await runNotify(['x'], { PATH: process.env.PATH });
  assert.equal(off.code, 1);
  assert.ok(off.err.includes('不在 FanBox 的终端里'));
  const { srv: s2, port: p2 } = await stand();
  s2.close();
  await new Promise((r) => s2.on('close', r));
  const down = await runNotify(['x'], { PATH: process.env.PATH, FANBOX_CTL: `http://127.0.0.1:${p2}/api/agent`, FANBOX_CTL_TOKEN: 't' });
  assert.equal(down.code, 1);
  assert.ok(down.err.includes('连不上 FanBox'));
});

// ---------------------------------------------------------------------------
// watch shell (2.20.0)
// ---------------------------------------------------------------------------
test('winShellSpec: Git Bash login shell with the command on stdin when Git Bash exists', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe', SystemRoot: 'C:\\Windows' };
  const s = H.winShellSpec("gh issue list --jq '.[]|\"#\\(.number)\"'", env, { exists: (f) => f === 'D:\\Git\\bin\\bash.exe' });
  assert.deepEqual(s, { file: 'D:\\Git\\bin\\bash.exe', args: ['-l', '-s'], stdin: "gh issue list --jq '.[]|\"#\\(.number)\"'", shell: 'bash' });
});

test('winShellSpec: absolute Windows PowerShell with -EncodedCommand otherwise', () => {
  const cmd = "Write-Output 'a & b'; \"$x\" | % { $_ }";
  const s = H.winShellSpec(cmd, { SystemRoot: 'E:\\Win', PATH: '' }, { exists: () => false });
  assert.equal(s.shell, 'powershell');
  assert.equal(s.file, 'E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(s.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.equal(s.args.length, 6);
  const script = Buffer.from(s.args[5], 'base64').toString('utf16le');
  assert.ok(script.endsWith('\n' + cmd), 'command carried verbatim inside the encoded script');
  assert.ok(script.startsWith('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'));
  assert.equal(s.stdin, '');
  assert.equal(H.winShellSpec('x', {}, { exists: () => false }).file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('driver.run: Windows string commands go through winShellSpec; arrays keep the CLI argv path', () => {
  const src = read('electron/wechat/driver.js');
  const w = src.slice(src.indexOf('    if (isWin()) {\n      // Windows：argv'), src.indexOf('    } else {\n      child = spawn(loginShell()'));
  assert.ok(w.includes("if (!Array.isArray(cmd)) {"));
  assert.ok(w.includes("require('../../win-port-helpers').winShellSpec(String(cmd), env)"));
  assert.ok(w.includes('stdinText = sh.stdin;'));
  assert.ok(w.includes('child = spawn(sh.file, sh.args, { cwd: spawnCwd, env, windowsHide: true });'));
  assert.ok(w.includes('const resolved = resolveWinCli(name, env);'));
  assert.ok(!/shell:\s*true/.test(w), 'never shell:true');
  assert.ok(src.includes("child = spawn(loginShell(), ['-lc', cmd], {"), 'POSIX branch untouched');
});

'use strict';
// Live Windows probe for the 2.20.1 port (Windows only): the watch shell runner (Git Bash, PowerShell fallback) and the
// fanbox-notify launchers through real PowerShell 5.1, cmd and Git Bash against a loopback stand-in for /api/agent/notify.
// Run from the repo root after npm install (needs node_modules/electron/dist/electron.exe):
//   node experiments/win-v2201-reach-202611/live-windows.js
// Known limit it records: Windows PowerShell 5.1 drops embedded double quotes when calling any .cmd (npm shims too).
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
if (process.platform !== 'win32') { console.log('skip: Windows only'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..', '..');
const H = require(path.join(ROOT, 'win-port-helpers.js'));
const driver = require(path.join(ROOT, 'electron', 'wechat', 'driver.js'));
const here = fs.mkdtempSync(path.join(os.tmpdir(), 'fanbox-v2201-live-'));
let fails = 0;
const ok = (c, name, d) => { console.log((c ? '  ok   ' : '  FAIL ') + name + (c ? '' : '  -- ' + d)); if (!c) fails++; };

(async () => {
  console.log('# watch runner');
  const r1 = await driver.run("echo 'a b'; echo \"$((40+2))\"; printf '%s\\n' 你好", '', here, { idleMs: 30000, maxMs: 60000 });
  ok(r1.ok && r1.out.includes('a b') && r1.out.includes('42') && r1.out.includes('你好'), 'Git Bash runs the command from stdin, UTF-8 out', JSON.stringify(r1));
  const r2 = await driver.run('exit 3', '', here, { idleMs: 30000, maxMs: 60000 });
  ok(!r2.ok, 'non-zero exit reports ok:false', JSON.stringify(r2));
  // PowerShell fallback: env without git / bash
  const noGit = { SystemRoot: process.env.SystemRoot, PATH: 'C:\\nonexistent', ProgramFiles: 'C:\\nonexistent' };
  const ps = H.winShellSpec("Write-Output 'x y'; Write-Output 你好; Write-Output (40+2)", noGit);
  ok(ps.shell === 'powershell' && path.isAbsolute(ps.file), 'fallback is absolute Windows PowerShell', JSON.stringify(ps));
  const pr = spawnSync(ps.file, ps.args, { encoding: 'utf8', windowsHide: true, input: '' });
  ok(pr.status === 0 && pr.stdout.includes('x y') && pr.stdout.includes('你好') && pr.stdout.includes('42'), 'PowerShell -EncodedCommand runs, UTF-8 out', JSON.stringify(pr.stdout) + pr.stderr);

  console.log('# fanbox-notify launchers');
  const bin = path.join(here, 'bin 中文');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fanbox-notify.cjs'), fs.readFileSync(path.join(ROOT, 'lib', 'win-fanbox-notify.cjs')));
  fs.writeFileSync(path.join(bin, 'fanbox-notify.cmd'), H.buildFanboxNotifyCmd());
  fs.writeFileSync(path.join(bin, 'fanbox-notify'), H.buildFanboxNotifySh());
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const text = new URLSearchParams(b).get('text');
      got.push({ url: req.url, tok: req.headers['x-fanbox-token'], term: req.headers['x-fanbox-term'], text });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(text === 'decline' ? { ok: false, delivered: 'reject' } : { ok: true, delivered: 'desktop' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env, FANBOX_CTL: `http://127.0.0.1:${port}/api/agent`, FANBOX_CTL_TOKEN: 'tok-xyz', FANBOX_TERM_ID: 't7', FANBOX_EXE: exe };
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  env[pk] = env[pk] + ';' + bin;
  const runP = (file, args, input) => new Promise((resolve) => {
    const c = spawn(file, args, { env, windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(input || '');
  });
  const pwsh = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const msg = '构建失败 50% & "quoted" done';
  let r = await runP(pwsh, ['-NoProfile', '-Command', "fanbox-notify '构建失败 50% & \"quoted\" done'"]);
  let last = got[got.length - 1] || {};
  ok(r.code === 0 && last.text === '构建失败 50% & quoted done' && last.tok === 'tok-xyz' && last.term === 't7', 'PowerShell -> .cmd (CJK, %, &; PS 5.1 drops the embedded quotes)', JSON.stringify({ r, last }));
  r = await runP(pwsh, ['-NoProfile', '-Command', 'fanbox-notify build failed in two words']);
  last = got[got.length - 1] || {};
  ok(r.code === 0 && last.text === 'build failed in two words', 'PowerShell -> .cmd unquoted words joined', JSON.stringify({ r, last }));
  r = await runP(pwsh, ['-NoProfile', '-Command', 'fanbox-notify decline; exit $LASTEXITCODE']);
  ok(r.code === 2 && r.out.includes('"ok":false'), 'declined -> exit 2 and JSON printed', JSON.stringify(r));
  const cmdExe = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  r = await runP(cmdExe, ['/d', '/c', 'fanbox-notify 中文 from cmd']);
  last = got[got.length - 1] || {};
  ok(r.code === 0 && last.text === '中文 from cmd', 'cmd -> .cmd', JSON.stringify({ r, last }));
  const bash = H.winGitBash(env);
  ok(!!bash, 'Git Bash found', '');
  if (bash) {
    r = await runP(bash, ['-c', "fanbox-notify '构建失败 $HOME 不展开'"]);
    last = got[got.length - 1] || {};
    ok(r.code === 0 && last.text === '构建失败 $HOME 不展开', 'Git Bash -> sh launcher', JSON.stringify({ r, last }));
    r = await runP(bash, ['-c', 'printf "line1\\n测试\\n" | fanbox-notify']);
    last = got[got.length - 1] || {};
    ok(r.code === 0 && last.text === 'line1\n测试', 'Git Bash pipe -> stdin', JSON.stringify({ r, last }));
  }
  const envNo = { ...env }; delete envNo.FANBOX_CTL;
  const c = spawnSync(exe, [path.join(bin, 'fanbox-notify.cjs'), 'x'], { env: { ...envNo, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  ok(c.status === 1 && c.stderr.includes('不在 FanBox 的终端里'), 'outside FanBox -> exit 1', JSON.stringify(c));
  srv.close();
  console.log(fails ? `FAILED ${fails}` : 'ALL OK');
  process.exit(fails ? 1 : 0);
})();

// Phase 3e — D11 snapshot eligibility casing, standalone server (no Electron needed).
// Spawns `node server.js` with a sandboxed USERPROFILE and probes /api/snapshot.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '../../..');
const FAKE_HOME = process.env.FB_MATRIX_HOME || 'C:\\Users\\bbbb\\fb-matrix-home';
const PORT = 45997;
let fails = 0;
const check = (ok, name, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' — ' + detail : '')); if (!ok) fails++; };

const post = (p, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});

(async () => {
  fs.rmSync(path.join(FAKE_HOME, '.fanbox', 'snapshots'), { recursive: true, force: true });
  const proj = path.join(FAKE_HOME, 'fanbox-test-fixtures', 'proj');
  fs.mkdirSync(path.join(proj, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sub', 'hello.js'), "console.log('hi')");
  const env = { ...process.env, USERPROFILE: FAKE_HOME, HOME: FAKE_HOME, FANBOX_NO_OPEN: '1', FANBOX_PORT: String(PORT) };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errBuf = ''; srv.stderr.on('data', (d) => errBuf += d);
  // wait for the port to accept (up to 20s)
  await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tryConnect = () => {
      const s = require('net').connect(PORT, '127.0.0.1', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); if (Date.now() - t0 > 20000) reject(new Error('server did not start: ' + errBuf.slice(0, 400))); else setTimeout(tryConnect, 500); });
    };
    tryConnect();
  });
  try {
    const snap = (p) => post('/api/snapshot', { path: p, label: 'matrix' });
    const lcHome = FAKE_HOME.toLowerCase();
    check((await snap(lcHome)).skipped === 'ineligible', 'lowercased $HOME refused');
    check((await snap(FAKE_HOME.toUpperCase())).skipped === 'ineligible', 'uppercased $HOME refused');
    check((await snap(lcHome + '\\appdata')).skipped === 'ineligible', 'lowercased AppData refused');
    check((await snap('C:\\')).skipped === 'ineligible', 'drive root refused');
    check((await snap('C:\\Windows')).skipped === 'ineligible', 'C:\\Windows refused');
    check((await snap('c:\\users')).skipped === 'ineligible', 'c:\\users refused');
    const r1 = await snap(proj.toLowerCase() + '\\');
    check(r1.ok === true && r1.created === true, 'legit project (lowercased + trailing \\) snapshots', JSON.stringify(r1));
    const r2 = await snap(proj);
    check(r2.ok === true && r2.skipped === 'throttled', 'normal-cased same project → same key (throttled)', JSON.stringify(r2));
    const repos = fs.readdirSync(path.join(FAKE_HOME, '.fanbox', 'snapshots')).filter((n) => n !== 'index.json');
    check(repos.length === 1, 'exactly one shadow repo regardless of casing', String(repos.length));
    const litter = fs.readdirSync(proj).filter((n) => /^\.git/.test(n));
    check(litter.length === 0, 'nothing written inside the project', JSON.stringify(litter));
  } finally { srv.kill(); }
  console.log(`\nRESULT: ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

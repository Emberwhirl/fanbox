// Shared launcher: Playwright drives the real dev Electron app with a sandboxed
// fake home so the user's actual ~/.fanbox / AppData are never touched.
const { _electron } = require('playwright-core');
const path = require('path');

const ROOT = 'D:\\fanbox';
const FAKE_HOME = 'C:\\Users\\bbbb\\fb-matrix-home';
const TOOLS_PATH = 'C:\\Users\\bbbb\\tools\\imagemagick;D:\\ffmpeg-master-latest-win64-gpl-shared\\bin;';

async function launch(extraEnv = {}, opts = {}) {
  const env = {
    ...process.env,
    USERPROFILE: FAKE_HOME,
    HOME: FAKE_HOME,
    APPDATA: path.join(FAKE_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(FAKE_HOME, 'AppData', 'Local'),
    // Path key set below — must reuse the host env's exact key casing or Windows spawn
    // gets duplicate Path/PATH keys and the unmodified one can win
    FANBOX_PORT: opts.port || '4650',
    ...extraEnv,
  };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  env[pathKey] = (opts.toolsPath !== undefined ? opts.toolsPath : TOOLS_PATH) + (env[pathKey] || '');
  delete env.NoDefaultCurrentDirectoryInExePath;
  // inherited MSYS SHELL would change shell resolution — drop it unless the test set one explicitly
  if (!('SHELL' in extraEnv)) delete env.SHELL;
  const app = await _electron.launch({
    executablePath: require(path.join(ROOT, 'node_modules/electron')),
    args: [ROOT], cwd: ROOT, env,
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1560, 950); w.center(); });
  await win.waitForTimeout(2500);
  if (!opts.keepOnboarding) {
    await win.evaluate(() => { localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_term_open', '1'); localStorage.setItem('fb_term_dock', 'bottom'); });
    await win.evaluate(() => location.reload()).catch(() => {});
    await win.waitForTimeout(2500);
  }
  await win.evaluate(() => { try { window.playChime = () => {}; } catch {} });
  return { app, win };
}

// Read the whole visible xterm buffer of a session as one string
const BUF_FN = `(id) => {
  const s = term.sessions.find((x) => x.id === (id || term.active));
  if (!s) return '';
  const b = s.xterm.buffer.active; const lines = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
  return lines.join('\\n');
}`;

// app.close() can hang while a ConPTY child is alive — race it and hard-kill leftovers
async function closeApp(app) {
  const { execFile } = require('child_process');
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  await new Promise((r) => execFile('C:\\Windows\\System32\\taskkill.exe', ['/IM', 'electron.exe', '/T', '/F'], () => r()));
  await new Promise((r) => setTimeout(r, 1500));
}

let fails = 0;
const check = (ok, name, detail) => { console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); if (!ok) fails++; };
const done = (app) => Promise.resolve(app && closeApp(app)).catch(() => {}).then(() => { console.log(`\nRESULT: ${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`); process.exit(fails ? 1 : 0); });

module.exports = { launch, closeApp, check, done, BUF_FN, FAKE_HOME, ROOT };

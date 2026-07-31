// Harness over the REAL electron/wechat/driver.js source: re-compiles it with its
// internals (run/resolveWinCli/winFindOnPath) appended to module.exports for testing.
const path = require('path');
const fs = require('fs');
const Module = require('module');

const DRIVER = 'D:\\fanbox\\electron\\wechat\\driver.js';
const HARNESS = __dirname;
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`); };

const src = fs.readFileSync(DRIVER, 'utf8') + '\nmodule.exports.__test = { run, resolveWinCli, winFindOnPath };\n';
const m = new Module(DRIVER, null);
m.filename = DRIVER;
m.paths = Module._nodeModulePaths(path.dirname(DRIVER));
m._compile(src, DRIVER);
const { run, resolveWinCli, winFindOnPath } = m.exports.__test;
const { which } = m.exports;

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // D5-A: standalone codex.exe resolved argv-style
  const codex = resolveWinCli('codex', process.env);
  rec('D5 resolveWinCli codex -> .exe', !!codex && /codex\.exe$/i.test(codex.file) && codex.preArgs.length === 0, codex && codex.file);

  // D5-B: claude absent -> null, and run() gives the friendly CLI-not-found (no shell fallback)
  const claude = resolveWinCli('claude', process.env);
  rec('D5 resolveWinCli claude -> null', claude === null, String(claude));
  const notFound = await run(['claude', '-p'], 'hi', null, { idleMs: 8000, maxMs: 10000 });
  rec('D5 run(claude) CLI-not-found message', notFound.ok === false && /CLI not found: claude/.test(notFound.err) && /@anthropic-ai\/claude-code/.test(notFound.err), JSON.stringify(notFound.err).slice(0, 120));

  // §5: quoted PATH entries are unquoted
  const codexDir = path.dirname(codex.file);
  const fakeEnv = { Path: `"${codexDir}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const viaQuoted = winFindOnPath('codex', fakeEnv);
  rec('§5 quoted PATH entry unquoted', !!viaQuoted && /codex\.exe$/i.test(viaQuoted), String(viaQuoted));

  // which(): async, uses replicated env
  rec('which(codex) === true', (await which('codex')) === true);
  rec('which(claude) === false', (await which('claude')) === false);

  // H2: idle-timeout kill must take down the WHOLE tree (node spawner -> node sleeper)
  try { fs.unlinkSync(path.join(HARNESS, 'grandchild.pid')); } catch {}
  try { fs.unlinkSync(path.join(HARNESS, 'self.pid')); } catch {}
  const r = await run(['node', path.join(HARNESS, 'spawner.js')], '', HARNESS, { idleMs: 4000, maxMs: 60000 });
  const gpid = parseInt(fs.readFileSync(path.join(HARNESS, 'grandchild.pid'), 'utf8'), 10);
  const spid = parseInt(fs.readFileSync(path.join(HARNESS, 'self.pid'), 'utf8'), 10);
  rec('H2 run() timed out via idle', r.timedOut === true && r.timeoutReason === 'idle', `ms=${r.ms}`);
  await sleep(3000); // taskkill runs to completion after promise resolves
  const childAlive = alive(spid), grandAlive = alive(gpid);
  rec('H2 child (spawner) dead after kill', !childAlive, `pid=${spid}`);
  rec('H2 grandchild (sleeper) dead after kill — no orphan', !grandAlive, `pid=${gpid}`);
  if (grandAlive) { try { process.kill(gpid); } catch {} }

  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();

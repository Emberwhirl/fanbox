// resolveWinCli npm-shim branch: fabricate a realistic npm global-bin layout and
// verify the shim is resolved to its node_modules JS entry, run with real node.exe.
const path = require('path');
const fs = require('fs');
const Module = require('module');

const DRIVER = 'D:\\fanbox\\electron\\wechat\\driver.js';
const src = fs.readFileSync(DRIVER, 'utf8') + '\nmodule.exports.__test = { run, resolveWinCli, winFindOnPath };\n';
const m = new Module(DRIVER, null);
m.filename = DRIVER;
m.paths = Module._nodeModulePaths(path.dirname(DRIVER));
m._compile(src, DRIVER);
const { resolveWinCli } = m.exports.__test;

const binDir = path.join(__dirname, 'fake-npm-bin');
const entry = path.join(binDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, 'console.log("fake cli")');
// Real npm .cmd shim shape (npm 9+ cmd-shim output, abridged to the load-bearing line)
fs.writeFileSync(path.join(binDir, 'claude.cmd'),
  '@ECHO off\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\n' +
  '"%NODE_EXE%" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');

const env = { Path: binDir + ';' + process.env.Path, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const r = resolveWinCli('claude', env);
const okEntry = r && r.preArgs.length === 1 && path.resolve(r.preArgs[0]) === path.resolve(entry);
const okNode = r && /node\.exe$/i.test(r.file);
console.log((okEntry && okNode ? 'PASS' : 'FAIL') + '  shim -> node + cli.js entry  ' + JSON.stringify(r));
process.exit(okEntry && okNode ? 0 : 1);

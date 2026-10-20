'use strict';
// Explicit opt-in, read-only live quota check. No app/profile startup, log scan,
// credential copy, token refresh, or credential output. Uses the shipped functions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');

if (!process.argv.includes('--live')) {
  console.error('Requires --live: reads existing CLI sign-ins and queries official quota endpoints.');
  process.exit(2);
}
const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  if (a < 0 || b <= a) throw new Error('Source markers changed; inspect the quota check before running.');
  return source.slice(a, b);
}
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const context = {
  fs, fsp: fs.promises, path, process, execFile, Date, Map, Number, JSON,
  PLATFORM: process.platform, HOME: os.homedir(), WIN_SYS32: sys32,
  WIN_PS: path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  usageResultCache: { at: 0 },
};
vm.createContext(context);
vm.runInContext(slice('function winSpawnEnv(extra) {', '// 注意：单靠上面那个环境变量'), context);
vm.runInContext(slice('function winFindExe(name, extraDirs) {', '// VS Code 真身'), context);
vm.runInContext(slice('async function claudeOAuthToken() {', '// ---------- Agent 项目'), context);
function summary(value) {
  const windows = ['fiveHour', 'sevenDay', 'primary', 'secondary'].filter((k) => value[k]);
  return {
    ok: windows.length > 0 && !value.error,
    error: value.error || null,
    stale: !!value.stale,
    windows: windows.map((name) => ({ name, windowMinutes: value[name].windowMinutes || null,
      hasUsage: Number.isFinite(value[name].usedPercent), hasReset: !!value[name].resetsAt })),
    resetCreditsPresent: !!value.resets,
  };
}
(async () => {
  const [claude, codex] = await Promise.all([context.claudeOfficialLimits(), context.codexOfficialLimits()]);
  console.log(JSON.stringify({ at: new Date().toISOString(), platform: process.platform,
    claude: summary(claude), codex: summary(codex) }, null, 2));
  process.exitCode = summary(claude).ok && summary(codex).ok ? 0 : 1;
})().catch(() => { console.error('Live quota check failed; no credentials or raw response logged.'); process.exitCode = 1; });

'use strict';
// FanBox启动的会话使用此桥；只回传额度，不上传提示词、路径或会话正文。
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
function limits(data) {
  const win = (w) => w && Number.isFinite(w.used_percentage) && w.used_percentage >= 0 && Number.isFinite(w.resets_at)
    ? { usedPercent: w.used_percentage, resetsAt: w.resets_at } : null;
  return { fiveHour: win(data.rate_limits?.five_hour), sevenDay: win(data.rate_limits?.seven_day) };
}
function originalStatusLine(cwd) {
  // 用户→项目→项目本地，优先级与CLI一致；不写回用户配置。
  const files = [path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')];
  let root = cwd;
  while (root && path.dirname(root) !== root && !fs.existsSync(path.join(root, '.git'))) root = path.dirname(root);
  const dirs = [...new Set([root, cwd].filter(Boolean))];
  for (const dir of dirs) for (const name of ['settings.json', 'settings.local.json']) files.push(path.join(dir, '.claude', name));
  let setting;
  for (const file of files) { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if ('statusLine' in d) setting = d.statusLine; } catch { /* */ } }
  return setting;
}
// Windows port (win32 only): Claude Code runs status lines through Git Bash, never cmd.exe, so the
// user's own statusLine has to run there too. Same lookup order as win-port-helpers.winGitBash
// (CLAUDE_CODE_GIT_BASH_PATH, git.exe on PATH mapped to <root>\bin\bash.exe, %ProgramFiles%\Git);
// inlined because this copied file cannot require the helpers.
function winBash() {
  if (process.platform !== 'win32') return null;
  const env = process.env, w = path.win32;
  const ok = (f) => { try { return !!f && fs.existsSync(f); } catch { return false; } };
  if (ok(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH;
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const d of String(env.Path || env.PATH || '').split(';').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) {
    if (!exts.some((x) => ok(w.join(d, 'git' + x)))) continue;
    for (const up of [['..'], ['..', '..']]) { const b = w.join(d, ...up, 'bin', 'bash.exe'); if (ok(b)) return b; }
    break;
  }
  for (const k of ['ProgramFiles', 'ProgramW6432']) { const b = env[k] && w.join(env[k], 'Git', 'bin', 'bash.exe'); if (ok(b)) return b; }
  return null;
}
// Windows port (win32 only): FanBox's language for the quota label, in the order the app itself
// resolves it: ~/.fanbox/config.json `lang` ('zh' | 'en', written when the user clicks the toggle;
// read live so a later choice wins), else FANBOX_LANG (the UI language main.js put in the PTY env,
// which is Chromium's UI locale for users who never toggled), else the process locale.
function winLang() {
  try { const l = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.fanbox', 'config.json'), 'utf8')).lang; if (l === 'zh' || l === 'en') return l; } catch { /* */ }
  const envLang = process.env.FANBOX_LANG; if (envLang === 'zh' || envLang === 'en') return envLang;
  return String(Intl.DateTimeFormat().resolvedOptions().locale || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
function run(input) {
  let data; try { data = JSON.parse(input); } catch { return; }
  const usage = limits(data);
  if (usage.fiveHour || usage.sevenDay) {
    try {
      const url = new URL(`${process.env.FANBOX_CTL}/usage`);
      if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fanbox-token': process.env.FANBOX_CTL_TOKEN || '' } }, (res) => res.resume());
        req.on('error', () => {}); req.setTimeout(1000, () => req.destroy()); req.end(JSON.stringify(usage));
      }
    } catch { /* 未在FanBox内 */ }
  }
  const setting = originalStatusLine(data.cwd || process.cwd());
  const bash = setting?.type === 'command' ? winBash() : null; // win32 only; null elsewhere and without Git Bash (then upstream's lines below run)
  if (bash && setting?.type === 'command' && setting.command && !setting.command.includes('claude-statusline.cjs')) {
    const child = spawnSync(bash, ['-c', setting.command], { input, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 3000, maxBuffer: 1024 * 1024, cwd: data.cwd || process.cwd(), windowsHide: true });
    if (child.stdout) process.stdout.write(child.stdout);
    return;
  }
  if (setting?.type === 'command' && setting.command && !setting.command.includes('claude-statusline.cjs')) {
    const child = spawnSync(setting.command, { shell: true, input, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeout: 3000, maxBuffer: 1024 * 1024, cwd: data.cwd || process.cwd() });
    if (child.stdout) process.stdout.write(child.stdout);
  } else if (setting !== null) {
    const parts = [];
    if (usage.fiveHour) parts.push(`5h ${Math.round(usage.fiveHour.usedPercent)}%`);
    if (usage.sevenDay) parts.push(`周 ${Math.round(usage.sevenDay.usedPercent)}%`);
    if (process.platform === 'win32' && winLang() === 'en') for (let i = 0; i < parts.length; i++) parts[i] = parts[i].replace(/^周/, '7d'); // Windows port: English label follows FanBox's language
    if (parts.length) process.stdout.write(parts.join(' · ') + '\n');
  }
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => run(input));
}
module.exports = { limits, originalStatusLine };

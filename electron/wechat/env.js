// 复刻用户终端环境：打包后的 App 从 GUI（Finder/Dock / 开始菜单）启动时，拿到的是系统阉割过的环境
// （没 PATH 补充、没代理、没 ANTHROPIC_BASE_URL 等自定义变量）——claude/codex 子进程因此
// 找不到命令、或裸连 api 被 403 地域拦截。这里跑一次用户的「交互式登录 shell」抓回它的完整环境，
// 让子进程联网方式和用户平时在终端里跑 claude/codex 完全一致——不假设任何特定代理方式。
//   主：导入 shell 环境（macOS: zsh/bash login；Windows: PowerShell 用户配置）
//   辅：导入后仍没有代理变量 → 读系统代理兜底（macOS scutil / Windows 注册表），只补空缺不覆盖
const { execFile } = require('child_process');
const os = require('os');

let cached = null; // Promise<env 对象>，只算一次

const isWin = () => process.platform === 'win32';
const userShell = () => process.env.SHELL || (isWin() ? 'powershell.exe' : '/bin/zsh');
const PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];

// 跑交互式登录 shell 抓完整环境变量（PATH/代理/BASE_URL 等）
function dumpShellEnv() {
  return new Promise((resolve) => {
    if (isWin()) {
      // PowerShell 打印环境：整块 Base64(UTF-8) 回传——PS 5.1 的重定向输出按 OEM/ANSI 代码页编码
      //（zh-CN 是 GBK），中文用户名（C:\Users\小雨）的 USERPROFILE/Path 按 UTF-8 解出来是乱码，
      // 坏值合进 env 后 spawn cwd ENOENT、子进程 PATH 全断。Base64 只含 ASCII，任何代码页都不失真。
      // marker 挡掉潜在噪声输出
      const marker = '__FANBOX_ENV_8f3a__';
      const ps = [
        `$ProgressPreference='SilentlyContinue'`,
        `$s = (Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value }) -join "\`n"`,
        `Write-Output ('${marker}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) + '${marker}')`,
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      }, (err, stdout) => {
        // -NoProfile 故意不加载 profile（慢且常挂代理脚本）；再补一次注册表 PATH 合并
        const b64 = (String(stdout || '').split(marker)[1] || '').trim();
        let block = '';
        try { block = Buffer.from(b64, 'base64').toString('utf8'); } catch { /* 空对象兜底 */ }
        const env = parseEnvLines(block);
        mergeWinUserPath(env).then((merged) => resolve(merged));
      });
      return;
    }
    // POSIX：`$SHELL -ilc 'env'` 抓交互式登录 shell 的完整环境
    const marker = '__FANBOX_ENV_8f3a__';
    const cmd = `printf '%s\\n' '${marker}'; env; printf '%s\\n' '${marker}'`;
    execFile(userShell(), ['-ilc', cmd], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(parseEnvBlock(stdout, marker)); // 抓不到（err 且无输出）→ 空对象，退回 process.env 打底
    });
  });
}

function parseEnvLines(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function parseEnvBlock(stdout, marker) {
  return parseEnvLines(String(stdout || '').split(marker)[1] || '');
}

// Windows：把用户级 + 系统级 PATH 注册表拼进 env（GUI 启动时 process.env.PATH 经常缺用户目录）
function mergeWinUserPath(env) {
  return new Promise((resolve) => {
    if (!isWin()) return resolve(env);
    const ps = [
      `$u=[Environment]::GetEnvironmentVariable('Path','User')`,
      `$m=[Environment]::GetEnvironmentVariable('Path','Machine')`,
      `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($m + ';' + $u))`, // Base64：中文目录名不被代码页毁掉（同 dumpShellEnv）
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 5000, windowsHide: true,
    }, (err, stdout) => {
      let pathStr = '';
      try { pathStr = Buffer.from(String(stdout || '').trim(), 'base64').toString('utf8').replace(/^;+|;+$/g, ''); } catch { /* */ }
      if (pathStr) {
        const cur = env.Path || env.PATH || process.env.Path || process.env.PATH || '';
        // 注册表 PATH 在前（用户装的 claude/npm 全局），当前 process PATH 兜底
        const merged = [pathStr, cur].filter(Boolean).join(';');
        env.Path = merged;
        env.PATH = merged;
      }
      resolve(env);
    });
  });
}

// Windows 注册表 ProxyServer 三种形态：'host:port'｜'http=h:p;https=h:p;…'（协议表）｜'socks=h:p'（仅 SOCKS）。
// 仅 SOCKS 时给 socks5h://（DNS 也走代理），千万别把 'socks=h:p' 原样当 http 代理导出（非法 URL）。
// 注意：server.js 里有同名孪生函数（server.js 保持零本地依赖，不 require electron/ 下的文件），改这里记得同步那边。
function parseWinProxyServer(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;
  let val = raw, socks = false;
  if (raw.includes('=')) {
    const pick = (k) => ((raw.match(new RegExp('(?:^|;)\\s*' + k + '=([^;]+)', 'i')) || [])[1] || '').trim();
    const h = pick('https') || pick('http');
    if (h) val = h;
    else if (pick('socks')) { val = pick('socks'); socks = true; }
    else return null;
  } else if (/^socks/i.test(raw)) socks = true;
  if (socks) return { url: 'socks5h://' + val.replace(/^socks[45]?h?:\/\//i, ''), socks: true };
  return { url: /^https?:\/\//i.test(val) ? val : 'http://' + val, socks: false };
}

// 读系统代理，转成 {https_proxy,...}；没开代理 → 空对象
function sysProxyEnv() {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      execFile('scutil', ['--proxy'], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve({});
        const out = String(stdout || '');
        const grab = (k) => (out.match(new RegExp(`\\b${k} : (\\S+)`)) || [])[1];
        let url = '';
        if (grab('HTTPSEnable') === '1') url = `http://${grab('HTTPSProxy')}:${grab('HTTPSPort')}`;
        else if (grab('HTTPEnable') === '1') url = `http://${grab('HTTPProxy')}:${grab('HTTPPort')}`;
        else if (grab('SOCKSEnable') === '1') url = `socks5h://${grab('SOCKSProxy')}:${grab('SOCKSPort')}`;
        if (!url) return resolve({});
        resolve({ http_proxy: url, https_proxy: url, HTTP_PROXY: url, HTTPS_PROXY: url, all_proxy: url, ALL_PROXY: url });
      });
      return;
    }
    if (isWin()) {
      // HKCU Internet Settings：ProxyEnable + ProxyServer（Clash/v2rayN 等会写）
      const ps = [
        `$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue`,
        `if ($p -and $p.ProxyEnable -eq 1 -and $p.ProxyServer) { Write-Output $p.ProxyServer }`,
      ].join('; ');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        timeout: 4000, windowsHide: true,
      }, (err, stdout) => {
        const px = parseWinProxyServer(String(stdout || '').trim());
        if (!px) return resolve({});
        // 仅 SOCKS（Clash/v2rayN 高级形态 'socks=h:p'）：只给 all_proxy——curl 认 socks5h://，
        // 不认 SOCKS 的 CLI 直连（等价 macOS 没配 HTTP 代理时的行为）；无效的 http_proxy 比没有更糟
        if (px.socks) return resolve({ all_proxy: px.url, ALL_PROXY: px.url });
        resolve({
          http_proxy: px.url, https_proxy: px.url,
          HTTP_PROXY: px.url, HTTPS_PROXY: px.url,
          all_proxy: px.url, ALL_PROXY: px.url,
        });
      });
      return;
    }
    resolve({});
  });
}

async function build() {
  const shellEnv = await dumpShellEnv();
  const env = { ...process.env, ...shellEnv }; // process.env 打底，shell 导入的覆盖（PATH/代理/BASE_URL/key 等）
  if (!PROXY_KEYS.some((k) => env[k])) Object.assign(env, await sysProxyEnv()); // 仍无代理 → 系统代理兜底，不覆盖已有
  // claude/codex 含中文，保 UTF-8；Windows 控制台也需要
  if (!/UTF-8|utf8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) {
    env.LANG = isWin() ? 'en_US.UTF-8' : 'en_US.UTF-8';
  }
  if (isWin()) {
    env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
    // ConPTY / 子进程友好
    if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  }
  return env;
}

// 复刻后的完整环境（含代理兜底），只算一次后缓存
function fullEnv() {
  if (!cached) cached = build();
  return cached;
}

module.exports = { fullEnv, parseWinProxyServer };

// 本机 CLI 驱动器：用 claude / codex 的无头模式起一个实例和它对话，作为微信消息的「大脑」。
// 用户文本一律走 stdin（不进命令行，零转义/长度风险）；claude 用 session_id 续上下文。
// 复用本机已登录的 claude/codex 凭据，原生读 cwd 下的 CLAUDE.md / AGENTS.md。
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { fullEnv } = require('./env');

const isWin = () => process.platform === 'win32';
const loginShell = () => process.env.SHELL || (isWin() ? 'powershell.exe' : '/bin/zsh');

// Windows：纯 Node 在 PATH 里找可执行文件（PATHEXT 补扩展名）。不走 where.exe / Get-Command：
// 它们的输出按 OEM 代码页编码，中文用户名路径会被 UTF-8 误解码成乱码 → existsSync 失败
function winFindOnPath(name, env) {
  const e = env || process.env;
  const dirs = String(e.Path || e.PATH || '').split(';').map((s) => s.trim()).filter(Boolean);
  const exts = String(e.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = /\.[^\\/.]+$/.test(name);
  for (const d of dirs) {
    if (hasExt) {
      const f = path.join(d, name);
      try { if (fs.existsSync(f)) return f; } catch { /* */ }
      continue;
    }
    for (const ext of exts) {
      const f = path.join(d, name + ext);
      try { if (fs.existsSync(f)) return f; } catch { /* */ }
    }
  }
  return null;
}

// 把 claude/codex 解析成「可直接 spawn 的可执行 + 前置参数」，绕开 PowerShell/cmd 中转：
//  - 原生 .exe → 直接跑
//  - npm shim（.cmd/.ps1/无扩展名）→ 从 shim 文本里挖 node_modules 下的 JS 入口，用 node 直跑
// 好处一次讲清：stdin 字节透明（中文不被 PS 按控制台代码页重编码成 ???）、参数是真 argv
//（人格带引号/换行不会被 .cmd/PS 的再引用规则拆碎）、kill 杀得到本体（不会留孤儿烧 token）
function resolveWinCli(name, env) {
  const hit = winFindOnPath(name, env);
  if (!hit) return null;
  const ext = path.extname(hit).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: hit, preArgs: [] };
  const dir = path.dirname(hit);
  let entry = null;
  // shim 三兄弟（.cmd / .ps1 / 无扩展名 sh 版）内容里都写着 node_modules 下的入口路径
  const texts = [hit, hit.replace(/\.(cmd|ps1)$/i, ''), hit.replace(/\.(cmd|ps1)$/i, '') + '.ps1'];
  for (const f of texts) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const m = txt.match(/node_modules[\\/][^"'\r\n]+?\.[cm]?js/i);
    if (m) {
      const cand = path.resolve(dir, m[0].replace(/\//g, path.sep));
      if (fs.existsSync(cand)) { entry = cand; break; }
    }
  }
  if (!entry) { // shim 格式不认识 → 按已知包名猜
    const guess = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js' }[name];
    if (guess) {
      const cand = path.join(dir, 'node_modules', ...guess.split('/'));
      if (fs.existsSync(cand)) entry = cand;
    }
  }
  if (!entry) return null;
  const node = winFindOnPath('node', env);
  if (node) return { file: node, preArgs: [entry] };
  // 没找到 node.exe（只剩 shim 的残局）：Electron 自己当 node 用
  return { file: process.execPath, preArgs: [entry], extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

// 跑一条命令，prompt 写 stdin。env 复刻自用户的交互式登录 shell（见 env.js）：
// 打包后从 GUI 启动会丢掉 PATH/代理/BASE_URL，这里补回来，子进程联网方式和用户终端一致。
// onLine：可选，stdout 每攒满一整行就回调一次（用于流式过程播报）；不传则纯收尾解析，行为不变。
// 超时用「空闲」而非「总耗时」判定：agent 真干活会持续吐 stream-json 事件，永远不会长时间沉默；
// 而代理静默挂起表现为完全无输出。所以 idleMs 内零输出=判卡死（适配任何用户的代理，不挑节点）；
// maxMs 是防「无限循环一直吐事件」的失控 agent 的绝对天花板，不当主闸门。
// 返回 timedOut / timeoutReason('idle'|'max')，给上层决定要不要重试（只重试 idle）。
async function run(cmd, stdinText, cwd, opts = {}, onLine = null) {
  const idleMs = opts.idleMs || 120000;   // 无任何输出超过这条线 → 判连接卡死
  const maxMs = opts.maxMs || 1800000;    // 绝对上限（30min），防失控
  const env = await fullEnv();
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    if (isWin()) {
      // Windows：argv 数组直达 CLI 本体（见 resolveWinCli），不经 PowerShell——
      // PS 5.1 会把 stdin 按控制台代码页重编码（中文变 ???）、给原生子进程重拼参数时拆碎引号，
      // 且 kill 只杀得到 PS 壳，claude 本体成孤儿继续烧 token
      const [name, ...rest] = Array.isArray(cmd) ? cmd : [String(cmd)];
      const spawnCwd = cwd || env.HOME || env.USERPROFILE || process.env.USERPROFILE || process.env.HOME;
      const resolved = resolveWinCli(name, env);
      if (resolved) {
        child = spawn(resolved.file, [...resolved.preArgs, ...rest], {
          cwd: spawnCwd,
          env: resolved.extraEnv ? { ...env, ...resolved.extraEnv } : env,
          windowsHide: true,
        });
      } else {
        // 兜底（基本走不到：which() 探测不到时上层根本不会调进来）：退回 PowerShell 中转
        const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-Command', [name, ...rest.map(psq)].join(' '),
        ], { cwd: spawnCwd, env, windowsHide: true });
      }
    } else {
      child = spawn(loginShell(), ['-lc', cmd], {
        cwd: cwd || env.HOME || process.env.HOME,
        env,
      });
    }
    let out = '', err = '', done = false, lineBuf = '', idleTimer = null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(idleTimer); clearTimeout(maxTimer); resolve({ ...r, ms: Date.now() - started }); };
    const kill = (reason) => {
      try {
        if (isWin()) {
          // taskkill /T 杀整棵进程树：child 可能是 node 直跑的本体（自己还会再开 helper），
          // 也可能是兜底的 PS 壳——只 child.kill() 会把真正干活的 claude/codex 留成孤儿，
          // 超时重试 3 次就是 3 个孤儿同时改同一个项目、一起烧 token
          if (child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { /* */ });
          child.kill();
        } else child.kill('SIGKILL');
      } catch { /* */ }
      finish({ ok: false, out, err: err + `\n[超时:${reason}]`, timedOut: true, timeoutReason: reason });
    };
    const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => kill('idle'), idleMs); };
    const maxTimer = setTimeout(() => kill('max'), maxMs);
    armIdle(); // 从 spawn 起算：覆盖「首字之前」的连接挂起窗口
    child.stdout.on('data', (d) => {
      if (done) return; // 杀进程后迟到的 data 不再处理，隔离重试之间的串扰
      armIdle();
      const s = d.toString('utf8'); out += s;
      if (!onLine) return;
      lineBuf += s; let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1); try { onLine(line); } catch { /* */ } }
    });
    child.stderr.on('data', (d) => { if (done) return; armIdle(); err += d.toString('utf8'); }); // stderr 也算「活着」
    child.on('error', (e) => finish({ ok: false, out, err: String(e && e.message || e) }));
    child.on('close', (code) => finish({ ok: code === 0, code, out, err }));
    try { child.stdin.write(stdinText || ''); child.stdin.end(); } catch { /* */ }
  });
}

// 从一个 usage 对象估出「上下文有多重」的 token 数：优先 claude 的输入侧（含缓存读写=被重放的全部输入），
// 退回 codex/openai 风格的 total/prompt。用来驱动自动压缩闸门，不需要绝对精确，量级对就行。
function usageTokens(u) {
  if (!u || typeof u !== 'object') return 0;
  const claudeInput = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  if (claudeInput) return claudeInput;
  return u.total_tokens || u.prompt_tokens || 0;
}

// 把一次工具调用翻译成一句手机能看懂的「正在干啥」。null 表示这步不值得播报。
function progressNote(name, input) {
  const i = input || {};
  const base = (p) => (p ? require('path').basename(String(p)) : '');
  switch (name) {
    case 'Read': return `正在看 ${base(i.file_path)}`.trim();
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return `正在改 ${base(i.file_path)}`.trim();
    case 'Bash': return i.description ? `正在跑：${i.description}` : '正在跑命令';
    case 'Grep': case 'Glob': return `正在搜索 ${i.pattern || ''}`.trim();
    case 'WebFetch': case 'WebSearch': return '正在查资料';
    case 'Task': return '正在派子任务处理';
    default: return name ? `正在用 ${name}` : '';
  }
}
// codex 事件五花八门，尽力翻译，翻不出就给个通用句（外层有节流，不会刷屏）。
function codexNote(item) {
  if (!item) return '';
  if (item.command) { const c = Array.isArray(item.command) ? item.command.join(' ') : item.command; return `正在跑：${String(c).slice(0, 60)}`; }
  if (item.path || item.file) return `正在改 ${require('path').basename(item.path || item.file)}`;
  return '正在处理';
}

// 检测本机有没有这个 CLI
function which(bin) {
  if (isWin()) {
    // 纯 Node PATH 走查（用复刻后的完整 PATH，含注册表合并的用户目录）：
    // 不起 PowerShell，也避开它输出的代码页乱码
    const safe = String(bin).replace(/[^A-Za-z0-9._-]/g, '');
    return fullEnv().then((env) => !!winFindOnPath(safe, env)).catch(() => !!winFindOnPath(safe, null));
  }
  return run(`command -v ${bin} || true`, '', null, { idleMs: 8000, maxMs: 10000 }).then((r) => !!(r.out || '').trim());
}

// claude 无头：续话靠「首轮自带 --session-id <我们生成的 uuid>，之后 --resume 同一 uuid」。
//  关键：不能让 claude 自动生成 session——print 模式自动建的会话 resume 不到（实测会报 No conversation found）。
// onProgress(note)：可选。传了就用 stream-json 边跑边把工具调用播报出去；不传走原来的一次性 json。
async function runClaude(text, cwd, sessionId, persona, onProgress) {
  const sid = sessionId || require('crypto').randomUUID();
  // 一律走 stream-json：持续吐事件，空闲超时才有活动信号可依（非流式 json 整轮沉默会被误杀）。
  // Windows 是真 argv 数组（人格含引号/换行零转义直达）；POSIX 保持登录 shell 字符串不动
  let cmd;
  if (isWin()) {
    cmd = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (persona) cmd.push('--append-system-prompt', persona);
    cmd.push(...(sessionId ? ['--resume', sid] : ['--session-id', sid]));
  } else {
    const flag = sessionId ? `--resume ${sid}` : `--session-id ${sid}`;
    const sys = persona ? `--append-system-prompt ${shq(persona)}` : '';
    cmd = `claude -p --output-format stream-json --verbose --dangerously-skip-permissions ${sys} ${flag}`;
  }
  let result = '', outSid = sid, tokens = 0, cost = 0, r, ms = 0, attempts = 0;
  // 空闲卡死（连接挂起）→ 换新进程=新连接重试，最多 3 次（首次 + 2 重试）。每次清空累计，避免串数据。
  for (attempts = 1; attempts <= 3; attempts++) {
    result = ''; outSid = sid; tokens = 0; cost = 0;
    // 逐行解析 JSONL：result 事件 → 最终文本/session/用量；工具调用 → 播报（仅传了 onProgress 时）
    const onLine = (line) => {
      const t = line.trim(); if (!t || t[0] !== '{') return;
      let o; try { o = JSON.parse(t); } catch { return; }
      if (o.type === 'result') { result = o.result || result; outSid = o.session_id || outSid; if (o.usage) tokens = usageTokens(o.usage) || tokens; if (o.total_cost_usd != null) cost = o.total_cost_usd; return; }
      if (onProgress && o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) { if (b.type === 'tool_use') { const p = progressNote(b.name, b.input); if (p) onProgress(p); } }
      }
    };
    if (attempts > 1 && onProgress) onProgress('（连接卡住，正在重连重试…）');
    r = await run(cmd, text, cwd, { idleMs: 120000, maxMs: 1800000 }, onLine);
    ms += r.ms || 0;
    if (!result) {
      // onLine 漏抓 result 事件 → 兜底再扫一遍全部输出
      for (const line of (r.out || '').split('\n')) { const t = line.trim(); if (t[0] !== '{') continue; let o; try { o = JSON.parse(t); } catch { continue; } if (o.type === 'result') { result = o.result || result; outSid = o.session_id || outSid; if (o.usage) tokens = usageTokens(o.usage) || tokens; if (o.total_cost_usd != null) cost = o.total_cost_usd; } }
    }
    // 只在「空闲卡死且没拿到结果」时重试；撞绝对天花板(max)或已有结果都不重试
    if (r.timeoutReason === 'idle' && !result && attempts < 3) continue;
    break;
  }
  // resume 的会话失效（旧 id / 过期）→ 自动起新会话重试一次，别把报错甩给用户
  if (sessionId && /No conversation found|session.*not found/i.test(result + ' ' + (r.err || ''))) {
    return runClaude(text, cwd, null, persona, onProgress);
  }
  if (!result && !r.ok) {
    result = r.timedOut
      ? `（claude 出错）连接超时，已重试 ${attempts} 次仍无响应——检查下网络/代理`
      : `（claude 出错）${(r.err || '').trim().slice(-300)}`;
  }
  return { text: result || '（没有返回内容）', sessionId: outSid, tokens, cost, ms, attempts, timedOut: !!r.timedOut };
}

// codex 无头：首轮 `codex exec` 建会话并从 thread.started 抓 thread_id；之后 `codex exec resume <id> -` 续上下文（codex 0.139+）。
async function runCodex(text, cwd, persona, sessionId, onProgress) {
  const flagsArr = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  const flags = flagsArr.join(' ');
  // 续话：prompt 走 stdin（结尾 `-`）；会话已含人格/记忆，不再前置。首轮：把人格+记忆前置到消息里（codex 无独立 system-prompt 入口）。
  // Windows 真 argv；POSIX 保持登录 shell 字符串不动
  const cmd = isWin()
    ? (sessionId ? ['codex', 'exec', 'resume', sessionId, ...flagsArr, '-'] : ['codex', 'exec', ...flagsArr])
    : (sessionId ? `codex exec resume ${sessionId} ${flags} -` : `codex exec ${flags}`);
  const stdin = sessionId ? text : (persona ? `${persona}\n\n---\n${text}` : text);
  // 流式：codex 本就吐 JSONL，逐行挑出命令/改文件这类节点播报（最终文本仍走收尾解析）
  const onLine = onProgress ? (line) => {
    const t = line.trim(); if (!t || t[0] !== '{') return;
    let o; try { o = JSON.parse(t); } catch { return; }
    const item = o.item || o.msg || o;
    const ty = (item.type || o.type || '').toLowerCase();
    if (/command|exec|tool|function|patch|file/.test(ty)) { const n = codexNote(item); if (n) onProgress(n); }
  } : null;
  let result = '', outSid = sessionId || '', tokens = 0, r, ms = 0, attempts = 0;
  // 空闲卡死（连接挂起）→ 换新进程=新连接重试，最多 3 次（首次 + 2 重试）
  for (attempts = 1; attempts <= 3; attempts++) {
    result = ''; outSid = sessionId || ''; tokens = 0;
    if (attempts > 1 && onProgress) onProgress('（连接卡住，正在重连重试…）');
    r = await run(cmd, stdin, cwd, { idleMs: 120000, maxMs: 1800000 }, onLine);
    ms += r.ms || 0;
    // --json 输出 JSONL 事件：抓 thread_id + 最终 assistant 文本（后到的覆盖前面）+ 用量（取最大，事件多为累计）
    for (const line of (r.out || '').split('\n')) {
      const t = line.trim(); if (!t || t[0] !== '{') continue;
      let o; try { o = JSON.parse(t); } catch { continue; }
      if (o.type === 'thread.started' && o.thread_id) outSid = o.thread_id;
      const item = o.item || o.msg || o;
      const ty = item.type || o.type || '';
      const u = o.usage || item.usage || (/token|usage/i.test(ty) ? (item || o) : null);
      if (u) { const tk = usageTokens(u); if (tk > tokens) tokens = tk; } // codex 用量事件结构不稳，尽力抓、取最大
      if (/agent_message|assistant|message\.completed|item\.completed/i.test(ty)) {
        const txt = item.text || item.message || (item.content && item.content.text) || '';
        if (txt && typeof txt === 'string') result = txt;
      }
    }
    if (r.timeoutReason === 'idle' && !result && attempts < 3) continue;
    break;
  }
  // resume 的会话失效（旧 id / 落盘被清）→ 自动起新会话重试一次，别把报错甩给用户
  if (sessionId && !result && /No .*session|not found|no conversation|无.*会话/i.test(r.err || r.out || '')) {
    return runCodex(text, cwd, persona, null);
  }
  if (!result) { // 没解出 JSON → 取纯文本最后一段，剥掉 header 前言与 prompt 回显
    const parts = stripAnsi(r.out || '').split(/-{6,}/);
    result = (parts[parts.length - 1] || '').replace(/^\s*user[\s\S]*?\n/i, '').trim();
  }
  if (!result && !r.ok) {
    result = r.timedOut
      ? `（codex 出错）连接超时，已重试 ${attempts} 次仍无响应——检查下网络/代理`
      : `（codex 出错）${stripAnsi(r.err || r.out || '').trim().slice(-300)}`;
  }
  return { text: result || '（没有返回内容）', sessionId: outSid, tokens, cost: 0, ms, attempts, timedOut: !!r.timedOut };
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// POSIX shell 单引号安全包裹（人格可能含引号/换行/中文）。
// Windows 不用它：命令走真 argv 数组，参数不经任何 shell 解析（见 run() / resolveWinCli）
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// 启动时预热终端环境复刻（缓存到 env.js，第一条消息就不必等 shell 起来）
function warmEnv() { fullEnv().catch(() => { /* 失败就退回 process.env，run 时再算 */ }); }

module.exports = { runClaude, runCodex, which, warmEnv };

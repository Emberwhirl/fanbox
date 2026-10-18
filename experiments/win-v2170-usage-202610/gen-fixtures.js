#!/usr/bin/env node
'use strict';
/**
 * Fixture generators for the 2.17.0 Windows acceptance campaign. Used by playwright-electron.js and
 * runnable on their own (any OS):
 *
 *   node gen-fixtures.js claude --home <fake home> [--mb 500] [--seed 1] [--projects 6]
 *       ~/.claude/projects/<munged-cwd>/<session>.jsonl (+ <session>/subagents/agent-*.jsonl), in the
 *       shape lib/agent-tokens.js parses: assistant lines with message.usage, streamed duplicates by
 *       message id, a resumed-session file that repeats ids, and two files older than the 8-day scan
 *       cutoff. Ground truth for the three windows is written to <home>/fixtures-manifest.json.
 *   node gen-fixtures.js codex --home <fake home> [--plan plus]
 *       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl with token_count events and rate_limits snapshots
 *       in the shape server.js codexUsage() reads (no auth.json: the panel falls back to 会话快照).
 *   node gen-fixtures.js burst --dir <dir> [--count 2000] [--seconds 8] [--dirs 8] [--sentinel <file>]
 *       W1/W4 burst writer: <count> small files spread over <seconds>, then the optional sentinel file.
 *   node gen-fixtures.js rewrite --file <file> [--times 100]
 *       W2: rewrite one file with identical content as fast as possible.
 *   node gen-fixtures.js all --home <fake home> [--mb 500]      claude + codex
 *
 * Generation streams big buffered writes (a few MB per write), seeded PRNG, no per-record
 * JSON.stringify: 500 MB takes seconds, not minutes. Nothing outside --home / --dir / --file is touched.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MB = 1024 * 1024;
const DAY = 86400000;
const TS_HOLE = 'TTTTTTTTTTTTTTTTTTTTTTTT'; // 24 chars, same width as an ISO timestamp with ms

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const hex = (rnd, n) => { let s = ''; while (s.length < n) s += Math.floor(rnd() * 16).toString(16); return s; };
const uuid = (rnd) => `${hex(rnd, 8)}-${hex(rnd, 4)}-4${hex(rnd, 3)}-a${hex(rnd, 3)}-${hex(rnd, 12)}`;
const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
const munge = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's folder name for a cwd

// A pool of reusable text bodies (English code-ish prose + some CJK) so records have realistic weight.
function padPool(rnd) {
  const words = ['function', 'return', 'const', 'await', 'import', 'export', 'config', 'render', 'update', 'state',
    'handler', 'request', 'response', 'buffer', 'stream', 'parse', 'token', 'cache', 'window', 'quota', 'terminal', 'watcher'];
  const cjk = '本回合改动文件终端额度窗口重置缓存命中率统计日志快照回滚预览编辑项目目录';
  const pool = [];
  for (let k = 0; k < 48; k++) {
    let s = '';
    const target = 300 + Math.floor(rnd() * 2600);
    while (s.length < target) {
      s += words[Math.floor(rnd() * words.length)] + (rnd() < 0.12 ? '(' + hex(rnd, 4) + ');' : '') + ' ';
      if (rnd() < 0.04) s += cjk.slice(Math.floor(rnd() * 20), 20 + Math.floor(rnd() * 12)) + ' ';
    }
    pool.push(s); // plain words, digits and CJK: no quotes or backslashes, so it drops into JSON as is
  }
  return pool;
}

function localMidnight(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return +d; }

// Keep fixture timestamps away from the window edges, so a few minutes between generation and the
// check cannot move an event across the 5 h / midnight / 7 d boundary and break the ground truth.
function awayFromEdges(t, now) {
  const edges = [now - 5 * 3600000, localMidnight(now), now - 7 * DAY];
  const guard = 20 * 60000;
  for (const e of edges) if (Math.abs(t - e) < guard) t = e + (t >= e ? guard : -guard);
  return t;
}

function windowsOf(events, now) {
  const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, msgs: 0 });
  const res = { last5h: empty(), today: empty(), week: empty() };
  const starts = { last5h: now - 5 * 3600000, today: localMidnight(now), week: now - 7 * DAY };
  for (const e of events) {
    for (const [k, from] of Object.entries(starts)) {
      if (e.t < from || e.t > now) continue;
      const r = res[k];
      r.input += e.input; r.output += e.output; r.cacheRead += e.cacheRead; r.cacheCreate += e.cacheCreate;
      r.total += e.input + e.output + e.cacheRead + e.cacheCreate; r.msgs++;
    }
  }
  return res;
}

function writeManifest(home, patch) {
  const f = path.join(home, 'fixtures-manifest.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first writer */ }
  fs.writeFileSync(f, JSON.stringify(Object.assign(cur, patch), null, 2) + '\n');
  return f;
}

// ---------------------------------------------------------------------------
// (a) Claude Code logs
// ---------------------------------------------------------------------------
function genClaudeTree(opts) {
  const o = Object.assign({ mb: 500, seed: 1, projects: 6, now: Date.now() }, opts);
  if (!o.home) throw new Error('genClaudeTree: home is required');
  const root = path.join(o.claudeDir || path.join(o.home, '.claude'), 'projects');
  const rnd = mulberry32(o.seed);
  const pool = padPool(rnd).map(esc);
  const now = o.now;
  const targetBytes = Math.max(0.2, Number(o.mb)) * MB;
  // ~12 MB per session file, at least 6 files so tiny sizes still exercise several files and projects
  const nFiles = Math.max(6, Math.ceil(targetBytes / (12 * MB)));
  const subBytes = Math.max(40000, targetBytes * 0.03);
  const perFile = (targetBytes - subBytes) / nFiles;
  const projects = [];
  for (let i = 0; i < o.projects; i++) {
    const cwd = path.join(o.home, 'work', 'proj-' + String.fromCharCode(97 + i));
    projects.push({ cwd, dir: path.join(root, munge(cwd)), cwdEsc: esc(cwd) });
    fs.mkdirSync(projects[i].dir, { recursive: true });
  }
  const events = new Map(); // requestId:messageId -> final usage (max per field, like lib/agent-tokens.js)
  let bytes = 0, files = 0, lines = 0, dupLines = 0, oldFiles = 0;
  const written = [];
  const resumeSource = []; // a few records reused by the "resumed session" file

  function makeFile(file, { sessionId, cwdEsc, targetSize, start, end, sidechain, mtime, record = true }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'w');
    let size = 0, buf = [], bufBytes = 0;
    const flush = () => { if (buf.length) { const b = Buffer.from(buf.join(''), 'utf8'); fs.writeSync(fd, b); size += b.length; buf = []; bufBytes = 0; } };
    // Pass 1: build records with a timestamp hole until the size target is reached.
    const recs = []; // { text(with hole), ev (or null) , dup }
    let est = 0;
    let cacheRead = 12000 + Math.floor(rnd() * 20000);
    let parent = uuid(rnd);
    while (est < targetSize) {
      const mid = 'msg_' + hex(rnd, 24), rid = 'req_' + hex(rnd, 24), uid = uuid(rnd);
      const input = 1 + Math.floor(rnd() * 30);
      const cc = rnd() < 0.35 ? 500 + Math.floor(rnd() * 6000) : 0;
      cacheRead = Math.min(190000, cacheRead + Math.floor(rnd() * 4000));
      const out = 30 + Math.floor(rnd() * 3800);
      const pad = pool[Math.floor(rnd() * pool.length)];
      const copies = rnd() < 0.3 ? 2 + Math.floor(rnd() * 2) : 1; // streamed duplicates by message id
      const finals = { input, output: out, cacheRead, cacheCreate: cc };
      for (let c = 0; c < copies; c++) {
        const outNow = c === copies - 1 ? out : 1 + Math.floor(rnd() * Math.max(1, out / 3));
        const line = '{"parentUuid":"' + parent + '","isSidechain":' + (sidechain ? 'true' : 'false') + ',"userType":"external","cwd":"' + cwdEsc
          + '","sessionId":"' + sessionId + '","version":"2.1.0","gitBranch":"main","type":"assistant","message":{"id":"' + mid
          + '","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"' + pad
          + '"}],"stop_reason":null,"usage":{"input_tokens":' + input + ',"cache_creation_input_tokens":' + cc
          + ',"cache_read_input_tokens":' + cacheRead + ',"output_tokens":' + outNow + ',"service_tier":"standard"}},"requestId":"' + rid
          + '","uuid":"' + uid + '","timestamp":"' + TS_HOLE + '"}\n';
        recs.push({ text: line, id: rid + ':' + mid, finals, final: c === copies - 1 });
        est += Buffer.byteLength(line); if (c > 0) dupLines++;
      }
      // a tool-result / user line between turns: no "usage" key, so the parser skips it cheaply
      const user = '{"parentUuid":"' + uid + '","isSidechain":' + (sidechain ? 'true' : 'false') + ',"cwd":"' + cwdEsc + '","sessionId":"' + sessionId
        + '","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_' + hex(rnd, 20) + '","content":"'
        + pool[Math.floor(rnd() * pool.length)] + '"}]},"uuid":"' + uuid(rnd) + '","timestamp":"' + TS_HOLE + '"}\n';
      recs.push({ text: user, id: null });
      est += Buffer.byteLength(user);
      parent = uid;
    }
    // Pass 2: spread timestamps over [start, end], keep them monotonic, fill the holes, write.
    const n = recs.length;
    let last = 0;
    for (let i = 0; i < n; i++) {
      let t = Math.floor(start + (end - start) * (i / Math.max(1, n - 1)));
      t = Math.max(last, awayFromEdges(t, now)); last = t;
      const r = recs[i];
      const iso = new Date(t).toISOString();
      buf.push(r.text.replace(TS_HOLE, iso)); bufBytes += r.text.length; lines++;
      if (r.id && record) {
        const prev = events.get(r.id);
        if (!prev) events.set(r.id, { t, input: r.finals.input, output: r.finals.output, cacheRead: r.finals.cacheRead, cacheCreate: r.finals.cacheCreate });
        // only final copies are reused by the resumed session, so its values equal the originals'
        if (resumeSource.length < 400 && r.final && i % 7 === 0) resumeSource.push(r.text.replace(TS_HOLE, iso));
      }
      if (bufBytes > 4 * MB) flush();
    }
    flush();
    fs.closeSync(fd);
    if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
    bytes += size; files++; written.push(file);
    return size;
  }

  // Session files spread over the last ~6.8 days (never outside the 7-day window except the old ones)
  const spanStart = now - 6.8 * DAY, spanEnd = now - 90 * 1000;
  for (let i = 0; i < nFiles; i++) {
    const p = projects[i % projects.length];
    const sid = uuid(rnd);
    const slice = (spanEnd - spanStart) / nFiles;
    const s = spanStart + slice * i, e = s + slice * (1 + (i % 3) * 0.6);
    makeFile(path.join(p.dir, sid + '.jsonl'), { sessionId: sid, cwdEsc: p.cwdEsc, targetSize: perFile, start: s, end: Math.min(e, spanEnd) });
    // a few subagent files under <session>/subagents/
    if (i < 4) {
      const aid = hex(rnd, 8);
      makeFile(path.join(p.dir, sid, 'subagents', 'agent-' + aid + '.jsonl'), { sessionId: sid, cwdEsc: p.cwdEsc, targetSize: subBytes / 4, start: s, end: Math.min(e, spanEnd), sidechain: true });
    }
  }
  // A resumed session: repeats ids that already exist in another file (the scan must count them once).
  if (resumeSource.length) {
    const p = projects[0], sid = uuid(rnd);
    const f = path.join(p.dir, sid + '.jsonl');
    const text = resumeSource.join('');
    fs.writeFileSync(f, text); bytes += Buffer.byteLength(text); files++; lines += resumeSource.length; written.push(f);
  }
  // Two files older than the scan cutoff (mtime 10 days ago, events 10 days ago): excluded from files + windows.
  for (let k = 0; k < 2; k++) {
    const p = projects[k % projects.length], sid = uuid(rnd);
    const f = path.join(p.dir, sid + '.jsonl');
    const old = now - 10 * DAY;
    const before = bytes;
    makeFile(f, { sessionId: sid, cwdEsc: p.cwdEsc, targetSize: 60000, start: old - 3600000, end: old, mtime: old, record: false });
    bytes = before; files--; oldFiles++; // not part of the scan: do not count it
  }
  const activeFiles = written.length - oldFiles;
  const manifest = {
    generatedAt: now, root, bytes, files: activeFiles, oldFiles, lines, streamedDuplicateLines: dupLines,
    uniqueMessages: events.size, windows: windowsOf([...events.values()], now),
  };
  writeManifest(o.home, { claude: manifest });
  return manifest;
}

// ---------------------------------------------------------------------------
// (b) Codex sessions
// ---------------------------------------------------------------------------
function genCodex(opts) {
  const o = Object.assign({ days: 4, perDay: 2, plan: 'plus', primaryPct: 37, secondaryPct: 62, seed: 2, now: Date.now() }, opts);
  if (!o.home) throw new Error('genCodex: home is required');
  const root = path.join(o.codexDir || path.join(o.home, '.codex'), 'sessions');
  const rnd = mulberry32(o.seed);
  const now = o.now;
  const pad2 = (n) => String(n).padStart(2, '0');
  const events = [];
  let files = 0, newest = null;
  for (let d = o.days - 1; d >= 0; d--) {
    for (let k = 0; k < o.perDay; k++) {
      const start = awayFromEdges(now - d * DAY - (3 + k * 5) * 3600000 - 25 * 60000, now) - (d === 0 ? 40 * 60000 : 0);
      const day = new Date(start);
      const dir = path.join(root, String(day.getFullYear()), pad2(day.getMonth() + 1), pad2(day.getDate()));
      fs.mkdirSync(dir, { recursive: true });
      const sid = uuid(rnd);
      const stamp = day.toISOString().slice(0, 19).replace(/:/g, '-');
      const file = path.join(dir, `rollout-${stamp}-${sid}.jsonl`);
      const cwd = path.join(o.home, 'work', 'codex-proj');
      const lines = [JSON.stringify({ timestamp: new Date(start).toISOString(), type: 'session_meta', payload: { id: sid, timestamp: new Date(start).toISOString(), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0' } })];
      const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
      const turns = 14 + Math.floor(rnd() * 8);
      for (let i = 0; i < turns; i++) {
        const t = awayFromEdges(start + (i + 1) * 90000 + Math.floor(rnd() * 20000), now);
        if (t >= now - 5 * 60000) continue;
        const last = {
          input_tokens: 4000 + Math.floor(rnd() * 30000), cached_input_tokens: 0, output_tokens: 80 + Math.floor(rnd() * 1800), reasoning_output_tokens: 0, total_tokens: 0,
        };
        last.cached_input_tokens = Math.floor(last.input_tokens * (0.4 + rnd() * 0.5));
        last.reasoning_output_tokens = Math.floor(last.output_tokens * rnd() * 0.4);
        last.total_tokens = last.input_tokens + last.output_tokens;
        const before = { ...total };
        for (const key of Object.keys(total)) total[key] += last[key];
        const ev = { timestamp: new Date(t).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 272000 } } };
        lines.push(JSON.stringify(ev));
        // expected contribution of this event (delta of the cumulative total, like lib/agent-tokens.js)
        const dIn = total.input_tokens - before.input_tokens, dCache = total.cached_input_tokens - before.cached_input_tokens, dOut = total.output_tokens - before.output_tokens;
        events.push({ t, input: Math.max(0, dIn - dCache), output: dOut, cacheRead: dCache, cacheCreate: 0 });
      }
      files++; newest = { file, lines, start };
      fs.writeFileSync(file, lines.join('\n') + '\n');
    }
  }
  // The newest session ends with a rate_limits snapshot: 5 h window + weekly window, both in the future.
  const tNew = now - 12 * 60000;
  const rl = {
    primary: { used_percent: o.primaryPct, window_minutes: 300, resets_in_seconds: 2 * 3600, resets_at: Math.floor(now / 1000) + 2 * 3600 },
    secondary: { used_percent: o.secondaryPct, window_minutes: 10080, resets_in_seconds: 3 * 86400, resets_at: Math.floor(now / 1000) + 3 * 86400 },
    plan_type: o.plan, limit_id: 'codex',
  };
  const lastTotal = JSON.parse(newest.lines[newest.lines.length - 1]).payload.info.total_token_usage;
  const snap = { timestamp: new Date(tNew).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: lastTotal, last_token_usage: lastTotal, model_context_window: 272000 }, rate_limits: rl } };
  fs.appendFileSync(newest.file, JSON.stringify(snap) + '\n');
  // the snapshot repeats the cumulative total, so it adds no delta (the parser must not double count it)
  const manifest = { generatedAt: now, root, files, plan: o.plan, rateLimits: { primaryPct: o.primaryPct, secondaryPct: o.secondaryPct }, windows: windowsOf(events, now) };
  writeManifest(o.home, { codex: manifest });
  return manifest;
}

// ---------------------------------------------------------------------------
// (c) Burst writer (W1 / W4) and identical-content rewrites (W2)
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function burstWrite(opts) {
  const o = Object.assign({ count: 2000, seconds: 8, dirs: 8 }, opts);
  if (!o.dir) throw new Error('burstWrite: dir is required');
  const count = Math.max(1, Number(o.count)), seconds = Math.max(0, Number(o.seconds)), nDirs = Math.max(1, Number(o.dirs));
  fs.mkdirSync(o.dir, { recursive: true });
  const subs = [];
  for (let i = 0; i < nDirs; i++) { const d = nDirs === 1 ? o.dir : path.join(o.dir, 'd' + String(i).padStart(2, '0')); fs.mkdirSync(d, { recursive: true }); subs.push(d); }
  const t0 = Date.now();
  const tick = 50; // ms between write slices
  const slices = seconds > 0 ? Math.max(1, Math.round((seconds * 1000) / tick)) : 1;
  const perSlice = Math.ceil(count / slices);
  let written = 0;
  const body = (i) => `burst file ${i}\n` + 'x'.repeat(200) + '\n';
  for (let s = 0; s < slices && written < count; s++) {
    const sliceStart = Date.now();
    for (let k = 0; k < perSlice && written < count; k++, written++) {
      fs.writeFileSync(path.join(subs[written % nDirs], 'burst-' + String(written).padStart(4, '0') + '.txt'), body(written));
    }
    const wait = tick - (Date.now() - sliceStart);
    if (seconds > 0 && wait > 0) await sleep(wait);
  }
  if (o.sentinel) fs.writeFileSync(o.sentinel, 'burst finished ' + new Date().toISOString() + '\n');
  const t1 = Date.now();
  return { count: written, startMs: t0, endMs: t1, elapsedMs: t1 - t0, dir: o.dir, sentinel: o.sentinel || null };
}

function rewriteSame(opts) {
  const o = Object.assign({ times: 100, content: 'identical content, rewritten many times\n' }, opts);
  if (!o.file) throw new Error('rewriteSame: file is required');
  fs.mkdirSync(path.dirname(o.file), { recursive: true });
  const t0 = Date.now();
  for (let i = 0; i < Number(o.times); i++) fs.writeFileSync(o.file, o.content);
  const t1 = Date.now();
  return { times: Number(o.times), startMs: t0, endMs: t1, elapsedMs: t1 - t0, file: o.file };
}

module.exports = { genClaudeTree, genCodex, burstWrite, rewriteSame, windowsOf, parseArgs, mulberry32, munge };

if (require.main === module) {
  (async () => {
    const a = parseArgs(process.argv.slice(2));
    const cmd = a._[0];
    const need = (k) => { if (!a[k] || a[k] === true) { console.error('missing --' + k); process.exit(2); } return String(a[k]); };
    if (cmd === 'claude' || cmd === 'all') {
      const t0 = Date.now();
      const m = genClaudeTree({ home: need('home'), mb: Number(a.mb || 500), seed: Number(a.seed || 1), projects: Number(a.projects || 6) });
      console.log(JSON.stringify({ claude: { files: m.files, mb: +(m.bytes / MB).toFixed(1), uniqueMessages: m.uniqueMessages, week: m.windows.week, seconds: +((Date.now() - t0) / 1000).toFixed(1) } }));
    }
    if (cmd === 'codex' || cmd === 'all') {
      const m = genCodex({ home: need('home'), plan: String(a.plan || 'plus') });
      console.log(JSON.stringify({ codex: { files: m.files, week: m.windows.week, plan: m.plan } }));
    }
    if (cmd === 'burst') {
      console.log(JSON.stringify(await burstWrite({ dir: need('dir'), count: Number(a.count || 2000), seconds: Number(a.seconds === undefined ? 8 : a.seconds), dirs: Number(a.dirs || 8), sentinel: a.sentinel })));
    }
    if (cmd === 'rewrite') {
      console.log(JSON.stringify(rewriteSame({ file: need('file'), times: Number(a.times || 100) })));
    }
    if (!['claude', 'codex', 'all', 'burst', 'rewrite'].includes(cmd)) {
      console.error('usage: node gen-fixtures.js claude|codex|all --home <dir> [--mb 500]\n       node gen-fixtures.js burst --dir <dir> [--count 2000] [--seconds 8] [--dirs 8] [--sentinel <file>]\n       node gen-fixtures.js rewrite --file <file> [--times 100]');
      process.exit(2);
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}

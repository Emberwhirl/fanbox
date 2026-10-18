'use strict';
/**
 * English coverage contract for the v2.17.0 usage panel (plan D4, section 6.6).
 *
 * Runs on Linux with Node only:  node --test experiments/win-v2170-usage-202610/contract-i18n.test.js
 *
 * It loads the shipped public/i18n-dict.js and the shipped public/i18n.js into a vm context set to
 * English (stub window/document/localStorage), so every assertion goes through the real translator
 * (exact keys, trimming, FANBOX_DICT_RULES, the "·" segment split), not through a copy of it.
 *
 * Three layers:
 *   1. The D4 table, exact English.
 *   2. Every composed form the panel can render (sample numbers, errors, stale/expired markers), no CJK left.
 *   3. Source drift guards: the fixed Chinese literals in app.js `usagePanel` and in the quota code of
 *      server.js are extracted and must all translate, so a future upstream merge that adds a string fails here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CJK = /[㐀-鿿＀-￯　-〿]/;

// ---------- the real translator, English mode ----------
function loadTranslator() {
  const sandbox = {
    navigator: { language: 'en-US', platform: 'Linux x86_64', userAgent: 'node-test' },
    localStorage: { getItem: (k) => (k === 'fb_lang' ? 'en' : null), setItem() {} },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: class { observe() {} },
    fetch: () => Promise.resolve(),
    location: { reload() {} },
    console,
  };
  sandbox.document = {
    readyState: 'complete',
    body: { nodeType: 1, closest: () => null, getAttribute: () => null, childNodes: [] },
    documentElement: {},
    getElementById: () => null,
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/i18n-dict.js'), sandbox, { filename: 'i18n-dict.js' });
  vm.runInContext(read('public/i18n.js'), sandbox, { filename: 'i18n.js' });
  assert.equal(sandbox.fanboxLang, 'en', 'i18n.js must come up in English mode');
  assert.equal(typeof sandbox.t, 'function');
  return sandbox;
}
const sb = loadTranslator();
const tr = (s) => sb.t(s);

// ---------- 1. D4 table, exact English ----------
// [Chinese as rendered, English from the user-approved D4 table]
const D4 = [
  // bar labels
  ['周额度', 'Weekly limit'],
  ['5h窗口', '5h window'],
  ['3天窗口', '3-day window'],
  ['额度窗口', 'Limit window'],
  // expired window
  ['周额度：待更新（旧窗口已结束）', 'Weekly limit: Waiting for update (previous window ended)'],
  // stale marker (as the tail of the reset line)
  ['周五 09:00 重置 · 上次成功值', 'Resets Fri 09:00 · last good value'],
  // source line
  ['官方数据 · 2 分钟前', 'Official data · 2 min ago'],
  ['会话快照 · 3 小时前', 'Session snapshot · 3 hr ago'],
  ['CLI实时回传 · 刚刚', 'Live from CLI · just now'],
  // Codex reset credits
  ['重置卡：1张 · 当前适用0张', 'Reset credits: 1 · 0 usable now'],
  ['失效时间、使用记录：接口未提供', 'Expiry and usage history: not provided by the API'],
  ['重置卡信息暂不可用', 'Reset credit info unavailable'],
  // expander
  ['token明细与缓存命中率', 'Token details and cache hit rate'],
  // periods (breakdown headings)
  ['近5h · 110 token', 'Last 5h · 110 token'],
  ['今日 · 12k token', 'Today · 12k token'],
  ['近7天 · 3.4M token', 'Last 7 days · 3.4M token'],
  // breakdown rows
  ['未缓存输入', 'Uncached input'],
  ['缓存读取', 'Cache read'],
  ['缓存写入', 'Cache write'],
  ['输出', 'Output'],
  ['其中推理', 'Reasoning (part of output)'],
  ['输入缓存命中率', 'Input cache hit rate'],
  // reasoning cell
  ['日志未提供', 'Not in logs'],
  ['未提供', 'n/a'],
  ['已记录 12k', 'Recorded 12k'],
  // breakdown notes
  ['仅本机会话日志（含子agent），非账号账单', 'Local session logs only (subagents included), not your account bill'],
  ['部分文件读取失败', 'some files could not be read'],
  // while scanning
  ['正在统计本地token…', 'Counting local tokens…'],
  ['本地token统计暂不可用', 'Local token stats unavailable'],
  // errors
  ['读取失败，稍后重试', "Couldn't load. Try again shortly."],
  ['刷新失败，保留上次数据', 'Refresh failed. Showing the last data.'],
  // quota errors
  ['登录凭证已过期，请在CLI重新登录', 'Login expired. Sign in again in the CLI.'],
  ['未找到有效登录凭证，请在Claude Code重新登录', 'No valid login found. Sign in again in Claude Code.'],
  ['未找到Codex登录凭证，使用本地快照', 'No Codex login found. Using the local snapshot.'],
  ['请求过于频繁，稍后自动重试', 'Too many requests. Retrying automatically.'],
  ['额度接口HTTP 502', 'Quota API HTTP 502'],
  ['额度接口返回格式异常', 'Unexpected response from the quota API'],
  ['额度接口没有返回可识别的窗口', 'The quota API returned no usable window'],
  ['网络连接失败或超时', 'Network connection failed or timed out'],
  // the long cache tip
  ['命中率＝缓存读取÷全部输入。推理包含在输出内，不重复相加。复用稳定的上下文前缀、避免反复粘贴大段内容，有助于利用缓存；具体额度消耗以官方为准。',
    'Hit rate = cache read ÷ all input. Reasoning is counted inside output, not added twice. A stable context prefix and not re-pasting large blocks help the cache. Actual quota use is whatever the vendor reports.'],
];

test('D4 table: exact English wording', () => {
  for (const [zh, en] of D4) assert.equal(tr(zh), en, `D4: ${zh}`);
});

// ---------- 2. every composed form the panel can render ----------
const WINDOW_LABELS = ['周额度', '5h窗口', '1天窗口', '3天窗口', '30天窗口', '1h窗口', '1.5h窗口', '12h窗口', '额度窗口'];
const AGO = ['刚刚', '1 分钟前', '2 分钟前', '59 分钟前', '3 小时前', '23 小时前', '1 天前', '6 天前'];
const RESET = ['09:00 重置', '23:59 重置', '周日 09:00 重置', '周一 00:05 重置', '周五 09:00 重置', '周六 18:30 重置'];

const COMPOSED = [];
const add = (group, s) => COMPOSED.push([group, s]);

for (const l of WINDOW_LABELS) {
  add('bar label', l);
  add('expired window', `${l}：待更新（旧窗口已结束）`);
}
for (const r of RESET) {
  add('reset line', r);
  add('reset line + stale', `${r} · 上次成功值`);
}
add('reset line, no resetsAt, stale', ' · 上次成功值');
add('stale marker alone', '上次成功值');
for (const src of ['官方数据', '会话快照', 'CLI实时回传']) {
  add('source label alone', src);
  for (const a of AGO) add('source line', `${src} · ${a}`);
}
for (const [n, m] of [[0, 0], [1, 0], [2, 1], [10, 10]]) {
  add('reset credits', `重置卡：${n}张 · 当前适用${m}张`);
  add('reset credits + stale', `重置卡：${n}张 · 当前适用${m}张（上次成功值）`);
}
add('reset credits, applicable unknown', '重置卡：2张');
add('reset credits, applicable unknown + stale', '重置卡：2张（上次成功值）');
add('reset credits, unknown', '重置卡信息暂不可用');
add('reset credits note', '失效时间、使用记录：接口未提供');
for (const p of ['近5h', '今日', '近7天']) {
  add('period label (side trio)', p);
  for (const tok of ['0', '110', '12k', '3.4M', '12M', '1.2B']) add('period heading', `${p} · ${tok} token`);
}
add('breakdown note', '仅本机会话日志（含子agent），非账号账单');
add('breakdown note + partial', '仅本机会话日志（含子agent），非账号账单 · 部分文件读取失败');
for (const zh of ['未缓存输入', '缓存读取', '缓存写入', '输出', '其中推理', '输入缓存命中率', '日志未提供', '未提供']) add('breakdown row', zh);
for (const v of ['0', '110', '12k', '3.4M']) add('reasoning recorded', `已记录 ${v}`);
for (const s of ['读取失败，稍后重试', '刷新失败，保留上次数据', '正在统计本地token…', '本地token统计暂不可用', 'token明细与缓存命中率']) add('panel state', s);
for (const e of [
  '登录凭证已过期，请在CLI重新登录', '请求过于频繁，稍后自动重试', '额度接口返回格式异常',
  '未找到有效登录凭证，请在Claude Code重新登录', '额度接口没有返回可识别的窗口',
  '未找到Codex登录凭证，使用本地快照', '网络连接失败或超时',
  '额度接口HTTP 400', '额度接口HTTP 403', '额度接口HTTP 500', '额度接口HTTP 503', '额度接口HTTP 0', '额度接口HTTP NaN',
]) add('quota error', e);

test('composed panel strings: no CJK left in English', () => {
  const left = [];
  for (const [group, s] of COMPOSED) {
    const out = tr(s);
    if (CJK.test(out)) left.push(`[${group}] ${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
  }
  assert.deepEqual(left, []);
});

test('composed strings: selected exact English (rules, split, shadowing)', () => {
  const eq = (zh, en) => assert.equal(tr(zh).trim(), en, zh);
  // window names
  eq('1天窗口', '1-day window');
  eq('30天窗口', '30-day window');
  eq('1.5h窗口', '1.5h window');
  eq('12h窗口', '12h window');
  // expired window keeps the translated label
  eq('5h窗口：待更新（旧窗口已结束）', '5h window: Waiting for update (previous window ended)');
  eq('3天窗口：待更新（旧窗口已结束）', '3-day window: Waiting for update (previous window ended)');
  eq('额度窗口：待更新（旧窗口已结束）', 'Limit window: Waiting for update (previous window ended)');
  // reset line variants, including the leading " · " when resetsAt is missing
  eq('09:00 重置 · 上次成功值', 'Resets 09:00 · last good value');
  eq(' · 上次成功值', 'last good value');
  // source line reuses the relative-time rules
  eq('官方数据 · 刚刚', 'Official data · just now');
  eq('CLI实时回传 · 59 分钟前', 'Live from CLI · 59 min ago');
  eq('会话快照 · 6 天前', 'Session snapshot · 6 days ago');
  // reset credits
  eq('重置卡：2张', 'Reset credits: 2');
  eq('重置卡：1张 · 当前适用1张（上次成功值）', 'Reset credits: 1 · 1 usable now (last good value)');
  eq('重置卡：2张（上次成功值）', 'Reset credits: 2 (last good value)');
  // side trio keeps its existing lowercase labels; the new 7-day label follows the same style
  eq('近5h', 'last 5h');
  eq('今日', 'today');
  eq('近7天', 'last 7 days');
  // breakdown notes (segment split)
  eq('仅本机会话日志（含子agent），非账号账单 · 部分文件读取失败',
    'Local session logs only (subagents included), not your account bill · some files could not be read');
  eq('额度接口HTTP NaN', 'Quota API HTTP NaN');
});

test('new entries do not shadow or break existing translations', () => {
  const eq = (zh, en) => assert.equal(tr(zh), en, zh);
  // relative time and sibling rules the new regexes sit next to
  eq('刚刚', 'just now');
  eq('5 分钟前', '5 min ago');
  eq('3 小时前', '3 hr ago');
  eq('2 天前', '2 days ago');
  eq('7 天', '7d');
  eq('12 文件', '12 files');
  eq('3 项', '3 items');
  eq('读取失败', 'Read failed');
  eq('周配额', 'Weekly quota');
  eq('5h 窗口', '5h window');
  eq('本周', 'this week');
  eq('09:30 重置', 'Resets 09:30');
  eq('周三 09:30 重置', 'Resets Wed 09:30');
  eq('已启用 foo', 'Enabled foo');
  eq('已启动 foo', 'Launched foo');
  eq('已记录 12k', 'Recorded 12k');
  eq('刚刚 · 12 条消息 · 改了 16 个文件', 'just now · 12 messages · changed 16 files');
  eq('2 天前 · 3 条消息', '2 days ago · 3 messages');
  eq('Agent 用量', 'Agent usage');
});

test('attribute-style strings (title=) translate the same way', () => {
  // the reasoning cell's title is "日志未提供" or Number.toLocaleString() (no CJK, left alone)
  assert.equal(tr('日志未提供'), 'Not in logs');
  assert.equal(tr('1,234,567'), '1,234,567');
});

// ---------- 3. source drift guards ----------
function between(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `marker not found: ${from}`);
  const b = src.indexOf(to, a);
  assert.ok(b > a, `end marker not found: ${to}`);
  return src.slice(a, b);
}
// quoted '...' literals that contain CJK, skipping whole-line comments
function cjkLiterals(code) {
  const out = new Set();
  for (const raw of code.split('\n')) {
    const line = raw.replace(/\x00/g, '');
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    for (const m of line.matchAll(/'([^'\n]*)'/g)) {
      const text = m[1].replace(/<[^>]+>/g, ''); // '<div class="usage-sub">读取失败…</div>' -> the text node
      if (CJK.test(text)) out.add(text);
    }
  }
  return [...out];
}

// Fragments that only exist concatenated (the translator sees the joined text, not the fragment).
// Each is covered by a composed case above; they are listed so a NEW fragment still fails the guard.
const FRAGMENT_ONLY = new Map([
  ['周', 'fmtReset: "周" + 日一二三四五六[day] + " " + hm + " 重置"; covered by the 周X HH:MM 重置 rule'],
  ['日一二三四五六', 'fmtReset weekday letters'],
  [' 重置', 'fmtReset tail'],
  [' 分钟前', 'ago(): N + " 分钟前"; covered by the relative-time rule'],
  [' 小时前', 'ago(): N + " 小时前"'],
  [' 天前', 'ago(): N + " 天前"'],
  [' · 上次成功值', 'limit(): reset text + " · 上次成功值"; covered by the segment split'],
  [' · 部分文件读取失败', 'tokens(): note + " · 部分文件读取失败"; covered by the segment split'],
  ['（上次成功值）', 'reset credits tail: "重置卡：1张（上次成功值）"; covered by the 重置卡 rule'],
  ['已记录 ', 'reasoningPartial prefix: "已记录 " + 12k; covered by the 已记录 rule'],
]);

test('app.js usagePanel: every fixed Chinese literal translates (or is a known fragment)', () => {
  const app = read('public/app.js');
  const panel = between(app, 'const usagePanel = {', '  open() { return localStorage.getItem');
  const lits = cjkLiterals(panel);
  assert.ok(lits.length >= 20, `expected at least 20 CJK literals in usagePanel, got ${lits.length}`);
  const missing = [];
  for (const lit of lits) {
    if (FRAGMENT_ONLY.has(lit)) continue;
    const out = tr(lit);
    if (CJK.test(out)) missing.push(`${JSON.stringify(lit)} -> ${JSON.stringify(out)}`);
  }
  assert.deepEqual(missing, [], 'untranslated usagePanel literals');
});

test('app.js usagePanel: template literals still have the shapes the rules expect', () => {
  const app = read('public/app.js').replace(/\x00/g, '');
  const panel = between(app, 'const usagePanel = {', '  open() { return localStorage.getItem');
  const shapes = [
    '`${Math.round(m / 1440)}天窗口`',
    '`${m / 60}h窗口`',
    '`<div class="usage-sub">${label}：待更新（旧窗口已结束）</div>`',
    "' · 上次成功值'",
    '<summary>token明细与缓存命中率</summary>',
    '${label} · ${this.fmtTok(b.total)} token</b>',
    "重置卡：${c.resets.available}张${c.resets.applicable == null ? '' : ` · 当前适用${c.resets.applicable}张`}${c.stale ? '（上次成功值）' : ''}<br>失效时间、使用记录：接口未提供",
    "c.source === 'official' ? '官方数据' : '会话快照'} · ${this.ago(c.capturedAt)}",
    "o.source === 'statusline' ? 'CLI实时回传' : '官方数据'} · ${this.ago(o.capturedAt)}",
    "(name === '其中推理' && b.reasoningPartial ? '已记录 ' : '') + this.fmtTok(value || 0)",
    "${c.partial ? ' · 部分文件读取失败' : ''}",
    '${escapeHtml(c.error)}',
    '${escapeHtml(o.error)}',
  ];
  for (const s of shapes) assert.ok(panel.includes(s), `usagePanel source no longer contains: ${s}`);
});

test('server.js quota code: every Chinese message translates; 统计失败 never reaches the panel', () => {
  const srv = read('server.js').replace(/\x00/g, '');
  const code = between(srv, '// 凭证只经 stdin 传 curl', '// ---------- Agent 项目');
  // template with a status code
  assert.ok(code.includes('`额度接口HTTP ${status}`'), 'status-code template changed');
  const lits = cjkLiterals(code);
  assert.ok(lits.length >= 7, `expected at least 7 CJK literals in the quota code, got ${lits.length}`);
  const missing = [];
  for (const lit of lits) {
    const out = tr(lit);
    if (CJK.test(out)) missing.push(`${JSON.stringify(lit)} -> ${JSON.stringify(out)}`);
  }
  assert.deepEqual(missing, [], 'untranslated quota messages');
  // official.error / codex.error are rendered through escapeHtml(...error) only; the token-scan failure
  // message 统计失败 is created in localTokenUsage() and swallowed by .catch(() => {}) in agentUsage()
  assert.ok(srv.includes("reject(new Error('统计失败'))"));
  assert.ok(srv.includes('localTokenUsage().catch(() => {});'), '统计失败 would now reach the response; add a dictionary entry');
  assert.equal(srv.split('localTokenUsage()').length - 1, 2, 'a new caller of localTokenUsage() may surface 统计失败');
});

test('dictionary hygiene: new keys are unique, every rule is anchored', () => {
  const src = read('public/i18n-dict.js');
  const dictBody = between(src, 'window.FANBOX_DICT = {', 'window.FANBOX_DICT_RULES');
  const count = new Map();
  for (const m of dictBody.matchAll(/^  '((?:[^'\\]|\\.)*)':/gm)) count.set(m[1], (count.get(m[1]) || 0) + 1);
  // keys added for 2.17.0 sit in their own block; a duplicate elsewhere would silently win or lose
  const block = between(dictBody, '// 2.17.0 用量面板重写', '// ---------- Skills 透视');
  const mine = [...block.matchAll(/^  '((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]);
  assert.ok(mine.length >= 28, `expected the 2.17.0 block to hold at least 28 keys, got ${mine.length}`);
  assert.deepEqual(mine.filter((k) => count.get(k) > 1), [], 'a 2.17.0 key is defined twice in FANBOX_DICT');
  for (const [re] of sb.FANBOX_DICT_RULES) {
    if (Object.prototype.toString.call(re) !== '[object RegExp]') continue; // a few legacy rules are plain string pairs
    assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `rule not fully anchored: ${re}`);
  }
});

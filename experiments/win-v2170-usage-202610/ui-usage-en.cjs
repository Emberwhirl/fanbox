'use strict';
/**
 * English-mode check of the v2.17.0 usage panel in a real browser (plan D4 / 6.6).
 * Modeled on upstream's tests/ui-usage.cjs, but with localStorage.fb_lang = 'en': it renders the panel
 * through the real usagePanel.render() with fixtures for every state, expands both token expanders, and
 * asserts that #usage-body (visible text, full textContent, and every title/placeholder attribute)
 * contains no CJK character, plus the expected English in each state.
 *
 * Run (web server first, any fake HOME):
 *   FANBOX_NO_OPEN=1 FANBOX_PORT=4579 HOME=<fake home> node server.js
 *   NODE_PATH=<dir>/node_modules [PW_CHROMIUM=<chrome binary>] [FANBOX_UI_URL=http://localhost:4579] \
 *     node experiments/win-v2170-usage-202610/ui-usage-en.cjs
 *
 *   FANBOX_UI_URL        default http://localhost:4579
 *   PW_CHROMIUM          executablePath for the browser; without it Playwright's `chrome` channel is used (as upstream)
 *   PW_CHROMIUM_ARGS     optional extra browser flags, space separated (on a headless Linux box without a GPU, requestAnimationFrame
 *                        never fires and Playwright clicks/screenshots hang unless you pass --disable-software-rasterizer)
 *   FANBOX_UI_VERBOSE    set to 1 to print the visible text of every state
 *   FANBOX_UI_ARTIFACTS  optional directory; when set, a sidebar screenshot is saved per state
 */
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const URL = process.env.FANBOX_UI_URL || 'http://localhost:4579';
const CJK = /[㐀-鿿＀-￯　-〿]/;
const ART = process.env.FANBOX_UI_ARTIFACTS || '';
if (ART) fs.mkdirSync(ART, { recursive: true });

const now = Date.now();
const sec = (msFromNow) => Math.floor((now + msFromNow) / 1000);
const bucket = { input: 20, output: 10, cacheRead: 80, cacheCreate: 0, reasoning: 3, total: 110 };
const tokens = { last5h: bucket, today: bucket, week: bucket };

// [state name, payload for usagePanel.render (or the string 'null'/'reset-null'), English that must appear]
const STATES = [
  // --- upstream's own fixtures (tests/ui-usage.cjs) ---
  ['upstream: Pro weekly, official, Claude 429 stale', { ok: true,
    codex: { ...tokens, planType: 'pro', source: 'official', capturedAt: now, primary: { usedPercent: 87, windowMinutes: 10080 }, resets: { available: 1, applicable: 0 } },
    claude: { ...tokens, official: { error: '额度接口HTTP 429', stale: true } } },
  ['Weekly limit', 'Official data · just now', 'Reset credits: 1 · 0 usable now', 'Expiry and usage history: not provided by the API',
    'Token details and cache hit rate', 'Quota API HTTP 429', 'Input cache hit rate', 'Cache read', 'Uncached input', 'Cache write', 'Output',
    'Reasoning (part of output)', 'Last 5h · 110 token', 'Today · 110 token', 'Last 7 days · 110 token',
    'Local session logs only (subagents included), not your account bill',
    'Hit rate = cache read ÷ all input. Reasoning is counted inside output, not added twice.', 'last 5h', 'today', 'last 7 days']],
  ['upstream: Plus dual windows, snapshot, weekly expired', { ok: true,
    codex: { planType: 'plus', source: 'snapshot', capturedAt: now, primary: { usedPercent: 50, windowMinutes: 300 },
      secondary: { usedPercent: 90, windowMinutes: 10080, stale: true }, today: bucket, last5h: bucket, week: bucket } },
  ['5h window', 'Weekly limit: Waiting for update (previous window ended)', 'Session snapshot · just now', 'Reset credit info unavailable']],
  ['upstream: refresh failed keeps last data', 'null', ['Refresh failed. Showing the last data.', '5h window']],

  // --- states the upstream test does not cover ---
  ['initial load failed (empty panel)', 'reset-null', ["Couldn't load. Try again shortly."]],
  ['empty: no Claude, no Codex', { ok: true }, []],
  ['Pro: official data + CLI live, future resets', { ok: true,
    codex: { ...tokens, planType: 'pro', source: 'official', capturedAt: now - 30000, stale: false,
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: sec(3600e3) }, secondary: { usedPercent: 91, windowMinutes: 10080, resetsAt: sec(3 * 86400e3) },
      resets: { available: 2, applicable: 1 } },
    claude: { ...tokens, official: { fiveHour: { usedPercent: 23, resetsAt: sec(2 * 3600e3) }, sevenDay: { usedPercent: 41, resetsAt: sec(4 * 86400e3) },
      capturedAt: now - 90000, source: 'statusline', stale: false, error: null } } },
  ['Resets', 'Weekly limit', '5h window', 'Live from CLI · 2 min ago', 'Reset credits: 2 · 1 usable now', 'Official data · just now']],
  ['Claude official API (not CLI) source, 3 h old', { ok: true,
    claude: { ...tokens, official: { fiveHour: { usedPercent: 10, resetsAt: sec(3600e3) }, sevenDay: { usedPercent: 20, resetsAt: sec(86400e3) }, capturedAt: now - 3 * 3600e3, stale: false, error: null } } },
  ['Official data · 3 hr ago']],
  ['stale last-good values + error (Claude and Codex)', { ok: true,
    codex: { ...tokens, planType: 'pro', source: 'official', capturedAt: now - 20 * 60e3, stale: true, error: '网络连接失败或超时',
      primary: { usedPercent: 60, windowMinutes: 300, resetsAt: sec(3600e3) }, secondary: { usedPercent: 70, windowMinutes: 10080, resetsAt: sec(2 * 86400e3) },
      resets: { available: 2, applicable: 1 } },
    claude: { ...tokens, official: { fiveHour: { usedPercent: 12, resetsAt: sec(3600e3) }, sevenDay: { usedPercent: 34, resetsAt: sec(2 * 86400e3) },
      capturedAt: now - 3 * 3600e3, stale: true, error: '请求过于频繁，稍后自动重试' } } },
  ['last good value', 'Network connection failed or timed out', 'Too many requests. Retrying automatically.',
    'Reset credits: 2 · 1 usable now (last good value)', 'Official data · 20 min ago', 'Official data · 3 hr ago']],
  ['stale last-good values, no resetsAt', { ok: true,
    claude: { ...tokens, official: { fiveHour: { usedPercent: 12, resetsAt: 0 }, capturedAt: now - 5 * 86400e3, stale: true, error: '额度接口返回格式异常' } } },
  ['last good value', 'Unexpected response from the quota API', 'Official data · 5 days ago']],
  ['both windows expired', { ok: true,
    codex: { ...tokens, planType: 'pro', source: 'official', capturedAt: now,
      primary: { usedPercent: 40, windowMinutes: 300, resetsAt: sec(-3600e3) }, secondary: { usedPercent: 70, windowMinutes: 10080, resetsAt: sec(-86400e3) } },
    claude: { ...tokens, official: { fiveHour: { usedPercent: 5, resetsAt: sec(-60e3) }, sevenDay: { usedPercent: 6, resetsAt: sec(-60e3) }, capturedAt: now, source: 'statusline' } } },
  ['5h window: Waiting for update (previous window ended)', 'Weekly limit: Waiting for update (previous window ended)']],
  ['other window names (3-day, 1.5h)', { ok: true,
    codex: { ...tokens, planType: 'team', source: 'official', capturedAt: now,
      primary: { usedPercent: 40, windowMinutes: 4320, resetsAt: sec(86400e3) }, secondary: { usedPercent: 70, windowMinutes: 90, resetsAt: sec(3600e3) } } },
  ['3-day window', '1.5h window']],
  ['other window names (30-day, unknown, expired unknown)', { ok: true,
    codex: { ...tokens, planType: 'team', source: 'official', capturedAt: now,
      primary: { usedPercent: 40, windowMinutes: 43200, resetsAt: sec(86400e3) }, secondary: { usedPercent: 70, resetsAt: sec(-1000) } } },
  ['30-day window', 'Limit window: Waiting for update (previous window ended)']],
  ['Codex snapshot fallback with login error', { ok: true,
    codex: { planType: 'plus', source: 'snapshot', capturedAt: now - 2 * 3600e3, error: '未找到Codex登录凭证，使用本地快照',
      primary: { usedPercent: 33, windowMinutes: 300, resetsAt: sec(3600e3) }, ...tokens } },
  ['No Codex login found. Using the local snapshot.', 'Session snapshot · 2 hr ago', 'Reset credit info unavailable']],
  ['Codex error without any snapshot', { ok: true,
    codex: { error: '登录凭证已过期，请在CLI重新登录', source: 'snapshot' } },
  ['Login expired. Sign in again in the CLI.', 'Reset credit info unavailable', 'Local token stats unavailable']],
  ['Claude: no credentials', { ok: true,
    claude: { ...tokens, official: { stale: true, error: '未找到有效登录凭证，请在Claude Code重新登录' } } },
  ['No valid login found. Sign in again in Claude Code.']],
  ['Claude: quota API found no window', { ok: true,
    claude: { ...tokens, official: { stale: true, error: '额度接口没有返回可识别的窗口' } } },
  ['The quota API returned no usable window']],
  ['Claude: HTTP status variants', { ok: true,
    codex: { error: '额度接口HTTP 503', source: 'snapshot' },
    claude: { ...tokens, official: { stale: true, error: '额度接口HTTP 0' } } },
  ['Quota API HTTP 503', 'Quota API HTTP 0']],
  ['tokens still counting', { ok: true, tokensPending: true,
    codex: { planType: 'pro', source: 'official', capturedAt: now, primary: { usedPercent: 10, windowMinutes: 300, resetsAt: sec(3600e3) } },
    claude: { official: { fiveHour: { usedPercent: 10, resetsAt: sec(3600e3) }, capturedAt: now, source: 'statusline' } } },
  ['Counting local tokens…']],
  ['token stats unavailable', { ok: true,
    codex: { planType: 'pro', source: 'official', capturedAt: now, primary: { usedPercent: 10, windowMinutes: 300, resetsAt: sec(3600e3) } },
    claude: { official: { fiveHour: { usedPercent: 10, resetsAt: sec(3600e3) }, capturedAt: now, source: 'statusline' } } },
  ['Local token stats unavailable']],
  ['token breakdown: partial files, reasoning not logged / partial, zero input', { ok: true,
    codex: { planType: 'pro', source: 'official', capturedAt: now, primary: { usedPercent: 10, windowMinutes: 300, resetsAt: sec(3600e3) }, partial: true,
      last5h: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0, total: 0, reasoningAvailable: false },
      today: { ...bucket, reasoningAvailable: false },
      week: { ...bucket, reasoningPartial: true, total: 3400000, input: 1200000, cacheRead: 2000000, output: 200000, reasoning: 90000 } },
    claude: { ...tokens, partial: true, official: { fiveHour: { usedPercent: 10, resetsAt: sec(3600e3) }, capturedAt: now, source: 'statusline' } } },
  ['some files could not be read', 'n/a', 'Recorded 90k', 'Last 7 days · 3.4M token']],
];

(async () => {
  const launchOpts = { headless: true, args: (process.env.PW_CHROMIUM_ARGS || '').split(' ').filter(Boolean) };
  if (process.env.PW_CHROMIUM) launchOpts.executablePath = process.env.PW_CHROMIUM; else launchOpts.channel = 'chrome';
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('fb_lang', 'en'); localStorage.setItem('fb_guided', '1');
    localStorage.setItem('fb_usage_open', '1'); localStorage.setItem('fb_theme', 'warm');
  });
  // the page's own first poll gets the upstream fixture; later states are driven through usagePanel.render()
  await page.route('**/api/agent-usage', (route) => route.fulfill({ json: STATES[0][1] }));
  await page.goto(URL); await page.waitForLoadState('networkidle');
  const panel = page.locator('#usage-body');
  assert.equal(await page.evaluate(() => window.fanboxLang), 'en', 'page must be in English mode');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await page.waitForSelector('#usage-body .usage-agent');
  await page.evaluate(() => { clearInterval(usagePanel.timer); clearTimeout(usagePanel.pendingTimer); usagePanel.timer = null; });

  let failures = 0; let n = 0;
  const report = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

  // CJK in visible text, full textContent (closed expanders too) and any attribute that can carry UI text
  const snapshot = () => page.evaluate(() => {
    const box = document.getElementById('usage-body');
    const attrs = [];
    box.querySelectorAll('*').forEach((el) => { for (const a of ['title', 'placeholder', 'aria-label']) if (el.getAttribute(a)) attrs.push(`${a}=${el.getAttribute(a)}`); });
    return { visible: box.innerText, full: box.textContent, attrs, overflow: box.scrollWidth > box.clientWidth, details: box.querySelectorAll('.usage-detail').length };
  });
  const expandAll = async () => {
    // real clicks on the summaries (as upstream's test does), then wait for the toggle + translation
    for (const agent of ['codex', 'claude']) {
      const det = page.locator(`#usage-body .usage-detail[data-agent="${agent}"]`);
      if (await det.count() && (await det.getAttribute('open')) === null) await det.locator('summary').click();
    }
    await page.waitForTimeout(60);
  };

  for (const [name, payload, expectEn] of STATES) {
    n++;
    if (payload === 'reset-null') await page.evaluate(() => { document.getElementById('usage-body').innerHTML = ''; usagePanel.expanded = new Set(); usagePanel.render(null); });
    else if (payload === 'null') await page.evaluate(() => usagePanel.render(null));
    else await page.evaluate((d) => { usagePanel.expanded = new Set(); usagePanel.render(d); }, payload);
    await page.waitForTimeout(60);
    const before = await snapshot();
    await expandAll();
    const s = await snapshot();
    const hay = s.visible.replace(/\s+/g, ' ');
    const cjkLeft = [s.visible, s.full, ...s.attrs, before.full].filter((t) => CJK.test(t));
    const cjkDetail = cjkLeft.length ? cjkLeft.map((t) => (t.match(/[^\n]*[㐀-鿿＀-￯　-〿][^\n]*/) || [''])[0].trim()).join(' | ') : '';
    const missing = expectEn.filter((e) => !hay.includes(e));
    if (process.env.FANBOX_UI_VERBOSE) console.log(`----- [${n}] ${name}\n${s.visible}\n`);
    report(!cjkLeft.length, `[${n}] ${name}: no CJK in #usage-body${cjkDetail ? '  <- ' + cjkDetail : ''}`);
    report(!missing.length, `[${n}] ${name}: expected English present${missing.length ? '  <- missing: ' + JSON.stringify(missing) + ' in ' + JSON.stringify(hay.slice(0, 400)) : ''}`);
    report(!s.overflow, `[${n}] ${name}: no horizontal overflow`);
    if (typeof payload === 'object' && (payload.codex || payload.claude)) {
      const opened = await page.evaluate(() => [...document.querySelectorAll('#usage-body .usage-detail')].every((d) => d.open));
      report(opened, `[${n}] ${name}: ${s.details} token expander(s), all open`);
    }
    if (ART) await page.locator('#sidebar').screenshot({ path: path.join(ART, `usage-en-${String(n).padStart(2, '0')}.png`) });
  }

  // expanders remember their state across a re-render (upstream behavior), and stay English
  await page.evaluate((d) => { usagePanel.expanded = new Set(); usagePanel.render(d); }, STATES[0][1]);
  await page.waitForTimeout(40);
  await page.locator('.usage-detail[data-agent="codex"] summary').click();
  await page.waitForTimeout(100); // the toggle event that records the open state is queued as a task
  await page.evaluate((d) => usagePanel.render(d), STATES[0][1]);
  await page.waitForTimeout(60);
  report(await page.locator('.usage-detail[data-agent="codex"]').getAttribute('open') === '', 'expander stays open across a refresh');
  report(!CJK.test((await snapshot()).full), 'still no CJK after the re-render');

  // the "zh" counterpart sanity: the same render in Chinese must keep the Chinese source strings (guards against a stuck English mode)
  const pageZh = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await pageZh.addInitScript(() => { localStorage.setItem('fb_lang', 'zh'); localStorage.setItem('fb_guided', '1'); localStorage.setItem('fb_usage_open', '1'); });
  await pageZh.route('**/api/agent-usage', (route) => route.fulfill({ json: STATES[0][1] }));
  await pageZh.goto(URL); await pageZh.waitForSelector('#usage-body .usage-agent');
  const zhText = await pageZh.locator('#usage-body').innerText();
  report(/周额度/.test(zhText) && /官方数据/.test(zhText) && /额度接口HTTP 429/.test(zhText), 'Chinese mode keeps the Chinese source text (control)');

  report(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  if (failures) { console.error(`\nFAILED: ${failures} check(s)`); process.exitCode = 1; }
  else console.log(`\nUI EN checks passed: ${n} usage-panel states, no CJK in visible text, textContent or attributes`);
})().catch((e) => { console.error(e); process.exitCode = 1; });

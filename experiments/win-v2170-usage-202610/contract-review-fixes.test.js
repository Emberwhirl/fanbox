'use strict';

// Targeted review regression: Windows must preserve user-provided names while
// the token-breakdown label remains translatable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { /* optional browser check; set NODE_PATH to enable */ }

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('real DOM: Windows keeps a filename 输出 while UI labels and bridge fallback translate', async (t) => {
  if (!chromium) { t.skip('playwright-core is unavailable; set NODE_PATH to its node_modules directory'); return; }
  const launchOpts = { headless: true };
  if (process.env.PW_CHROMIUM) launchOpts.executablePath = process.env.PW_CHROMIUM;
  else launchOpts.channel = 'chrome';
  let browser;
  let server;
  try {
    try {
      browser = await chromium.launch(launchOpts);
    } catch (e) {
      // Mirror the playwright-core skip: without PW_CHROMIUM this wants the Chrome channel, which
      // the host may simply not have. A bad PW_CHROMIUM path (or a real launch failure on an
      // installed browser) is not a skip: it rethrows.
      const msg = String(e && e.message || e);
      const missingChrome = /executable doesn't exist|is not found|distribution/i.test(msg);
      if (process.env.PW_CHROMIUM || !missingChrome) throw e;
      t.skip('Google Chrome (launch channel "chrome") is not installed and PW_CHROMIUM is not set; set PW_CHROMIUM to a Chromium/Chrome executable to run the DOM check (' + msg.split('\n')[0] + ')');
      return;
    }
    const page = await browser.newPage();
    const dict = read('public/i18n-dict.js');
    const i18n = read('public/i18n.js');
    const html = (platform, marker) => `<!doctype html><body>
      <span id="filename"${marker ? ' data-fanbox-user-content' : ''} title="输出">输出</span>
      <span id="usage">输出</span>
      <span class="label" id="side-label" title="E:/work/输出&#10;claude + codex · 3 时前活跃"><span${marker ? ' data-fanbox-user-content' : ''}>输出</span></span>
      <span id="fallback">CLI实时回传未启用：Git Bash 未找到；仍会尝试官方数据和本地会话日志</span>
      <script>window.fanboxEnv={platform:${JSON.stringify(platform)}};localStorage.setItem('fb_lang','en');</script>
      <script>${dict}</script><script>${i18n}</script>`;
    let pageHtml = html('win32', true);
    server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(pageHtml); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    assert.deepEqual(await page.evaluate(() => ({
      filename: document.querySelector('#filename').textContent,
      filenameTitle: document.querySelector('#filename').title,
      usage: document.querySelector('#usage').textContent,
      fallback: document.querySelector('#fallback').textContent,
      // sidebar semantics (navDirLi): the filename sits in an inner marked span while the parent
      // .label keeps a translatable title tooltip — the ATTRS path must still translate it.
      sideName: document.querySelector('#side-label span').textContent,
      sideTitle: document.querySelector('#side-label').title,
      sideParentMarked: document.querySelector('#side-label').hasAttribute('data-fanbox-user-content'),
    })), {
      filename: '输出',
      filenameTitle: '输出',
      usage: 'Output',
      fallback: 'Live CLI updates are off: Git Bash was not found. FanBox will still try official data and local session logs.',
      sideName: '输出',
      sideTitle: 'E:/work/输出\nclaude + codex · active 3h ago',
      sideParentMarked: false,
    });
    pageHtml = html('linux', false);
    await page.goto(url);
    assert.equal(await page.locator('#filename').textContent(), 'Output', 'the untouched POSIX DOM retains existing global translation behavior');
    assert.deepEqual(await page.evaluate(() => ({
      sideName: document.querySelector('#side-label span').textContent,
      sideTitle: document.querySelector('#side-label').title,
    })), {
      sideName: 'Output',
      sideTitle: 'E:/work/输出\nclaude + codex · active 3h ago',
    }, 'the untouched POSIX sidebar translates both the name and the tooltip');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (browser) await browser.close();
  }
});

test('status-line readiness becomes true only after all Windows hook files are written', () => {
  const main = read('electron/main.js');
  const start = main.indexOf('function writeHookFiles()');
  const end = main.indexOf('// async：hook', start);
  const win = main.slice(start, end);
  const at = (text) => { const i = win.indexOf(text); assert.ok(i >= 0, text); return i; };
  assert.ok(at("if (IS_WIN) winStatusLineBridge = { ready: false, reason: '状态栏桥准备失败' };") < at('fs.mkdirSync(dir'), 'mkdir failures have an explicit Windows state');
  assert.ok(at("fs.writeFileSync(path.join(dir, 'claude-settings.json')") < at("if (statusLine) winStatusLineBridge = { ready: true, reason: null };"), 'settings installation precedes ready');
  assert.ok(at("fs.writeFileSync(path.join(dir, 'codex-notify.js')") < at("if (statusLine) winStatusLineBridge = { ready: true, reason: null };"), 'Codex hook installation precedes ready');
  assert.match(main, /catch \(e\) \{ if \(IS_WIN\) winStatusLineBridge = \{ ready: false, reason: '状态栏桥准备失败' \}/, 'outer write failures reset Windows readiness');
});

test('real DOM: markRoundSelNames marks only the filename segment on Windows, leaves options untouched on POSIX', async (t) => {
  if (!chromium) { t.skip('playwright-core is unavailable; set NODE_PATH to its node_modules directory'); return; }
  const launchOpts = { headless: true };
  if (process.env.PW_CHROMIUM) launchOpts.executablePath = process.env.PW_CHROMIUM;
  else launchOpts.channel = 'chrome';
  let browser;
  try {
    try {
      browser = await chromium.launch(launchOpts);
    } catch (e) {
      // same skip contract as the DOM test above: a missing Chrome channel is a skip, anything else rethrows
      const msg = String(e && e.message || e);
      const missingChrome = /executable doesn't exist|is not found|distribution/i.test(msg);
      if (process.env.PW_CHROMIUM || !missingChrome) throw e;
      t.skip('Google Chrome (launch channel "chrome") is not installed and PW_CHROMIUM is not set; set PW_CHROMIUM to a Chromium/Chrome executable to run the DOM check (' + msg.split('\n')[0] + ')');
      return;
    }
    const page = await browser.newPage();
    // shipped source, cut between marker strings the way the readiness check above cuts electron/main.js
    const app = read('public/app.js');
    const at = (text) => { const i = app.indexOf(text); assert.ok(i >= 0, text); return i; };
    const markUserTextSrc = app.slice(at('function markUserText('), at('\nfunction markRoundSelNames('));
    const markRoundSelNamesSrc = app.slice(at('function markRoundSelNames('), at('\nfunction edStr('));
    assert.match(markUserTextSrc, /dataset\.fanboxUserContent/, 'markUserText is the shipped marker emitter');
    assert.match(markRoundSelNamesSrc, /lastIndexOf\(lab\)/, 'markRoundSelNames is the shipped rewrap');
    // option shape from the app's round-sel render: '<clock> · <label>' with 回合 · <name> labels
    const snaps = [{ label: '回合 · 输出' }, { label: "回合 · o'brien" }, { label: 'plan.md' }, { label: '回合 · 不在文本里' }];
    const opts = [
      { value: '0', text: '当前回合 · 17:30 · 回合 · 输出', name: '输出', prefix: '当前回合 · 17:30 · 回合 · ' },
      { value: '1', text: "12:04 · 回合 · o'brien", name: "o'brien", prefix: '12:04 · 回合 · ' },
      { value: '2', text: '09:00 · plan.md', name: 'plan.md', prefix: '09:00 · ' },
      { value: '3', text: '昨天的回合 · 别的名字', name: null, prefix: '' },
      { value: '9', text: '没有存档 · 未映射', name: null, prefix: '' },
    ];
    const got = await page.evaluate(([muSrc, mrsSrc, snaps, opts]) => {
      const build = (winMode) => {
        const isWindows = () => winMode;
        const markUserText = new Function('isWindows', muSrc + '\nreturn markUserText;')(isWindows);
        const markRoundSelNames = new Function('isWindows', 'markUserText', mrsSrc + '\nreturn markRoundSelNames;')(isWindows, markUserText);
        const sel = document.createElement('select');
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.text;
          sel.append(opt);
        }
        document.body.append(sel);
        markRoundSelNames(sel, snaps);
        const out = [...sel.options].map((opt) => ({
          text: opt.textContent,
          kids: [...opt.children].map((c) => ({ tag: c.tagName, marked: c.hasAttribute('data-fanbox-user-content'), text: c.textContent })),
          before: opt.children.length ? opt.textContent.slice(0, opt.textContent.length - opt.children[0].textContent.length) : '',
        }));
        sel.remove();
        return out;
      };
      return { win: build(true), posix: build(false) };
    }, [markUserTextSrc, markRoundSelNamesSrc, snaps, opts]);
    // Windows mode: the exact option text is preserved and only the name segment is wrapped and
    // marked — the 回合 · prefix stays outside the marker so i18n still translates it.
    assert.deepEqual(got.win.map((o) => o.text), opts.map((o) => o.text), 'markRoundSelNames preserves the exact option text');
    opts.forEach((o, i) => {
      const kids = got.win[i].kids;
      if (!o.name) { assert.equal(kids.length, 0, 'option ' + i + ' (' + o.text + ') is left untouched'); return; }
      assert.equal(kids.length, 1, 'option ' + i + ' has exactly one wrapped segment');
      assert.equal(kids[0].tag, 'SPAN', 'option ' + i + ' wraps the name in a span');
      assert.equal(kids[0].marked, true, 'option ' + i + ' marks only the filename segment as user content');
      assert.equal(kids[0].text, o.name, 'option ' + i + ' wraps exactly the filename');
      assert.equal(got.win[i].before, o.prefix, 'option ' + i + ' keeps the 回合 · prefix outside the marked span');
    });
    // POSIX mode: isWindows() is false, so the shipped function returns before touching anything
    assert.deepEqual(got.posix.map((o) => o.text), opts.map((o) => o.text), 'POSIX keeps the exact option text');
    assert.ok(got.posix.every((o) => o.kids.length === 0), 'POSIX leaves every option untouched (no wrapper span)');
  } finally {
    if (browser) await browser.close();
  }
});

#!/usr/bin/env node
'use strict';
/**
 * Gate C (physical Windows) — F4 first-run guide, F5 English walk-through (no ⌘ / Finder / Trash /
 * "this Mac"), F7 version history, F8 title-bar overlay + 720 px sidebar. Screenshots go to
 * FANBOX_GATEC_EVIDENCE (default: <fake home>\evidence).
 *
 * Run:  NODE_PATH=<dir with playwright-core> FANBOX_MATRIX_HOME=<writable fake home> node experiments/win-v2161-hooks-202609/gatec-ui-en.js
 */
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') { console.log('SKIP: Gate C script, this host is ' + process.platform); process.exit(0); }
try { require('playwright-core'); } catch { console.error('FAIL: playwright-core required on Windows Gate C'); process.exit(2); }

const { launch, check, done, FAKE_HOME } = require('../winport-parity-202607/matrix/launch');
setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 420000);

const PORT = '4740';
const EVID = process.env.FANBOX_GATEC_EVIDENCE || path.join(FAKE_HOME, 'evidence');
const PROJ = path.join(FAKE_HOME, 'work', 'ui-proj-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAC = /⌘|Finder|\bTrash\b|this Mac|macOS|访达|废纸篓/;
const CJK = /[一-鿿]/;
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'notes.md'), '# Notes\n\nplain text\n');
  fs.writeFileSync(path.join(PROJ, 'code.js'), 'const x = 1;\n');

  const { app, win } = await launch({}, { port: PORT, toolsPath: '', keepOnboarding: true });
  // ---- F4: fresh profile → the rewritten two-action guide, no ⌘, translated in EN ----
  await win.evaluate(() => { localStorage.removeItem('fb_guided'); localStorage.setItem('fb_lang', 'zh'); });
  await win.reload().catch(() => {});
  await sleep(3000);
  const gZh = await win.evaluate(() => { const o = document.getElementById('guide-open'); const ov = o && (o.closest('.input-overlay') || o.closest('[class*=guide]')); return ov ? { text: ov.innerText, open: !!o, agent: !!document.getElementById('guide-agent'), skip: !!document.getElementById('guide-skip') } : null; });
  check(!!gZh && gZh.open && gZh.agent && gZh.skip, 'F4: first-run guide shows the two actions (open project / start Claude Code)', JSON.stringify(gZh).slice(0, 200));
  check(!!gZh && !/⌘/.test(gZh.text), 'F4: guide (zh) has no ⌘', gZh && gZh.text.slice(0, 120));
  await win.evaluate(() => { localStorage.removeItem('fb_guided'); localStorage.setItem('fb_lang', 'en'); });
  await win.reload().catch(() => {});
  await sleep(3500);
  const gEn = await win.evaluate(() => { const o = document.getElementById('guide-open'); const ov = o && (o.closest('.input-overlay') || o.closest('[class*=guide]')); return ov ? ov.innerText : null; });
  check(!!gEn && !CJK.test(gEn) && !MAC.test(gEn), 'F4: guide fully English, no ⌘', gEn && gEn.replace(/\s+/g, ' ').slice(0, 200));
  await win.evaluate(() => { const s = document.getElementById('guide-skip'); if (s) s.click(); localStorage.setItem('fb_guided', '1'); });
  await sleep(500);

  // ---- F5: English walk-through ----
  await win.evaluate((p) => navigate(p), PROJ);
  await sleep(1500);
  const side = await win.evaluate(() => ({ sidebar: document.getElementById('sidebar').innerText, lid: (document.getElementById('pw-lid') || {}).outerHTML || '', langBtn: (document.getElementById('lang-toggle') || {}).textContent }));
  check(side.langBtn === '中文', 'F5: language toggle offers 中文 (we are in EN)', side.langBtn);
  const sideText = side.sidebar.replace(/\s+/g, ' ').replace(/中文/g, '');
  check(!CJK.test(sideText) && !MAC.test(sideText), 'F5: sidebar (工具 group, stay-awake row) has no Chinese / Mac wording', sideText.slice(0, 300));
  check(/Skills|Cron|Usage|More/i.test(sideText) && /awake|Stay/i.test(sideText + ' ' + strip(side.lid)), 'F5: sidebar shows the tools group and the stay-awake row', sideText.slice(0, 200));
  const lidTitle = await win.evaluate(() => { const el = document.getElementById('pw-lid'); return el ? (el.title || '') + ' ' + [...el.querySelectorAll('[title]')].map((x) => x.title).join(' ') : ''; });
  check(!CJK.test(lidTitle) && !/lid|合盖/i.test(lidTitle), 'F5: stay-awake tip is English and mentions no lid', lidTitle.slice(0, 200));
  const menus = await win.evaluate(async () => {
    const out = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const grab = async (name, fn) => { try { fn(); } catch (e) { out[name] = 'ERR ' + e.message; return; } await wait(400); const m = document.getElementById('context-menu'); out[name] = m ? m.innerText.replace(/\s+/g, ' ').trim() : 'NO MENU'; closeContextMenu(); };
    await grab('more', () => document.getElementById('more-entry').click());
    await grab('termMore', () => $('#term-more').onclick({ stopPropagation() {}, currentTarget: $('#term-more') }));
    const e = state.entries.find((x) => x.name === 'notes.md');
    if (e) { await openPreview(e); await wait(1200); }
    await grab('preview', () => document.getElementById('preview-more').click());
    out.previewTitles = (document.getElementById('preview-actions').innerText + ' ' + [...document.querySelectorAll('#preview-actions [title]')].map((b) => b.title).join(' | ')).replace(/\s+/g, ' ').trim();
    return out;
  });
  for (const k of ['more', 'termMore', 'preview', 'previewTitles']) {
    const t = menus[k] || '';
    check(t && !CJK.test(t) && !MAC.test(t), `F5: ${k} menu is English without Mac wording`, t.slice(0, 220));
  }
  check(/Ctrl\+Alt\+M/.test(menus.termMore || ''), 'F3/F5: terminal 「…」 shows Ctrl+Alt+M', menus.termMore);
  check(/File Explorer/.test(menus.preview || ''), 'F5/D7: preview menu says File Explorer', menus.preview);
  const round = await win.evaluate(async () => { await openRoundPanel(); await new Promise((r) => setTimeout(r, 1500)); const d = document.querySelector('.round-dialog'); const t = d ? d.innerText : ''; const c = document.querySelector('.round-close'); if (c) c.click(); return t; });
  check(round && !CJK.test(round.replace(/ui-proj-\d+/g, '')) && !MAC.test(round), 'F5: 本回合 panel English, no Trash/Finder', round.replace(/\s+/g, ' ').slice(0, 220));
  const rosterRows = await win.evaluate(async () => { const s = term.sessions[0]; const a = roster.rowHtml(s, 'ask'); s._fresh = true; const b = roster.rowHtml(s, 'idle'); s._fresh = false; const c = roster.rowHtml(s, 'input'); const box = document.createElement('div'); box.innerHTML = a + b + c; document.body.appendChild(box); await new Promise((r) => setTimeout(r, 400)); const t = box.innerText; box.remove(); return t; });
  check(rosterRows && !CJK.test(rosterRows) && /approval|Just finished|input/i.test(rosterRows), 'F5: 指挥台 rows (ask / just finished / input) render in English', rosterRows.replace(/\s+/g, ' ').slice(0, 200));
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('update:available', { version: '9.9.9', url: 'https://github.com/Emberwhirl/fanbox/releases', auto: false }); });
  await sleep(800);
  const pill = await win.evaluate(() => { const b = document.querySelector('.update-pill'); const t = b ? b.innerText : ''; const x = b && b.querySelector('.up-x'); if (x) x.click(); localStorage.removeItem('fb_skip_ver'); return t; });
  check(pill && /Download update|下载更新/.test(pill) && !/(^|\s)更新(\s|$)|(^|\s)Update(\s|$)/.test(pill) && !CJK.test(pill), 'F5/D1: update capsule says Download update (never bare Update) in English', pill.replace(/\s+/g, ' '));
  const toasts = await win.evaluate(() => { const T = window.FANBOX_I18N || window.I18N || null; const keys = ['已移入回收站', '已移到回收站', '已在文件管理器中显示', '已复制文件，可在资源管理器里粘贴']; return keys.map((k) => (typeof t === 'function' ? t(k) : (T && T[k]) || '') + '').join(' | '); });
  const dictSrc = fs.readFileSync(path.join(__dirname, '../../public/i18n-dict.js'), 'utf8');
  check(/'已移入回收站': 'Moved to Recycle Bin'/.test(dictSrc) && /'已在文件管理器中显示': `Revealed in \$\{FANBOX_UI_MAC \? 'Finder' : 'File Explorer'\}`/.test(dictSrc), 'F5: restore/reveal toasts have Windows EN entries', toasts.slice(0, 160));

  // ---- F7: version history renders the changelog (Chinese content, untranslated) ----
  const hist = await win.evaluate(async () => { await verInfo.showAll(); await new Promise((r) => setTimeout(r, 1500)); const ov = [...document.querySelectorAll('.input-overlay, .snap-overlay, [class*=overlay]')].pop(); const t = ov ? ov.innerText : ''; return t; });
  check(/2\.16\.1/.test(hist) && /Windows port/i.test(hist) && CJK.test(hist), 'F7: version history shows 2.16.1 with the Windows port section (h3 is CSS-uppercased) in Chinese', JSON.stringify({ len: hist.length, ver: /2\.16\.1/.test(hist), port: /Windows port/i.test(hist), cjk: CJK.test(hist), head: hist.slice(0, 80) }));
  await win.evaluate(() => { document.querySelectorAll('.input-overlay, .snap-overlay').forEach((o) => o.remove()); });

  // ---- F8: title-bar overlay clearance + tools group at 720 px ----
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1280, 720); w.center(); });
  await sleep(1200);
  const lay = await win.evaluate(() => {
    const r = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, right: b.right, h: b.height, vis: b.height > 0 && b.bottom <= innerHeight && b.top >= 0 }; };
    return { innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio, topbarPadR: getComputedStyle(document.getElementById('topbar')).paddingRight, win32: document.documentElement.classList.contains('win32'), changes: r('btn-changes'), recent: r('btn-recent'), terminal: r('btn-terminal'), skills: r('skills-entry'), cron: r('cron-entry'), usage: r('usage-sec'), more: r('more-entry'), lid: r('pw-lid') };
  });
  const overlayW = 138; // Windows caption controls at 100 %
  check(lay.win32 && lay.topbarPadR === '148px', 'F8: win32 topbar keeps 148px right padding for the caption controls', JSON.stringify({ win32: lay.win32, pad: lay.topbarPadR }));
  check(lay.changes && lay.changes.right <= lay.innerW - overlayW && lay.terminal && lay.terminal.right <= lay.innerW - overlayW, 'F8: 本回合 / terminal top-bar buttons clear the caption controls', JSON.stringify({ innerW: lay.innerW, changes: lay.changes, terminal: lay.terminal }));
  check(['skills', 'cron', 'usage', 'more', 'lid'].every((k) => lay[k] && lay[k].vis), 'F8: tools group + stay-awake row visible at 720 px height', JSON.stringify({ h: lay.innerH, skills: lay.skills, lid: lay.lid }));
  await win.screenshot({ path: path.join(EVID, 'f8-1280x720-zoom100.png') });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5); });
  await sleep(800);
  const lay150 = await win.evaluate(() => { const b = document.getElementById('btn-changes').getBoundingClientRect(); return { innerW: innerWidth, right: b.right, padR: getComputedStyle(document.getElementById('topbar')).paddingRight, lidVis: (() => { const r = document.getElementById('pw-lid').getBoundingClientRect(); return r.bottom <= innerHeight; })() }; });
  await win.screenshot({ path: path.join(EVID, 'f8-1280x720-zoom150.png') });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.0); });
  check(lay150.right <= lay150.innerW - overlayW / 1.5, 'F8: at 150 % zoom the 本回合 button still clears the caption controls (CSS px)', JSON.stringify(lay150));
  console.log('evidence: ' + EVID);
  await done(app);
})().catch((e) => { console.error('FAIL: exception', e && e.stack || e); process.exit(1); });

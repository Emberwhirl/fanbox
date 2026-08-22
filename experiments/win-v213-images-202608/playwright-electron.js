#!/usr/bin/env node
'use strict';
/**
 * Physical-Windows Playwright Electron coverage for v2.13 image/Typeset flows.
 * Linux / missing Electron: skip with a clear message (not a green lie).
 * On win32, missing playwright-core or a failed assertion exits nonzero.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

if (process.platform !== 'win32') {
  console.log('SKIP: playwright-electron.js is Gate C (physical Windows). This host is ' + process.platform);
  process.exit(0);
}

try { require('playwright-core'); } catch {
  try { require('playwright'); } catch {
    console.error('FAIL: playwright-core required on Windows Gate C');
    process.exit(2);
  }
}
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
  console.error('FAIL: bundled electron missing');
  process.exit(2);
}

const { launch, check, done, FAKE_HOME } = require('../winport-parity-202607/matrix/launch');
const H = require('../../win-port-helpers.js');

setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 360000);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const stamp = String(Date.now());
const PROJ = path.join(FAKE_HOME, 'Documents', 'img-proj-' + stamp);
const OUT = path.join(FAKE_HOME, 'Documents', 'outside-' + stamp);
const MD = path.join(PROJ, 'article.md');

function writePng(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, png); }

(async () => {
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  writePng(path.join(PROJ, 'in-tree.png'));
  writePng(path.join(PROJ, 'sub', 'nested.png'));
  writePng(path.join(OUT, 'outside.png'));
  writePng(path.join(OUT, 'my pic.png'));
  writePng(path.join(OUT, "o'reilly.png"));
  writePng(path.join(OUT, 'hash#tag.png'));
  writePng(path.join(OUT, 'pct%5Cname.png'));
  fs.writeFileSync(MD, '# article\n\nhello\n');

  const { app, win } = await launch({}, { port: '4781' });
  const keys = await win.evaluate(() => Object.keys(window).filter((k) => /^fanbox/.test(k)).sort());
  check(keys.includes('fanboxWinPath') && keys.includes('fanboxUpdate') && keys.includes('fanboxWechat'),
    'sandboxed preload still exposes bridges after fanboxDrop', JSON.stringify(keys));

  const keep = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(PROJ, 'in-tree.png'), dir: PROJ,
  });
  check(keep && keep.ok && keep.copied === false && /in-tree\.png$/i.test(keep.path),
    'in-tree equal path does not copy', JSON.stringify(keep));
  const before = fs.readdirSync(PROJ).filter((n) => /in-tree/i.test(n)).length;
  await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(PROJ, 'in-tree.png'), dir: PROJ,
  });
  const after = fs.readdirSync(PROJ).filter((n) => /in-tree/i.test(n)).length;
  check(after === before, 'repeated in-tree insertion creates no duplicate file', String(after));

  const nested = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(PROJ, 'sub', 'nested.png'), dir: PROJ,
  });
  check(nested && nested.copied === false, 'descendant does not copy', JSON.stringify(nested));

  const cas = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(PROJ, 'IN-TREE.png'), dir: PROJ,
  });
  check(cas && cas.ok && cas.copied === false, 'case-only change does not copy', JSON.stringify(cas));

  const sibDir = path.join(FAKE_HOME, 'Documents', 'img-proj-extra-' + stamp);
  fs.mkdirSync(sibDir, { recursive: true });
  writePng(path.join(sibDir, 'sib.png'));
  const sib = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(sibDir, 'sib.png'), dir: PROJ,
  });
  check(sib && sib.copied === true && fs.existsSync(path.join(PROJ, 'sib.png')),
    'sibling-prefix copies once', JSON.stringify(sib));

  const xd = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(OUT, 'outside.png'), dir: PROJ,
  });
  check(xd && xd.copied === true && fs.existsSync(path.join(PROJ, 'outside.png')),
    'outside copy once', JSON.stringify(xd));
  const nOut = fs.readdirSync(PROJ).filter((n) => /^outside( \d+)?\.png$/i.test(n)).length;
  await win.evaluate(async ({ src, dir }) => window.fanboxDrop.containImage(src, dir), {
    src: path.join(OUT, 'outside.png'), dir: PROJ,
  });
  const nOut2 = fs.readdirSync(PROJ).filter((n) => /^outside( \d+)?\.png$/i.test(n)).length;
  check(nOut2 === nOut + 1 && fs.existsSync(path.join(PROJ, 'outside 2.png')),
    'collision uses uniqueDest without overwrite', String(nOut2));

  const copyInto = await win.evaluate(async ({ src, dir }) => window.fanboxDrop.copyInto(src, dir), {
    src: path.join(PROJ, 'in-tree.png'), dir: PROJ,
  });
  check(copyInto && copyInto.ok && copyInto.path === path.join(PROJ, 'in-tree.png'),
    'copy-into same-file checks unsuffixed dest', JSON.stringify(copyInto));

  const dests = [
    path.join(OUT, 'my pic.png'),
    path.join(OUT, "o'reilly.png"),
    path.join(OUT, 'hash#tag.png'),
    path.join(OUT, 'pct%5Cname.png'),
  ];
  for (const p of dests) {
    const r = await win.evaluate((p) => window.fanboxWinPath.toMarkdownDest(p), p);
    check(r && r.ok, 'toMarkdownDest ok ' + path.basename(p), JSON.stringify(r));
    check(!H.isForbiddenPersistSrc(r.dest), 'not a forbidden persist src ' + r.dest);
    const back = await win.evaluate((d) => window.fanboxWinPath.fromMarkdownDest(d), r.dest);
    check(back && back.path === p, 'one decode recovers native path', JSON.stringify(back));
    if (p.includes('%5C')) check(/%255C/.test(r.dest), 'literal %5C → %255C', r.dest);
  }
  check(!(await win.evaluate(() => window.fanboxWinPath.toMarkdownDest('./rel.png'))).ok, 'reject relative');
  check(await win.evaluate(() => window.fanboxWinPath.isForbiddenPersistSrc('file://C:/a.png')), 'forbidden file://');
  check(await win.evaluate(() => window.fanboxWinPath.isForbiddenPersistSrc('/api/raw?path=x')), 'forbidden /api/raw');

  const entry = await win.evaluate(async (p) => {
    const dir = p.slice(0, p.lastIndexOf('\\'));
    const d = await api('/api/list?path=' + encodeURIComponent(dir));
    return (d.entries || []).find((x) => x.name === 'article.md');
  }, MD);
  check(!!entry, 'article.md listed');
  await win.evaluate(async (e) => { if (typeof enterEditMode === 'function') await enterEditMode(e); }, entry);
  await win.waitForTimeout(1800);
  const ui = await win.evaluate(() => ({
    ins: !!document.querySelector('#ed-insimg-btn'),
    ts: !!document.querySelector('#ed-typeset-btn'),
    noHost: !document.querySelector('.typeset-host'),
    insTxt: (document.querySelector('#ed-insimg-btn') || {}).textContent,
    tsTxt: (document.querySelector('#ed-typeset-btn') || {}).textContent,
  }));
  check(ui.ins && ui.ts && ui.noHost, 'Insert image + Typeset buttons; persistent host gone', JSON.stringify(ui));

  await win.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, .seg-btn, .ed-seg button'));
    const hit = btns.find((b) => /源码|Source/.test(b.textContent || ''));
    if (hit) hit.click();
  });
  await win.waitForTimeout(800);

  const inserted = await win.evaluate(async ({ src, dir }) => {
    const r2 = await window.fanboxDrop.containImage(src, dir);
    if (!r2 || !r2.ok) return r2;
    const dest = window.fanboxWinPath.toMarkdownDest(r2.path);
    const ta = document.querySelector('textarea.editor-area, #ed-host textarea, textarea');
    if (ta) {
      ta.setRangeText(`![](${dest.dest})`, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, dest: dest.dest, value: ta.value };
    }
    if (window.mona && window.mona.editor) {
      const ed = window.mona.editor;
      ed.executeEdits('insert-image', [{ range: ed.getSelection(), text: `![](${dest.dest})`, forceMoveMarkers: true }]);
      return { ok: true, dest: dest.dest, value: ed.getValue() };
    }
    return { ok: false, dest: dest.dest, err: 'no source editor' };
  }, { src: path.join(OUT, 'my pic.png'), dir: PROJ });
  check(inserted && inserted.ok && /my%20pic/.test(inserted.value || inserted.dest),
    'Source insertion uses canonical dest', JSON.stringify(inserted).slice(0, 240));
  check(!/file:\/\/|\/api\/raw|blob:|data:image:|pending-upload:/.test(inserted.value || ''),
    'no transient URL persisted in source');

  await win.evaluate(() => { const b = document.querySelector('#ed-typeset-btn'); if (b) b.click(); });
  await win.waitForTimeout(700);
  const modal = await win.evaluate(() => ({
    dialog: !!document.querySelector('.typeset-dialog'),
    preview: !!document.querySelector('.ts-preview'),
  }));
  check(modal.dialog && modal.preview, 'Typeset modal opens', JSON.stringify(modal));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  const closed = await win.evaluate(() => !!document.querySelector('.typeset-dialog'));
  check(!closed, 'Escape closes Typeset modal');

  await win.evaluate(() => { localStorage.setItem('fb_lang', 'en'); location.reload(); });
  await win.waitForTimeout(3200);
  await win.evaluate(async (e) => { if (typeof enterEditMode === 'function') await enterEditMode(e); }, entry);
  await win.waitForTimeout(1500);
  const en = await win.evaluate(() => ({
    ins: (document.querySelector('#ed-insimg-btn') || {}).textContent,
    ts: (document.querySelector('#ed-typeset-btn') || {}).textContent,
  }));
  check(/Insert image/i.test(en.ins || ''), 'EN Insert image', en.ins);
  check(/Typeset/i.test(en.ts || ''), 'EN Typeset…', en.ts);
  check(!/[一-鿿]/.test((en.ins || '') + (en.ts || '')), 'EN controls have no Chinese');
  check(!/Option|iTerm/.test((en.ins || '') + (en.ts || '')), 'no Option/iTerm on editor controls');

  const saved = await win.evaluate(async ({ dir }) => {
    const u8 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    return window.fanboxDrop.saveInto(dir, 'paste.png', u8.buffer);
  }, { dir: PROJ });
  check(saved && saved.ok && fs.existsSync(saved.path), 'saveInto persists screenshot-like bytes', JSON.stringify(saved));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

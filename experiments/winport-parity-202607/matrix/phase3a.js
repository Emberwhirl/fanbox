// Phase 3a — H1/D1: HTML preview with relative assets, markdown local images, fsUrl shape.
const { launch, check, done, FAKE_HOME } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 300000);
const FIX = FAKE_HOME + '\\fanbox-test-fixtures';

(async () => {
  const { app, win } = await launch({}, { port: '4660' });

  // fsUrl unit shape (D1 URL scheme)
  const shape = await win.evaluate(() => fsUrl('C:\\Users\\bbbb\\a b\\x.png', 7));
  check(/^http:\/\/[^/]+:4661\/fs\/C(:|%3A)\/Users\/bbbb\/a%20b\/x\.png\?v=7$/.test(shape), 'fsUrl: drive path → /fs/C:/… on preview port', shape);

  // ---- HTML preview with relative assets ----
  const entry = await win.evaluate(async (dir) => {
    const d = await api('/api/list?path=' + encodeURIComponent(dir));
    return (d.entries || []).find((x) => x.name === 'page.html');
  }, FIX + '\\preview');
  check(!!entry, 'page.html listed via /api/list', JSON.stringify(entry || {}));
  await win.evaluate(async (e) => { state.selected = e.path; await openPreview(e); }, entry);
  await win.waitForTimeout(2500);
  const iframeSrc = await win.evaluate(() => { const f = document.querySelector('#preview-body iframe.iframe-preview'); return f ? f.src : null; });
  const expectFs = '/fs/' + FAKE_HOME.split(String.fromCharCode(92)).join('/').replace(/^([A-Za-z]):/, (m, d) => d + '(:|%3A)').replace(/[.]/g, '[.]') + '/fanbox-test-fixtures/preview/page[.]html';
  check(!!iframeSrc && new RegExp(':4661' + expectFs).test(iframeSrc), 'preview iframe points at /fs drive-letter URL', iframeSrc);

  let frame = win.frames().find((f) => /\/fs\/.*page\.html/.test(f.url()));
  check(!!frame, 'preview frame attached');
  let result = '';
  for (let i = 0; i < 20 && frame; i++) {
    result = await frame.evaluate(() => (document.getElementById('result') || {}).textContent || '').catch(() => '');
    if (result && result !== 'loading...') break;
    await win.waitForTimeout(500);
  }
  const title = frame ? await frame.evaluate(() => document.title).catch(() => '') : '';
  check(title === 'JS-RAN', 'sandboxed iframe runs scripts', title);
  check(/relimg=OK/.test(result), 'relative <img> resolves inside preview', result);
  check(/css=OK/.test(result), 'relative <link> stylesheet resolves', result);
  check(/fileurl=OK/.test(result), 'file:///C:/ image rewritten to /fs and loads', result);

  // ---- Markdown images in the Crepe editor (default md open path) ----
  const mdEntry = await win.evaluate(async (dir) => {
    const d = await api('/api/list?path=' + encodeURIComponent(dir));
    return (d.entries || []).find((x) => x.name === 'doc.md');
  }, FIX + '\\md');
  await win.evaluate(async (e) => { state.selected = e.path; await openPreview(e); }, mdEntry);
  await win.waitForTimeout(4000);
  const crepeImgs = await win.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('#preview-body img')).filter((im) => im.getAttribute('src')); // ignore editor chrome <img> without src
    return imgs.map((im) => ({ src: (im.currentSrc || im.src || '').slice(-90), ok: im.complete && im.naturalWidth > 0 }));
  });
  check(crepeImgs.length >= 4, 'crepe: all 4 md images present', JSON.stringify(crepeImgs.map((x) => x.ok)));
  check(crepeImgs.length >= 4 && crepeImgs.every((x) => x.ok), 'crepe: relative + absolute md images all load', JSON.stringify(crepeImgs.filter((x) => !x.ok), null, 0).slice(0, 400));

  // ---- Markdown read body (follow-mode renderer) ----
  const readImgs = await win.evaluate(async (p) => {
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    const div = mdReadBody(d.content || '', p);
    document.body.appendChild(div);
    await new Promise((r) => setTimeout(r, 2500));
    const out = Array.from(div.querySelectorAll('img')).map((im) => ({ src: (im.currentSrc || im.src || '').slice(-90), ok: im.complete && im.naturalWidth > 0 }));
    div.remove();
    return out;
  }, FIX + '\\md\\doc.md');
  check(readImgs.length >= 4 && readImgs.filter((x) => x.ok).length >= 2, 'read-body: relative md images load', JSON.stringify(readImgs, null, 0).slice(0, 400));
  check(readImgs.length >= 4 && readImgs.every((x) => x.ok), 'read-body: absolute-path md images also load', JSON.stringify(readImgs, null, 0).slice(0, 400));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

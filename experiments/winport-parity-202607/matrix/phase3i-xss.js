// Phase 3i — markdown sanitization on the Windows port (back-ported fix, dev branch).
// Stronger than the upstream-branch check: on dev the fixLocalImages Windows fix is also
// present, so local images must actually LOAD, not merely keep their src.
const { launch, check, done, FAKE_HOME } = require('./launch');
const MAL = FAKE_HOME + '\\notes\\innocent.md';
const LEGIT = FAKE_HOME + '\\notes\\real.md';

setTimeout(() => { console.error('FAIL: watchdog'); process.exit(2); }, 300000);

const readBuf = (id) => id;

(async () => {
  const { app, win } = await launch({}, { port: '4750' });

  check(await win.evaluate(() => !!(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function')), 'DOMPurify loaded');
  check(await win.evaluate(() => (window.DOMPurify ? window.DOMPurify.version : null)) === '3.4.8', 'DOMPurify 3.4.8 (upstream vendor/dompurify)');
  check(await win.evaluate(() => typeof mdHtml) === 'function', 'mdHtml chokepoint present');

  // --- every previously vulnerable path ---
  const a = await win.evaluate(async (p) => {
    delete window.__XSS_PROOF;
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    const div = mdReadBody(d.content || '', p);
    document.body.appendChild(div);
    await new Promise((r) => setTimeout(r, 1500));
    div.remove();
    return window.__XSS_PROOF || null;
  }, MAL);
  check(a === null, 'mdReadBody — neutralized', JSON.stringify(a));

  const b = await win.evaluate(async (p) => {
    delete window.__XSS_PROOF;
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    const div = document.createElement('div');
    div.innerHTML = mdHtml(d.content || '');
    await new Promise((r) => setTimeout(r, 1500));
    return window.__XSS_PROOF || null;
  }, MAL);
  check(b === null, 'semanticSig shape — neutralized', JSON.stringify(b));

  const c = await win.evaluate(async (p) => {
    delete window.__XSS_PROOF;
    const dir = p.slice(0, p.lastIndexOf('\\'));
    const list = await api('/api/list?path=' + encodeURIComponent(dir));
    const e = (list.entries || []).find((x) => x.name === 'innocent.md');
    state.selected = e.path;
    await openPreview(e);
    await new Promise((r) => setTimeout(r, 3000));
    return window.__XSS_PROOF || null;
  }, MAL);
  check(c === null, 'double-click open (real UI path) — neutralized', JSON.stringify(c));

  const t = await win.evaluate(async (p) => {
    delete window.__XSS_PROOF;
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    const box = window.typeset.build(d.content || '', p, undefined);
    document.body.appendChild(box);
    await new Promise((r) => setTimeout(r, 1500));
    const html = box.innerHTML; box.remove();
    return { fired: window.__XSS_PROOF || null, onerror: /onerror/i.test(html), img: /<img/i.test(html) };
  }, MAL);
  check(t.fired === null && t.onerror === false, 'typeset.build — neutralized, onerror stripped', JSON.stringify(t));
  check(t.img === true, 'typeset.build — legitimate <img> element preserved (sanitize, not mutilate)', JSON.stringify(t));

  const cx = await win.evaluate(async (p) => {
    delete window.__XSS_PROOF;
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    try { await window.typeset.copyX(d.content || '', p); } catch (e) { /* clipboard may refuse */ }
    await new Promise((r) => setTimeout(r, 1500));
    return window.__XSS_PROOF || null;
  }, MAL);
  check(cx === null, 'typeset.copyX — neutralized', JSON.stringify(cx));

  // --- legitimate rendering must be untouched, and on dev images must actually load ---
  const legit = await win.evaluate(async (p) => {
    const d = await api('/api/read?path=' + encodeURIComponent(p));
    const div = mdReadBody(d.content || '', p);
    document.body.appendChild(div);
    await new Promise((r) => setTimeout(r, 2500));
    const img = div.querySelector('img');
    const out = {
      h1: !!div.querySelector('h1'), bold: !!div.querySelector('strong'), code: !!div.querySelector('code'),
      pre: !!div.querySelector('pre'), table: !!div.querySelector('table'), quote: !!div.querySelector('blockquote'),
      details: !!div.querySelector('details'), checkbox: !!div.querySelector('input[type=checkbox]'),
      link: img ? (div.querySelector('a') || {}).getAttribute('href') : '',
      imgSrc: img ? img.getAttribute('src') : '', imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
    };
    div.remove();
    return out;
  }, LEGIT);
  check(legit.h1 && legit.bold && legit.code && legit.pre && legit.table && legit.quote && legit.details && legit.checkbox,
    'legit markdown fully preserved', JSON.stringify(legit));
  check(legit.imgLoaded === true, 'local image LOADS (sanitizer + Windows fixLocalImages fix coexist)', legit.imgSrc + ' loaded=' + legit.imgLoaded);

  // --- the Windows drive-letter URI allowance must not reopen script schemes ---
  const uri = await win.evaluate(() => {
    const probe = (md) => { const d = document.createElement('div'); d.innerHTML = mdHtml(md); return d; };
    const a = probe('[click](javascript:window.__XSS_PROOF=1)').querySelector('a');
    const img = probe('<img src="javascript:window.__XSS_PROOF=1">').querySelector('img');
    const data = probe('<a href="data:text/html,<script>window.__XSS_PROOF=1<\/script>">x</a>').querySelector('a');
    const drive = probe('![fig](C:\\pics\\cover.png)').querySelector('img');
    const driveFwd = probe('![fig](C:/pics/cover.png)').querySelector('img');
    return {
      jsHref: a ? a.getAttribute('href') : null,
      jsImg: img ? img.getAttribute('src') : null,
      dataHref: data ? data.getAttribute('href') : null,
      driveSrc: drive ? drive.getAttribute('src') : null,
      driveFwdSrc: driveFwd ? driveFwd.getAttribute('src') : null,
    };
  });
  check(!/^javascript:/i.test(uri.jsHref || ''), 'javascript: link still stripped', JSON.stringify(uri.jsHref));
  check(!/^javascript:/i.test(uri.jsImg || ''), 'javascript: img src still stripped', JSON.stringify(uri.jsImg));
  check(!/^data:text\/html/i.test(uri.dataHref || ''), 'data:text/html still stripped', JSON.stringify(uri.dataHref));
  // marked encodeURI's the destination, so the backslash arrives as %5C — fixLocalImages
  // decodeURIComponent's it back before rewriting to /api/raw, so either form is correct here.
  check(/^C:(\\|%5c)pics/i.test(uri.driveSrc || ''), 'drive-letter backslash src survives (percent-encoded)', JSON.stringify(uri.driveSrc));
  check(/^C:\/pics/i.test(uri.driveFwdSrc || ''), 'drive-letter forward-slash src survives', JSON.stringify(uri.driveFwdSrc));

  // --- fail closed ---
  const closed = await win.evaluate(() => {
    const keep = window.DOMPurify;
    delete window.DOMPurify;
    const out = mdHtml('# hi\n\n<img src=x onerror="window.__XSS_PROOF=1">');
    window.DOMPurify = keep;
    return out;
  });
  check((/^<pre>/.test(closed) || /^# hi/.test(closed)) && !/<img /i.test(closed) && /&lt;img/.test(closed), 'DOMPurify absent → fail closed (escaped text; upstream mdHtml returns escapeHtml(src))', closed.slice(0, 70));

  // Typeset modal (replaces persistent typeset-host / v2.12 tab)
  const ts = await win.evaluate(async (p) => {
    const dir = p.slice(0, p.lastIndexOf('\\'));
    const list = await api('/api/list?path=' + encodeURIComponent(dir));
    const e = (list.entries || []).find((x) => x.name === 'real.md');
    if (e && typeof enterEditMode === 'function') await enterEditMode(e);
    await new Promise((r) => setTimeout(r, 1200));
    const btn = document.querySelector('#ed-typeset-btn');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 500));
    delete window.__XSS_PROOF;
    const box = document.querySelector('.ts-preview');
    return {
      btn: !!document.querySelector('#ed-typeset-btn'),
      dialog: !!document.querySelector('.typeset-dialog'),
      preview: !!box,
      noHost: !document.querySelector('.typeset-host'),
      fired: window.__XSS_PROOF || null,
    };
  }, LEGIT);
  check(ts.btn && ts.dialog && ts.preview && ts.noHost, 'Typeset modal #ed-typeset-btn/.typeset-dialog/.ts-preview; typeset-host gone', JSON.stringify(ts));
  check(ts.fired === null, 'Typeset modal preview does not execute XSS', JSON.stringify(ts.fired));

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

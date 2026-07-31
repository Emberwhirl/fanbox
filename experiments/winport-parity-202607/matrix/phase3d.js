// Phase 3d — D6 thumbnail chain: magick → ffmpeg → give up (never bare `convert`).
const { launch, closeApp, check, done, FAKE_HOME } = require('./launch');

setTimeout(() => { console.error('FAIL: watchdog timeout'); process.exit(2); }, 480000);
const THUMBS = FAKE_HOME + '\\fanbox-test-fixtures\\thumbs';
const IM = 'C:\\Users\\bbbb\\tools\\imagemagick;';
const FF = 'D:\\ffmpeg-master-latest-win64-gpl-shared\\bin;';

const clearCache = () => require('fs').rmSync(FAKE_HOME + '\\.fanbox\\thumbs', { recursive: true, force: true });

const probe = (win, p, w) => win.evaluate(async ({ p, w }) => {
  const r = await fetch('/api/thumb?path=' + encodeURIComponent(p) + '&w=' + (w || 400));
  const b = r.ok ? (await r.arrayBuffer()).byteLength : 0;
  return { status: r.status, type: r.headers.get('content-type'), bytes: b };
}, { p, w });

(async () => {
  // ---- A: magick + ffmpeg on PATH → magick chain ----
  clearCache();
  let { app, win } = await launch({}, { port: '4690', toolsPath: IM + FF });
  let r = await probe(win, THUMBS + '\\photo.png');
  check(r.status === 200 && r.bytes > 0, 'A magick: png thumbnail', JSON.stringify(r));
  r = await probe(win, THUMBS + '\\anim.gif');
  check(r.status === 200 && r.bytes > 0, 'A magick: multi-frame gif thumbnail (-delete 1--1 fix)', JSON.stringify(r));
  r = await probe(win, THUMBS + '\\photo [bracket].png');
  check(r.status === 200 && r.bytes > 0, 'A magick: bracket filename not misparsed', JSON.stringify(r));
  await closeApp(app);

  // ---- B: only ffmpeg on PATH → fallback chain ----
  clearCache();
  ({ app, win } = await launch({}, { port: '4691', toolsPath: FF }));
  r = await probe(win, THUMBS + '\\photo.png');
  check(r.status === 200 && r.bytes > 0, 'B ffmpeg fallback: png thumbnail', JSON.stringify(r));
  r = await probe(win, THUMBS + '\\photo [bracket].png');
  check(r.status === 200 && r.bytes > 0, 'B ffmpeg fallback: bracket filename', JSON.stringify(r));
  await closeApp(app);

  // ---- C: neither tool → clean give-up (no System32 convert.exe execution) ----
  clearCache();
  ({ app, win } = await launch({}, { port: '4692', toolsPath: '' }));
  r = await probe(win, THUMBS + '\\photo.png');
  check(r.status !== 200, 'C no tools: thumb endpoint fails closed (frontend falls back to /api/raw)', JSON.stringify(r));
  const raw = await win.evaluate(async (p) => { const q = await fetch('/api/raw?path=' + encodeURIComponent(p)); return q.status; }, THUMBS + '\\photo.png');
  check(raw === 200, 'C no tools: /api/raw fallback still renders the image', 'raw=' + raw);

  await done(app);
})().catch((e) => { console.error('FAIL: exception', e); process.exit(2); });

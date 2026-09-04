# Windows port parity acceptance (2026-07)

Campaign for the v2.12.1 Windows-port remediation plan
(`docs/win-port-implementation-plan-v2.12.1.html`).

## What it checks

`verify.js` re-checks that every hunk in `git diff master...HEAD` for the five
core JS files falls into an accepted golden-rule category:

- **(a)** inside an `IS_WIN` / `isWindows()` / `PLATFORM === 'win32'` / `isWin()` guard
- **(b)** pure addition (new win-only helper, new dict keys)
- **(c)** whitelisted one-liner rewrite whose only behavioral branch is behind a platform/sep guard

### Accepted shared edits (v2.16.1) — PR #60 sanitizer deviation retired

Upstream v2.15+ shipped the DOMPurify `mdHtml()` chokepoint, so the v2.12.1 PR #60
Windows-port sanitizer deviation is **retired**. Remaining accepted shared-text edits
this round (classified in `verify.js` whitelist, listed in CHANGELOG `### Windows port`):

1. `autoUpdater.on('error', …)` — an emitted error with no listener throws in main.
2. inert `<template>` `semanticSig()` — a `<div>` would load `<img>` and fire `onerror`.
3. platform-ternary `fsp.rm` `{ maxRetries, retryDelay }` — Windows file locks vs un-awaited `git gc`.
4. optional third parameter on `run()` — Windows thumbnails share the 4-way concurrency gate.

`preview-guard.test.js` pins the preview server's win32 path gate — the boundary that
keeps a malicious previewed HTML (which runs `allow-same-origin` against the preview
port) from reading `~/.ssh`, `~/.claude` and friends. It replays `previewPathAllowed`'s
win32 branch under `path.win32` with an injectable `realpath`, so it runs on any OS.
The case that motivated it: NTFS 8.3 short names (`.ssh` → `SSH~1`) contain no dot and
sailed straight through the "segment starts with `.`" check.

**When you change `previewPathAllowed` in `server.js`, update the mirrored copy here.**

## Run

```bash
node experiments/winport-parity-202607/verify.js            # golden-rule heuristic scan
node experiments/winport-parity-202607/preview-guard.test.js # exits non-zero on regression
```

## Physical Windows matrix (`matrix/`) — RUN AND PASSED 2026-07-31

The §6 merge-gate matrix was executed on a physical Windows 10 x64 machine
(LTSC 2021 / 19044, PowerShell 5.1, Node 24, VS Build Tools 2022 + Spectre libs,
ImageMagick 7.1.2 portable, ffmpeg on `D:`). Most phases drive the real dev
Electron app with Playwright (`matrix/launch.js` — repo convention from
`experiments/atlas-pressure-202607`), sandboxed under a fake
`USERPROFILE`/`APPDATA` (`C:\Users\bbbb\fb-matrix-home`) so the tester's real
`~/.fanbox` is never touched. Paths in `matrix/*.js` are machine-specific to
that box; `npm i playwright-core` in a scratch dir and adjust `launch.js`
constants to rerun elsewhere.

| Phase | Covers | Result |
|---|---|---|
| `phase2.js` / `phase2b.js` | ConPTY echo round-trip, busy tri-state (idle→busy child→idle), D3 no LANG, git in OS language, SHELL honored, D9 FANBOX_SHELL wins | ALL PASS |
| `phase3a.js` | H1/D1 `/fs` drive-letter preview + relative assets + `file:///C:/` rewrite, md images in Crepe & read-body, `fsUrl` shape | ALL PASS after fix ① |
| `phase3b.js` | EN Recycle-Bin flow (dialog/toast wording), `report[1].png` / `%USERNAME%.txt` / `it's.txt` / junction deletes; all six verified restorable in the real Recycle Bin, junction target untouched | ALL PASS |
| `phase3c.js` | D7 both ways: `Set-Clipboard -LiteralPath` (Explorer-copy simulation) → `kind:file` paste, NUL-stripped exact path, multi-select first-file, PS `''` quoting; copyFile → real FileDropList incl. bracket + apostrophe names | ALL PASS |
| `phase3d.js` + standalone spawn-log runs | D6 chain: magick (png / multi-frame gif `-delete 1--1` / bracket names) → ffmpeg fallback (argv, spawn-logged) → no-tools 415 with **zero** spawns (no System32 `convert`) | ALL PASS |
| `phase3e.js` | D11 casing refusals (home/AppData/roots any case), casing+trailing-`\` unify to one shadow repo + shared throttle, no litter in project | ALL PASS after fix ② |
| `phase3f.js` | D4: agent cron tab forces PowerShell under a cmd.exe default shell; argv-dump shim proves the `&`/quotes/em-dash prompt arrives byte-exact; shell tasks stay in cmd | ALL PASS |
| `wechat/test-driver.js` + `wechat/test-shim.js` | H2 tree-kill (idle-timeout leaves no orphan), D5 exe probe + npm-shim resolution + CLI-not-found message, §5 quoted-PATH; plus a live `runCodex` end-to-end (“OK”, thread id captured) | ALL PASS |
| `phase3h.js` | Disk panel descend/ascend, up-row hidden at drive root, winDirSizes real sizes, term path links (absolute drive + relative via pty cwd), updater: no offer on older release / offer on newer release with win `.exe` asset | ALL PASS after fix ③ |
| `phase3i-xss.js` | Markdown sanitization gate: payload dead on all five render paths (incl. the ordinary double-click path and both `typeset.js` entries); `onerror` stripped while the `<img>` element survives; `javascript:` / `data:text/html` still blocked; drive-letter image paths still allowed; legitimate document renders unchanged with local images loading; fail-closed when DOMPurify is absent | ALL PASS after fix ④ |

Bugs found by this matrix and fixed on `dev` (all inside win-gated branches;
POSIX text untouched):

1. **`fixLocalImages` (app.js)** — md read-body/follow renderer built
   `/api/raw?path=/C:\…` for every local image on Windows (leading slash +
   mixed separators) → all images 404’d, and the error-fallback deliberately
   skips `/api/` URLs. Now sep-guarded: drive/UNC absolute detection + segment
   folding against the document dir.
2. **`snapReal` (server.js)** — used `fs.realpathSync`, which does not
   canonicalize case on NTFS, so `c:\users\…\proj` and `C:\Users\…\proj` got
   two shadow repos and separate throttle keys. Win arm now uses
   `fs.realpathSync.native`.
3. **`winDirSizes` (server.js)** — the `-Command` fragments were joined with a
   space and the first fragment lacked `;`, a PS parse error → every directory
   size came back null (`—` in the disk panel). Added the missing semicolon.
4. **`mdHtml` drive-letter URIs (app.js)** — found when the matrix was re-run after
   back-porting the markdown sanitizer. DOMPurify reads `C:\pics\cover.png` as a URI with
   an unknown scheme `c:` and strips the `src` — and it does so *before* `fixLocalImages`
   can rewrite it to `/api/raw`, so every absolute-path image in markdown broke on Windows.
   The Windows arm now passes an `ALLOWED_URI_REGEXP` that additionally permits a drive-letter
   prefix, including the `C:%5C` form marked produces via `encodeURI`. Script schemes remain
   blocked, asserted explicitly in `phase3i-xss.js`. POSIX passes no option and is unchanged —
   `/path/to.png` was always on DOMPurify's default allowlist, which is why upstream/macOS
   never saw this.

Environment findings (not code bugs): the tester shell’s
`NoDefaultCurrentDirectoryInExePath=1` breaks winpty’s `GetCommitHash.bat`
during `npm run rebuild` (unset it for the build); node-pty needs the VS
“Spectre-mitigated libs” component (MSB8040) — now listed as a build prereq.

Not covered here: HEIC decode (no fixture; magick chain verified via gif
multi-frame), CJK-username profile (explicitly dropped by the user), installer
self-update end-to-end (needs a published release).

Physical Windows manual matrix passed → `dev` → `windows` merge gate satisfied.

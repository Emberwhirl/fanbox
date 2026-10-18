# Windows port parity acceptance (2026-07)

Campaign for the v2.12.1 Windows-port remediation plan
(`docs/win-port-implementation-plan-v2.12.1.html`).

## What it checks

`verify.js` re-checks that every hunk in `git diff master...HEAD` for the five
core JS files falls into an accepted golden-rule category:

- **(a)** inside an `IS_WIN` / `isWindows()` / `PLATFORM === 'win32'` / `isWin()` guard
- **(b)** pure addition (new win-only helper, new dict keys)
- **(c)** whitelisted one-liner rewrite whose only behavioral branch is behind a platform/sep guard

The scan above is a heuristic: it prints `CHK` lines for a human to review and still exits 0. It only looks
at *added* lines near a guard, so a one-token edit to a line that `master` also has can pass it. v2.17.0 adds
stricter checks beside it; what is **hard** (exit 1) and what stays **heuristic** (exit 0, `CHK`) is exactly this:

**Hard checks (exit 1).** The master compares need a local `master` ref (`git show master:<file>`) and fail
closed without one; CRLF is normalised on both sides.

1. **`lib/claude-statusline.cjs` is pure additions.** It is upstream's status-line bridge, copied verbatim into
   `~/.fanbox/hooks` and run on every status refresh. Any removed or rewritten upstream line is a hard failure.
2. **`electron/main.js` `const REL_PAGE` … `let pendingUpdate` is byte-identical to `master`.** That slice holds
   upstream's `REL_PAGE`, `latestReleaseError` and `fetchLatestRelease` and is the one upstream's own test runs in a vm.
3. **`checkUpdate`'s failure branch equals `master`'s except for the two Windows insertions.** The compared text
   runs from `let info = null;` to `updRetry = 0;`. The expected text is `master`'s segment with the fetch line
   replaced by `IS_WIN ? fetchLatestReleaseWin() : fetchLatestRelease()` and `winUpdateFailureDialog()` placed in
   front of `master`'s `if (manual) {` (which becomes `} else if (manual) {`). The whole POSIX dialog and the
   retry line must match `master` byte for byte.
4. **`server.js` `usageRequest`: the curl selection is pinned and the rest of the function equals `master`.** The
   `const curlExe = …;` line must read exactly
   `PLATFORM === 'win32' ? (winFindExe('curl.exe') || path.join(WIN_SYS32, 'curl.exe')) : 'curl'` (it must begin
   with `PLATFORM === 'win32' ?` and end with `: 'curl'`). With that line removed, the function must equal `master`'s
   after two substitutions: `execFile('curl', ` → `execFile(curlExe, ` and `{ timeout: 14000, maxBuffer: 1024 * 1024 }`
   → the same object plus `env: winSpawnEnv(), windowsHide: true`.
5. **`FANBOX_DICT_RULES` in `public/i18n-dict.js` is anchored.** The dictionary is run in a vm and every regex rule
   must start with `^`, end with an unescaped `$`, carry no `m` flag and have no top-level `|` (`^a|b$` is
   anchored text but matches `b` anywhere before the end). A non-RegExp (legacy string) rule is accepted only if
   `master` already has it. This is stricter than the old position check and also covers rules that were not added
   by this fork.

**Heuristic checks (exit 0, a human reviews each `CHK`).**

- The per-line scan of every added line in the six core files (`electron/main.js`, `server.js`, `public/app.js`,
  `public/i18n-dict.js`, `electron/wechat/driver.js`, `electron/wechat/env.js`) described above. Inside
  `public/i18n-dict.js`, a single-line `[/regex/, (m) => …]` tuple counts as a pure addition (b) only when its line
  number falls between `window.FANBOX_DICT_RULES = [` and the closing `];` of the working-tree file; anything
  else added to the dictionary is still judged by the old rules.
- In `lib/claude-statusline.cjs`, every added behavioral line should be gated: inside `winBash()` / `winLang()`
  (win32-only helpers), inside the `if (bash && …) { … }` block, or itself contain `process.platform === 'win32'`,
  `winBash()` or `winLang()`. The gates are checked too (`winBash()` must start with the platform guard, `winLang()`
  may only be called on a line that tests `process.platform === 'win32'`). A violation is a `CHK` line, not a failure.

`mutation-proof.js` proves the hard checks (see Run). The first four mutations are the ones a reviewer applied to
a clone while the pre-follow-up scanner still printed "All files pass": `} else if (manual) {` →
`} else if (manual && updRetry >= 0) {` in the POSIX failure dialog, a `console.log('x')` inside
`fetchLatestRelease`, the curl ternary changed to `PLATFORM !== 'darwin'`, and an unanchored catch-all rule
`[/已记录/, (m) => "Recorded"]` in `FANBOX_DICT_RULES`.

### Accepted shared edits (v2.16.1) — PR #60 sanitizer deviation retired

Upstream v2.15+ shipped the DOMPurify `mdHtml()` chokepoint, so the v2.12.1 PR #60
Windows-port sanitizer deviation is **retired**. Remaining accepted shared-text edits
this round (classified in `verify.js` whitelist, listed in CHANGELOG `### Windows port`):

1. `autoUpdater.on('error', …)` — an emitted error with no listener throws in main.
2. inert `<template>` `semanticSig()` — a `<div>` would load `<img>` and fire `onerror`.
3. platform-ternary `fsp.rm` `{ maxRetries, retryDelay }` — Windows file locks vs un-awaited `git gc`.
4. optional third parameter on `run()` — Windows thumbnails share the 4-way concurrency gate.

### Accepted shared edits (v2.17.0) — classified in `verify.js`, listed in CHANGELOG `### Windows port`

Upstream 2.17.0 added the Claude Code status-line bridge, the Codex official-quota call and a rewritten
update-failure dialog. The Windows lines went in as parallel branches; the shared text that differs from
`master` is exactly this (plan §6.7, plus two update-code rewrites that predate 2.17.0 and are listed here
for the first time):

1. `lib/claude-statusline.cjs` — **inserted** lines only, all behind `process.platform === 'win32'`. Claude Code
   runs status lines through Git Bash on Windows, never cmd, so the user's own `statusLine` runs via
   `bash -c` (`winBash()`), and the weekly label follows FanBox's language (`7d` in English, `winLang()`).
   Upstream's `shell: true` line stays as the fallback and every upstream statement is unchanged.
2. `electron/main.js` `checkUpdate` — dispatches `IS_WIN ? fetchLatestReleaseWin() : fetchLatestRelease()` and, on a
   failed manual check, `winUpdateFailureDialog()`. Upstream's `REL_PAGE` / `latestReleaseError` /
   `fetchLatestRelease` are **verbatim** (upstream's test slices main.js between `const REL_PAGE` and
   `let pendingUpdate`), so the fork's `WIN_REL_REPO` / `WIN_REL_PAGE` / `hasWinInstallerAsset` live after
   `let pendingUpdate`. This replaces the larger inline divergence 2.16.1 carried at `fetchLatestRelease`.
3. `server.js` `usageRequest` — one platform ternary for the curl path (`winFindExe('curl.exe')`, the exact name, else
   `System32\curl.exe`, an absolute path because the request's stdin carries the OAuth token), plus
   `env: winSpawnEnv()` (returns `undefined` off Windows) and `windowsHide: true` (no-op off Windows).
   Same pattern the fork already used in this spot before 2.17.0.
4. `public/i18n-dict.js` — 33 new keys and 8 `FANBOX_DICT_RULES` tuples for the usage panel and quota
   errors. Additive; macOS English users would get the translations if upstream adopted them.
5. `electron/main.js` `checkUpdate` tail *(from 2.16.1, first listed now)* — `if (newer)` became
   `if (newer && winAssetOk)`, `latestAssets` falls back to `[]` instead of `null` on Windows, and the manual
   "new version" dialog is split into an `IS_WIN` branch and an `else` branch holding the macOS dialog
   unchanged (re-indented).
6. `electron/main.js` `update:download` + `updateAssetCandidates` *(from 2.16.1, first listed now)* — master's
   single-dmg `name` / `url` / `dest` flow became a candidate loop. Off Windows `updateAssetCandidates` returns the
   same one dmg URL and the asset-list guard compares the same basename; on Windows the loop covers the
   exact installer pair behind a fail-closed `exactWinAssetNames` gate.

`preview-guard.test.js` pins the preview server's win32 path gate — the boundary that
keeps a malicious previewed HTML (which runs `allow-same-origin` against the preview
port) from reading `~/.ssh`, `~/.claude` and friends. It replays `previewPathAllowed`'s
win32 branch under `path.win32` with an injectable `realpath`, so it runs on any OS.
The case that motivated it: NTFS 8.3 short names (`.ssh` → `SSH~1`) contain no dot and
sailed straight through the "segment starts with `.`" check.

**When you change `previewPathAllowed` in `server.js`, update the mirrored copy here.**

## Run

```bash
node experiments/winport-parity-202607/verify.js            # golden-rule scan: heuristic CHK lines + hard checks (exit 1)
node experiments/winport-parity-202607/mutation-proof.js    # clones the repo to a temp dir, applies 10 mutations, each must exit 1
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

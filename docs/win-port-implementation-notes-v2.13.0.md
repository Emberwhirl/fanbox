# Windows Port v2.13.0 — Implementation Notes

Live log for `docs/win-port-implementation-plan-v2.13.0.md`.
Defaults from the plan used unless listed under **Deviations**. Branch: `dev`. Started 2026-08-21.

## Status

IN PROGRESS — Gate C ran on physical Windows 11 x64. A sandbox-preload defect found in the Linux-frozen OID was fixed on `dev`; that commit is the new candidate (subject still ends `+ release 2.13.0`). Gates D–E are not started: the plan requires named authorization for `windows` fast-forward, push, packaging, tag, draft, and publication.

## Baseline (revalidated 2026-08-21)

After `git fetch --prune --no-tags` on `github` (Emberwhirl/fanbox) and `upstream` (alchaincyf/fanbox):

| Ref | OID |
|---|---|
| `dev` (pre-merge) | `b5c108595231f06cb44ad0b3c0f00537ca763c2d` |
| `windows` / `github/windows` | `b8b6f707f447ae5b39fe7c476f709be710f27da5` |
| `master` / `github/master` / `upstream/master` | `ca204a2221377b808473fbc1eb0079fce6d8f820` |
| merge base | `ff054e504d87ac4720dcdfcbb8ab7389825fb066` |

- Remotes: `github` = Emberwhirl/fanbox, `upstream` = alchaincyf/fanbox.
- Upstream tag `v2.13.0` → `ca204a2`. No local or fork `v2.13.0` tag.
- Safety refs (unpushed): `refs/safety/dev-pre-v2.13.0-20260821`, `refs/safety/windows-pre-v2.13.0-20260821`.
- Merge commit: two parents, parent 1 = pre-merge `dev` `b5c1085`, parent 2 = `ca204a2`. Only `public/app.js` conflicted.

Linux-frozen OID (superseded by the Gate C preload fix): `43669d9ead44bee0b9b3f456ce9f1be2e3f4570c`. Tested candidate after the fix is the `dev` commit whose subject ends `+ release 2.13.0` (write `RELEASE_CANDIDATE_OID` to Gate B evidence `candidate.txt` after that commit; this file is not edited after freeze).

## Deviations

- POSIX `fixLocalImages` stays on upstream v2.13.0 `/api/raw` rather than the plan's `/fs` wording. Changing POSIX to `/fs` would not be byte-for-byte with `master`.
- `keepImageAlt` / `addImageMoveControls` gained optional trailing arguments in shared `src-vendor/milkdown-entry.js`. POSIX call sites still pass one argument and produce the same HTML/Markdown; the extra args are Windows-only at the `app.js` call site.
- `server.js` skips `listen` when `FANBOX_HELPERS_ONLY=1`. Linux contract tests do not `require('server.js')` because load-time `cronPersist`/`setInterval` would keep the process alive and touch `~/.fanbox`; they drive `spawnGit` / `buildWinReleaseSteps` (the same functions inspect/prepare call) plus a source assertion that `releaseInspect` uses `gitExe()`.
- Production path/asset helpers live in repo-root `win-port-helpers.js` so `server.js` can require them without importing `electron/`.
- Reviewed snapshot listed `dev` at `b8b6f70`; work started from live `dev` `b5c1085` (plan file already committed). Did not reset.
- `releasePrepare` exact `x.y.z` (`$` anchor) is Windows-only; POSIX keeps the existing prefix match.
- This Windows checkout names remotes `fork` (Emberwhirl/fanbox), `origin` (Linux SSH mirror), `upstream` (alchaincyf/fanbox). The plan's `github` remote is `fork` here. Did not rename remotes.
- Gate C reused the v2.12.1 matrix hardcoded `D:\fanbox` / `C:\Users\bbbb\fb-matrix-home` via a directory junction `D:\fanbox` → `E:\fanbox` instead of committing machine-specific `launch.js` edits. Evidence and Playwright-core live outside the repo (`E:\fanbox-gatec-202608\`).
- `fanboxWinPath` is exposed over `ipcRenderer.sendSync` / `ipcMain.on` rather than `require('../win-port-helpers')` in the preload. Electron 20+ defaults `sandbox: true`; a sandboxed preload cannot require repo files, and the throw aborted every bridge after `fanboxDrop` (updater, WeChat, agent, power, path helpers). Helpers still live in `win-port-helpers.js` and are required only from the main process. POSIX `webPreferences` literals are unchanged (no `sandbox: false`).
- Gate C did not install ImageMagick; ffmpeg 9.0 was already on PATH. phase3d “no tools” still got 200 because host PATH kept ffmpeg — not a product fail-open to System32 `convert`.
- phase2 git-language assertion expected English `On branch`; this PC’s OS locale is German, so the match failed. D3 (no `LANG`) passed.
- phase3h Launch B still replaces `"version": "2.12.1"` and expects a `2.7.0` offer (stale v2.12 assumption). Launch A correctly offered nothing from 2.13.0 against published 2.12.1. Did not rewrite the frozen test to chase GitHub’s current latest.
- long-image campaign uses POSIX `HOME=/tmp/...`; export + Typeset modal passed, one local-image inline failed on the `\tmp\...` path. Atlas campaign passed. xterm6 campaign is an already-landed upgrade archive, not re-run.
- Native file-picker dialog, UNC shares, visual 100%/150% theme matrix, and Milkdown move/undo were not driven end-to-end (no UNC share; dialog is OS-modal). Containment/serializer/Typeset/EN/sanitizer ran through production IPC and the editor.

## Gate C environment (2026-08-22)

| Item | Value |
|---|---|
| OS | Windows 11 Pro x64 build 26200 |
| Node | v22.23.2 |
| npm | 12.0.2 |
| Git | 2.55.0.windows.4 |
| PowerShell | 5.1.26100.9168 |
| VS | Build Tools 2022, MSVC 14.44.35207, WinSDK 10.0.26100.0 |
| Spectre | Installed `Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre` during Gate C (MSB8040 otherwise) |
| Python | 3.12.10 (installed for node-gyp) |
| Electron | 33.4.11 |
| node-pty | 1.1.0, `pty.node` rebuilt 2026-08-22 15:01 |
| ffmpeg | 9.0-full_build (Gyan) |
| magick | missing |
| gh | missing |
| Isolated home | `C:\Users\bbbb\fb-matrix-home` |
| Real profile | `C:\Users\yutian\.fanbox` and AppData fanbox dirs absent before and after |

`npm install` then `npm run rebuild` with `NoDefaultCurrentDirectoryInExePath` unset. Live ConPTY proved with unique token `FANBOX_GATEC_<ts>_RT`.

## Gate C campaign results

| Campaign | Result |
|---|---|
| preview-guard | 16/16 pass |
| contract.test.js | 102/102 pass (after preload IPC assertion) |
| prove ConPTY | pass |
| phase2 | 1 fail: git English `On branch` (locale) — ConPTY/busy/D3 pass |
| phase2b | ALL PASS |
| phase3a | preview HTML/CSS/fileurl pass; read-body images pass; 1 crepe img of reconstructed fixture did not load |
| phase3b | ALL PASS |
| phase3c | ALL PASS |
| phase3d | magick+ffmpeg thumbs pass; “no tools” 200 because ffmpeg stayed on PATH |
| phase3e | ALL PASS |
| phase3f | argv dump / second cron tab failed (`.ps1` shim + renderer timeout) — agent tab stayed PowerShell |
| wechat driver | crash: no `codex.exe` on this PC |
| wechat shim | PASS |
| phase3h | disk/path/updater-get pass after preload fix; Launch B stale 2.12.1 rewrite fails |
| phase3i XSS + Typeset modal | ALL PASS |
| phase3j | planted git not executed; notes never in cmd; prepare against trap-repo has no package.json so no dist:win text |
| playwright-electron (v2.13 images) | ALL PASS after preload fix |
| export-longimage | Typeset modal + PNG export pass; 1 local inline fail on `\tmp` HOME; watchdog |
| atlas-pressure | ALL PASS |

Golden-rule `verify.js`: 5 CHK files (main, server, app, wechat/driver, wechat/env) — accepted Windows-gated additions plus the documented sanitizer deviation. `i18n-dict.js` OK.

## Work log

- Gate A: fetched, safety refs, `--no-ff --no-commit` merge of `master`, resolved `app.js` to Typeset modal + Insert image, Windows `Ctrl+S`, Option/iTerm suppressed on Windows, sanitizer retained.
- Phase 2–3: containment IPC, canonical serializer at every native ingress, exact-pair updater, `gitExe()`+`winSpawnEnv()` inspect, notes file only, build-then-pair PowerShell.
- Phase 4: `experiments/win-v213-images-202608/` contract tests require shipped helpers; parity/XSS/audit/long-image campaigns updated for the modal and release contracts.
- Gate B skeptic round: `winLocalImageSrc` joins relative Markdown images to the document directory (no `/api/raw?path=./…`); `resolveGitExe`/`gitExe` return `null` and skip spawn when Windows git is missing, instead of falling back to bare `git`.
- Gate C (this PC): installed Python 3.12 + Spectre libs; `npm run rebuild`; live ConPTY; ran the matrix. Found sandboxed preload `require('../win-port-helpers')` aborting every bridge after `fanboxDrop`. Replaced with `winpath:*` sendSync IPC in main. Filled `playwright-electron.js` so it exits nonzero on failure. Did not fast-forward `windows`, push, tag, package, or publish.

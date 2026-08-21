# Windows Port v2.13.0 — Implementation Notes

Live log for `docs/win-port-implementation-plan-v2.13.0.md`.
Defaults from the plan used unless listed under **Deviations**. Branch: `dev`. Started 2026-08-21.

## Status

IN PROGRESS — Linux candidate freeze (Gates A–B). Gates C–E remain out of authorization for this environment.

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

Tested candidate: the `dev` commit whose subject ends `+ release 2.13.0`. The exact OID is `RELEASE_CANDIDATE_OID` in Gate B evidence (`candidate.txt`) written after that commit; this file is not edited after freeze.

## Deviations

- POSIX `fixLocalImages` stays on upstream v2.13.0 `/api/raw` rather than the plan's `/fs` wording. Changing POSIX to `/fs` would not be byte-for-byte with `master`.
- `keepImageAlt` / `addImageMoveControls` gained optional trailing arguments in shared `src-vendor/milkdown-entry.js`. POSIX call sites still pass one argument and produce the same HTML/Markdown; the extra args are Windows-only at the `app.js` call site.
- `server.js` skips `listen` when `FANBOX_HELPERS_ONLY=1`. Linux contract tests do not `require('server.js')` because load-time `cronPersist`/`setInterval` would keep the process alive and touch `~/.fanbox`; they drive `spawnGit` / `buildWinReleaseSteps` (the same functions inspect/prepare call) plus a source assertion that `releaseInspect` uses `gitExe()`.
- Production path/asset helpers live in repo-root `win-port-helpers.js` so `server.js` can require them without importing `electron/`.
- Reviewed snapshot listed `dev` at `b8b6f70`; work started from live `dev` `b5c1085` (plan file already committed). Did not reset.
- `releasePrepare` exact `x.y.z` (`$` anchor) is Windows-only; POSIX keeps the existing prefix match.

## Work log

- Gate A: fetched, safety refs, `--no-ff --no-commit` merge of `master`, resolved `app.js` to Typeset modal + Insert image, Windows `Ctrl+S`, Option/iTerm suppressed on Windows, sanitizer retained.
- Phase 2–3: containment IPC, canonical serializer at every native ingress, exact-pair updater, `gitExe()`+`winSpawnEnv()` inspect, notes file only, build-then-pair PowerShell.
- Phase 4: `experiments/win-v213-images-202608/` contract tests require shipped helpers; parity/XSS/audit/long-image campaigns updated for the modal and release contracts.
- Gate B skeptic round: `winLocalImageSrc` joins relative Markdown images to the document directory (no `/api/raw?path=./…`); `resolveGitExe`/`gitExe` return `null` and skip spawn when Windows git is missing, instead of falling back to bare `git`.

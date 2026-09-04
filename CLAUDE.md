# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

FanBox — a desktop "cockpit" for coding agents: it runs Claude Code / Codex in xterm.js terminals, tracks every file they change, and lets the user take over. This repo is the **Windows-port fork** (`Emberwhirl/fanbox`) of upstream `alchaincyf/fanbox` (macOS-only).

- Branches: `master` = upstream mirror (never develop here); `windows` = published port line; `dev` = active work. `dev` = upstream release tag + Windows-port commits; expect future work to re-align `windows`/`dev` to newer upstream tags.
- **Golden rule of the port: macOS/Linux code paths stay byte-for-byte unchanged.** Windows behavior is added as parallel branches (`PLATFORM === 'win32'`, `isWindows()`); when merging upstream, POSIX strings are never touched. The README section below the divider is kept verbatim from upstream; only the top (port) section is edited here.
- Releases: merge `dev` → `windows`, bump version, publish a GitHub Release with **both** assets attached at publish time: `FanBox-<ver>-win-x64.exe` (NSIS) + `FanBox-<ver>-win-x64-portable.exe`. The in-app updater downloads the installer by exact asset name and only offers updates when a `FanBox-*-win-*.exe` asset exists (`REL_REPO` is `Emberwhirl/fanbox` on Windows, upstream on macOS). Windows does **not** ship `latest.yml` / blockmap / `SHA256SUMS.txt`; `probeAutoUpdate` returns false before any network so the capsule stays 下载更新.
- Claude Code one-click launch on Windows appends `--settings` with a quoted absolute HTTP hook file under `~/.fanbox/hooks/` (token only in process env / headers). Codex notify is omitted unless `node.exe` is present. Terminal maximize is `Ctrl+Alt+M`.

## Commands

```bash
npm install
npm run rebuild        # electron-rebuild for node-pty — REQUIRED after npm install / Electron bump; without it the app runs but terminals are dead
npm run app            # Electron dev (full desktop app)
npm start              # node server.js — web-only mode at http://localhost:4567 (no terminals; /api/agent/* returns 501)
npm run dist:win       # NSIS installer + portable exe → dist/ (needs VS Build Tools for node-pty)
npm run dist           # macOS signed+notarized arm64 dmg (APPLE_KEYCHAIN_PROFILE=fanbox-notary)
npm run build:milkdown # rebuild public/vendor/milkdown from src-vendor/milkdown-entry.js
npm run build:hljs     # rebuild public/vendor/hljs + copy marked/hljs css
```

- No test framework. Verification habits used in this repo: `node --check` on every touched JS file; server smoke test `FANBOX_NO_OPEN=1 FANBOX_PORT=45991 node server.js` then curl `/`, `/api/skills/builtin`, `/api/agent/terminals` (expect 501 without Electron).
- Hard bug fixes leave a dated Playwright-drives-Electron campaign in `experiments/` (run e.g. `node experiments/atlas-pressure-202607/verify.js` with a fake `HOME`). Acceptance tests for hard fixes get preserved there — follow that convention.
- WeChat bridge can be exercised without Electron: `node electron/wechat/test-server.js` → http://localhost:8848.
- Electron download blocked in China: prefix with `ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/"`.

## Architecture

### Process model — no WebSockets, no bundler, no framework

Three pieces, two channels:

- **`server.js`** (~2700 lines, single file) — HTTP backend using **only Node built-ins, zero npm deps**. It is also the `fanbox` CLI bin; `require()`-ing it starts the listener, which is exactly how `electron/main.js` boots it **in-process** (`require('../server.js')` — it does not spawn it). It must run standalone as the web version, so it **must never `require` anything under `electron/`**. `parseWinProxyServer` exists as a deliberate twin in both `server.js` and `electron/wechat/env.js` — change one, sync the other (each carries a comment pointing at its twin).
- **`electron/main.js`** — main process: windows, node-pty terminals (login shell on POSIX; ConPTY + registry-PATH merge on Windows), multi-dir `fs.watch`, clipboard, update check, `.cast` recording of every PTY stream.
- **`public/app.js`** (~5000 lines, single file) — the whole SPA. Plain JS, no modules, no build step; shares one global scope with `i18n.js`/`i18n-dict.js`; script load order in `index.html` matters. Everything is vendored in `public/vendor/` (committed; app is fully offline — the only outbound calls in the whole product are the Claude usage API and the GitHub release check).

Frontend↔backend channel 1 is HTTP REST to `server.js` (helpers `api()`/`apiPost()`). Channel 2 is Electron IPC via `electron/preload.js` context bridges — `window.fanboxPty`, `fanboxFs`, `fanboxWechat`, `fanboxAgentCtl`, etc. (channel naming `domain:action`, e.g. `pty:spawn`). In browser mode the `fanbox*` bridges are absent and features degrade; every vendor `<script>` failure sets a `window.__no*` flag that features check.

### Two loopback HTTP servers + security model

- Main server on `127.0.0.1:4567` (`FANBOX_PORT`): static `public/`, `/api/*`, `/fs/<abs path>` mirror.
- Preview server on PORT+1: GET/HEAD, `/fs/` only, `$HOME` subtree only, rejects dot-segments. HTML previews render in iframes pointed at this second origin so sandboxed pages (`allow-same-origin`) can run scripts but can never reach app DOM or `/api`. Never grant preview iframes more than this.
- When adding routes: Host header validated (`hostAllowed`, anti DNS-rebinding); **all mutating endpoints are POST** and all POSTs pass `originAllowed` (non-loopback Origin rejected). `resolvePath()` deliberately does no path sandboxing beyond NUL rejection — local personal tool philosophy.
- All writes are atomic (temp + fsync + rename). `/api/write` takes `expectedMtime` and returns `{conflict:true}` for optimistic locking. `~/.fanbox/config.json` is mutated only through `updateConfig()`, which serializes read-modify-write on a promise chain.

### Agent cross-control (`/api/agent/*`, docs/12 — the v2.7.0 headline feature)

Routes live in `server.js`, but the capability object is injected by `electron/main.js` as **`global.__fanboxAgent`** (`{token, list, read, send, create, wait, kill}`); without it the routes return 501. The auth token is generated per launch, never written to disk, and injected only into FanBox-spawned PTY envs (`FANBOX_CTL`, `FANBOX_CTL_TOKEN`, `FANBOX_TERM_ID`) — so only agents inside FanBox terminals can control sibling terminals. Semantics worth knowing: `send` converts `\n`→`\r` and auto-submits unless `submit:false`; `wait` supports `until` regex (matches only output after the wait started), `idle:'quiet'`, and caps at 240s; `create` opens a real visible tab (deliberately not headless); controlled tabs flash ⚡. The bundled skill `skills/fanbox-agent/SKILL.md` teaches this protocol and is **kept byte-identical to upstream — do not fork its content** (decision D3-A).

### File-change tracking — git-based, not fs-watcher-based

- Real git repos: `/api/git` (`status --porcelain`) + `/api/git-file` (HEAD vs working copy) rendered in a Monaco DiffEditor.
- Non-git dirs get **shadow snapshots** ("回合安全带"): on every idle→busy terminal transition the frontend POSTs `/api/snapshot`; the server commits into a detached git dir under `~/.fanbox/snapshots/` (`--git-dir X --work-tree <project>` — nothing written inside the project). Tags pruned to 40; 15s throttle per project; restore auto-snapshots current state first. `snapEligible()` refuses `$HOME`, drive roots, and system dirs with careful per-platform depth rules — don't weaken it. `/api/git-file` falls back to snapshot diffs so line diffs work everywhere.
- Live change *display* is separate: `fanboxFs.watchSet` (fs.watch in main) drives the changes inbox, card heat, and file-follow mode in the frontend.

### Agent observability

`server.js` reads both CLIs' logs directly from disk: Claude Code `~/.claude/projects/<munged-cwd>/*.jsonl`, Codex `~/.codex/sessions/**/rollout-*.jsonl` — token usage (incremental byte-offset parsing with caches), per-project session memory, and skill scanning across 5 roots. Skill enable/disable is implemented by moving the dir into a `_disabled/` sibling (official `skillOverrides` is broken). `claudeOfficialLimits()` is the server's only outbound call and must go through **system curl, not Node https** (the endpoint blocks Node's TLS fingerprint).

### WeChat bridge (`electron/wechat/`)

Remote-controls local claude/codex from a phone via a self-implemented Tencent iLink protocol client (`ilink.js`; attribution in docs/08). `bridge.js` funnels desktop input and phone messages through one `runAgent` path; `driver.js` runs headless `claude -p --output-format stream-json` / `codex exec --json` with session-rotation-based compaction; `env.js` replicates the user's login-shell environment (GUI apps get a stripped env). State under Electron `userData/wechat/`; long-term memory at `~/.fanbox/memory/MEMORY.md`.

### Frontend specifics that bite

- **i18n: Chinese is the source language.** All UI strings in `app.js` are written in Chinese; a MutationObserver translates the DOM in EN mode using `i18n-dict.js` (keys are the exact Chinese strings). Any new UI string must be Chinese in `app.js` **and** get an entry in `i18n-dict.js`, or EN users see Chinese.
- Terminal busy/idle is a heuristic state machine (echo filtering via `lastInput`, quiet thresholds, `TERM_ASK_RE` matching Claude Code/Codex approval-prompt phrasings — these break when the CLIs change wording).
- WebGL glyph atlas is shared across tabs; the CJK-corruption workaround (`atlasCare`/`recycleWebgl`) must clear/rebuild **all** tabs' atlases in the same tick. Regression suite: `experiments/atlas-pressure-202607/`.
- Monaco/Crepe editors: always `mona.disposeIfAny(); crepe.disposeIfAny()` when swapping preview content (worker leak). Autosave is an 800ms-debounced promise chain through `/api/write` with conflict handling; `guardDirty()` must be awaited before any navigation.

## Windows-port coding rules (load-bearing — from implementation-notes.md)

- **Never build cmd/PowerShell command strings containing user data.** Spawn argv-style, no `shell:true`; pass directories via spawn `cwd`, not as arguments (cmd quoting is unfixable through libuv).
- **Never parse `where.exe`/`Get-Command`/`reg.exe` output** — OEM codepage mangles non-ASCII paths (e.g. `C:\Users\小雨`). Use the pure-Node PATH walk `winFindExe()` (honors PATHEXT); when PowerShell output must be parsed, Base64(UTF-8)-wrap it on the PS side (see `env.js dumpShellEnv`).
- npm shims are resolved to their `node_modules/...js` entry and run with real `node.exe` (or Electron with `ELECTRON_RUN_AS_NODE=1`) — see `driver.js resolveWinCli()`. Kill process trees with `taskkill /PID <pid> /T /F` (orphaned agents burn tokens).
- Windows busy-detection: node-pty's `p.process` is static on win32, so "busy" = shell has direct child processes (`winPtyBusy`, one cached CIM query); tri-state where **null/unknown counts as busy** — never type into a running program.

## Conventions

- **CHANGELOG.md** (Keep a Changelog, Chinese): add entries to `[Unreleased]` as you code; at release rename it to `[X.Y.Z] - date`, bump `package.json`, single commit ending in `+ release X.Y.Z`. Fork work goes under a `### Windows port` subsection inside the version entry — never blended into upstream's sections. Entries are root-cause narratives, not one-liners.
- Commits: conventional-commit prefix + Chinese subject (`fix: …——…`), issue refs as `(#NN)`.
- **Vendor files** (`public/vendor/`) are committed. Before touching any, read `docs/06-vendor补丁.md`. Currently no active patches; if one is ever needed, the pattern is: minified in-place edit + `FANBOX-PATCH` header comment + a `check:vendor-patch` script wired into `predist`. milkdown/hljs are rebuilt via npm scripts; xterm files are hand-copied per the checklist in `experiments/xterm6-upgrade-202607/README.md`.
- `docs/` holds the numbered Chinese design docs; features reference their doc from the CHANGELOG (agent control → docs/12, WeChat → docs/07-09, Windows port → docs/10). `docs/09` and `docs/11` are largely unimplemented design/roadmap — don't treat them as current behavior. `design-demos/` are static HTML style mockups, never imported by the app.
- Product boundary (docs/02): not a file manager, not an IDE — "find → preview → light edits → command the agent"; no cloud, accounts, plugins, or LSP.

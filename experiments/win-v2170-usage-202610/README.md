# Windows port v2.17.0 usage + status-line campaign (2026-10)

Acceptance campaign for `docs/win-port-implementation-plan-v2.17.0.html`, section 3 (the U / S / W / R / X / G cases). It covers the three things 2.17.0 changed on Windows:

- the **status-line bridge** (D1/D2): FanBox-launched Claude Code gets a `statusLine` in the hook file, run through Git Bash, label follows FanBox's language;
- the **richer Agent 用量 panel** (D3/D4): Codex official data, token breakdown, English text for everything new, no freeze on large log folders;
- the **watcher burst fixes** and the **localized update-failure dialog** (D5).

Linux checks gate the candidate; the Windows scripts are the physical-PC part and are not gating on Linux (they print `SKIP`).

## Files

| File | What |
|---|---|
| `contract-bridge.test.js` | Linux `node --test`: `winStatusLineCommand`, `winGitBash`, `writeHookFiles` (Windows branch, sliced out and run with fakes), the bridge with an injected platform, D2 label |
| `contract-i18n.test.js` | Linux `node --test`: English coverage of the usage panel and the update dialog strings |
| `ui-usage-en.cjs` | Playwright browser check (Linux or Windows): `#usage-body` has no CJK in English mode |
| `playwright-electron.js` | Windows: drives the dev Electron app (see the case table); `--dry` runs its platform-neutral pieces anywhere; `--launch` starts the app in an isolated profile for the manual cases |
| `gen-fixtures.js` | Fixture generators, also standalone: Claude log tree (default 500 MB), Codex sessions, W1/W2 burst writer |

## The Linux part

```bash
npm test                                                     # upstream suite, 14/14
node --test experiments/win-v2170-usage-202610/contract-bridge.test.js experiments/win-v2170-usage-202610/contract-i18n.test.js
node experiments/win-v2170-usage-202610/playwright-electron.js --dry
```

`--dry` runs: argument parsing, case selection, the PATH / environment builder (profile redirection, Git hidden), the fake-home safety guards, the process-census parser, the dictionary reader, the three generators checked against `lib/agent-tokens.js` (the scan must reproduce the generator's ground truth to the token), the burst writer, `node --check` of every file the harness writes at run time, the hide-Git preload run against a fake `child_process`, and the **stand-in `claude` against the real bridge** with `bash -c` and a local HTTP server standing in for FanBox (checks the output line, the exact POST body and token header, the hook headers, timing). Expect `RESULT: ALL PASS`.

The browser check runs against the web build with a fake HOME, so nothing real is read:

```bash
mkdir -p /tmp/fb-home && HOME=/tmp/fb-home FANBOX_NO_OPEN=1 FANBOX_PORT=45993 npm start &
NODE_PATH=<dir>/node_modules FANBOX_UI_URL=http://localhost:45993 PW_CHROMIUM=<path to chromium or chrome-headless-shell> \
  node experiments/win-v2170-usage-202610/ui-usage-en.cjs
# the same fixtures as the Windows run, in zh and en, against the same server:
NODE_PATH=<dir>/node_modules FANBOX_UI_URL=http://localhost:45993 PW_CHROMIUM=<...> \
  node experiments/win-v2170-usage-202610/playwright-electron.js --dry --dry-ui
```

`NODE_PATH` must point at a directory that contains `playwright-core`. If headless Chromium never paints (`requestAnimationFrame` never fires, screenshots time out) check for a stale `DISPLAY` (dead X11 forwarding): run with `env -u DISPLAY`. The English fixture pass reads `public/i18n-dict.js` at run time. If a future upstream string has no English entry yet, the pass fails and its message names every missing key. Sandboxes whose Chromium never fires `requestAnimationFrame` even without `DISPLAY` may also need `PW_CHROMIUM_ARGS=--disable-software-rasterizer` for `ui-usage-en.cjs`.

## The Windows part

Prerequisites: Windows 11, **Git for Windows** (the status line needs `bash.exe`), Node 22+, VS Build Tools with the Spectre-mitigated libs (node-pty), a checkout at the candidate commit with `npm install` and `npm run rebuild` done (unset `NoDefaultCurrentDirectoryInExePath` in the shell that rebuilds), and `playwright-core` installed **outside** the repo:

```powershell
mkdir E:\pw; cd E:\pw; npm init -y; npm i playwright-core
```

Everything below runs from the checkout in PowerShell:

```powershell
$env:NODE_PATH = "E:\pw\node_modules"
$env:FANBOX_V2170_BASE = "E:\fanbox-v2170"          # short, writable, NOT inside OneDrive / a synced folder; fake homes live below it
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

node experiments\win-v2170-usage-202610\playwright-electron.js --dry            # 10 s sanity (needs Git Bash for the stand-in part)
node experiments\win-v2170-usage-202610\playwright-electron.js --only S1,S5,S6  # status-line family, ~6 launches
node experiments\win-v2170-usage-202610\playwright-electron.js --only UF,R1,X1
node experiments\win-v2170-usage-202610\playwright-electron.js --only W
node experiments\win-v2170-usage-202610\playwright-electron.js --only U6        # generates ~500 MB; add --claude-mb 100 for a quick run
node experiments\win-v2170-usage-202610\playwright-electron.js --only S2 --soak 10   # 10 minute stand-in soak
node experiments\win-v2170-usage-202610\playwright-electron.js                  # every automated case, then the MANUAL reminders
node experiments\win-v2170-usage-202610\playwright-electron.js --launch         # isolated profile for the manual cases
node experiments\win-v2170-usage-202610\playwright-electron.js --clean          # delete the fake homes it created (including --launch profiles and their sign-ins)
```

Other flags: `--lang zh|en|both` (S1/R1), `--keep` (reuse the fake homes), `--out <dir>`, `--port <n>` (default 4770, a free pair is picked per launch), `--manual` (always print the manual reminders), `FANBOX_V2170_VERBOSE=1` (full detail on every line). Do not touch the FanBox window or minimize it during U6 and W (about 3 minutes in total): the frame-gap measurements need it visible. The harness passes `--disable-features=CalculateNativeWinOcclusion` and turns background throttling off, but a covered or minimized window still distorts the numbers.

**Isolation.** Every launch gets a fake home below `FANBOX_V2170_BASE` with `USERPROFILE`, `HOME`, `HOMEDRIVE/HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and Electron's `--user-data-dir` redirected into it, so the real `~/.fanbox`, `~/.claude`, `~/.codex` and `%APPDATA%\FanBox` are never read or written. The harness refuses a fake home that is, or contains, your real profile; it only ever deletes directories carrying its own `.fanbox-campaign-home` marker file. Every Electron tree it starts is killed with `taskkill /PID <pid> /T /F` (never by image name).

**Evidence** goes to `<base>\evidence\<timestamp>\`: `results.json`, `environment.json` (commit, versions), screenshots, `standin-result-*.json` (stdout, exit code and timing of every status-line run, token never recorded), `processes-*.json`, `u6-perf.json`, `w1-perf.json`, `r1-dialogs.json`, terminal tails on failures.

### Which plan cases run how

| Case | Automated by | Notes |
|---|---|---|
| **S1** | `--only S1` (zh and en) | Stand-in `claude` placed first on the PTY PATH (after FanBox's registry PATH merge, which otherwise would put a real `claude` in front). One-click launch types the real command; the stand-in reads `--settings`, runs `statusLine.command` through the real Git Bash (`bash.exe -c`, located like `winGitBash`) with sample status JSON, the bridge POSTs to the live server. Asserts: output `5h 23% · 周 42%` (zh) or `5h 23% · 7d 42%` (en), exit 0, each refresh under 1 s (warn 1 to 2 s, fail 2 s or more), `/api/agent-usage` source `statusline`, panel source line `CLI实时回传` (en: the dictionary's English), no second window, no extra main process, hook file token-free. **Not covered: Claude Code itself** (manual S2/S3). |
| **S2** | `--soak N` (stand-in), manual (real CLI) | Soak: a refresh every 5 s for N minutes, per-minute process census. The 10-minute real Claude session stays manual. |
| **S3, S4** | manual | Need your own scripts / the real CLI. |
| **S5** | `--only S5` | Git hidden from FanBox (see assumption 6): hook file has no `statusLine`, bridge not copied, one-click still starts the stand-in, Claude quota stays on the official-API path. Reports `SKIP` (not FAIL) if Git cannot be hidden. |
| **S6** | `--only S6` | `<base>\fanbox test\用户` passes S1; `<base>\fanbox test\o'brien` gets no `statusLine` and no bridge copy. |
| **U1, U2, U3, U5, U7** | `--only UF` | Generated Codex sessions + no `auth.json` give the real 会话快照 / 未找到Codex登录凭证 flow (U2) and ground-truth token totals; fixtures drive `usagePanel.render` for Pro weekly-only, Plus dual windows (stale one shown as 待更新), stale `上次成功值` + error, snapshot fallback, CLI-live Claude, the seven error strings; both expanders open and survive a re-render (U5); the app's own language toggle then repeats everything in English with a CJK scan of `#usage-body` and the dictionary's English per string (U7). Real network and logins (U1, U3, U4) stay manual. |
| **U5 (timer)**, **U6** | `--only U6` | 500 MB tree: 正在统计本地token… appears, numbers arrive and equal the ground truth, worst `requestAnimationFrame` gap <= 500 ms (warn above 250), terminal echo probe <= 1 s (warn above 500 ms) while the stats run; then both expanders must survive a real 60 s refresh. |
| **W1, W2, W4** | `--only W` | 2,000 files in 8 s from a child process: frame gaps, echo latency in another tab, folder card heat, 本回合 entries and badge, burst-done.txt card within 2 s (warn to 3 s); 100 identical rewrites give at most one notification per 400 ms window (ideally 1); `node_modules` write silent; `sub\a.ts` lights up `sub`; Recycle Bin delete (shell API, the call FanBox itself uses) shows as a change. **W3** (read-only open) is manual. |
| **R1** | `--only R1` | Proxy pointed at a dead port, `dialog.showMessageBoxSync` and `shell.openExternal` replaced in the main process, the real 检查更新… menu item clicked. Per language and per choice: message, buttons (`打开下载页`/`关闭` or `Open download page`/`Close`), `detail` = reason + `https://github.com/Emberwhirl/fanbox/releases/latest`, no CJK in English, button 0 opens exactly that URL once, Close opens nothing. **R2** is manual (needs a published release). |
| **X1** | `--only X1` (cheap subset) | Hook file shape (eight HTTP hooks, no token literal, `x-fanbox-token: $FANBOX_CTL_TOKEN`), typed Codex command has no `-c notify`, fake Codex receives `notify=[...]` as one intact argv slot (with a `&`/quote prompt), hooks round trip with the stand-in, permission prompt lights the tab and the 指挥台, `Ctrl+Alt+M`. The rest of X1 (quit rules, snapshot rollback, Markdown XSS) = rerun the 2.16.1 scripts, see MANUAL `X1b`. |
| **G1-G3** | manual | Packages. |

### Manual cases (printed by the script; steps are the same here)

Start the isolated profile for them with `node experiments\win-v2170-usage-202610\playwright-electron.js --launch` (persistent: sign-ins survive; the console prints the profile folder).

- **S2 (real)**: in the `--launch` profile sign Claude Code in (`claude /login` in a FanBox terminal), one-click 启动 Claude Code (add `--debug` for the log), keep it working about 10 minutes with Task Manager open. No second FanBox window ever, no extra FanBox.exe / electron.exe, each status refresh in the debug log under 1 s.
- **S3**: in `<profile>\.claude\settings.json` set `statusLine` to `~/.claude/statusline.sh` (a bash script printing a marker) and restart the session; then to `powershell -NoProfile -File C:/path/statusline.ps1`. Your script's text replaces the quota text both times; the panel still gets live numbers.
- **S4**: type `claude` yourself in a FanBox tab. As in 2.16.1; no FanBox quota line.
- **U1**: sign Codex in inside the profile and open Agent 用量. Plan name shown, a weekly window reads 周额度 (never 5h), source 官方数据. If it shows 会话快照 with an HTTP code, note the code (answers the `curl.exe` question, D3). Rename `<profile>\.codex\auth.json` away and back for the real-login U2.
- **U3**: with U1 working, disconnect the network, wait for a refresh (up to 60 s), reconnect: old numbers stay marked 上次成功值 with the reason, values recover.
- **U4**: Windows system proxy on, no `HTTP(S)_PROXY` variables, FanBox started from the Start menu: Claude and Codex official data still load.
- **W3**: only open and read a file (preview, Explorer): no "changed" marker, nothing in 本会话变更.
- **R2**: after publishing, the pretend-2.16.1 build offers 2.17.0 with 下载更新 (only when both exact files exist); 2.17.0 reports up to date.
- **X1b**: `node experiments\win-v2161-hooks-202609\playwright-electron.js`, `...\gatec-process-files.js`, `node experiments\winport-parity-202607\matrix\phase3i-xss.js` (set `FANBOX_MATRIX_ROOT` / `FANBOX_MATRIX_HOME` for your machine, see their READMEs).
- **G1** install the NSIS build into a path with spaces and Chinese characters, run the portable from another drive: both start, About shows 2.17.0, S1 passes from both. **G2** `npx asar list <install>\resources\app.asar`: `lib/` has its three files, `tests/`, `发布/`, `docs/`, `experiments/` absent, token breakdown present in the packaged build. **G3** install over 2.16.1, then uninstall: no duplicate shortcuts, profile kept, `~/.fanbox` kept.

### Harness assumptions (a case failing for these reasons is a harness problem, not a product failure)

1. **Git for Windows is installed** and `winGitBash(process.env)` finds it. Otherwise S1/S2/S6 report `SKIP` ("prerequisite missing"), not FAIL.
2. **The stand-in wins `claude` resolution.** FanBox merges the registry PATH in front of the launch PATH at startup, so the harness prepends the stand-in directory to the main process PATH after startup (PTYs copy `process.env` at spawn). A PowerShell profile that defines a `claude` alias/function or rewrites PATH would still beat it; the harness checks the first `claude` on PATH and fails that check loudly, and the terminal tail is saved.
3. **The default shell is PowerShell** (`FANBOX_SHELL` and `SHELL` are removed from the launched environment).
4. Timing and latency thresholds (refresh 1 s / 2 s, frame gap 250 / 500 ms, keystroke echo 500 ms / 1 s, list catch-up 2 s / 3 s) are heuristics; the first status run after a reboot or with aggressive antivirus can exceed 1 s and is reported as WARN. Put `FANBOX_V2170_BASE` on a fast, non-synced, ideally antivirus-excluded folder.
5. The echo probe types `zq<n>` followed by `Esc` into the prompt (clears the line in PSReadLine and cmd).
6. **S5 needs a hidden Git.** FanBox's registry PATH merge would bring Git back, so the harness loads a tiny `-r` preload into the Electron main process that filters Git directories out of that one PowerShell call, empties `ProgramFiles` / `ProgramW6432`, and unsets `CLAUDE_CODE_GIT_BASH_PATH`. If FanBox's merge code changes shape and Git stays visible, S5 reports `SKIP` with the reason; do it by hand then (rename the Git folder, relaunch, rerun S5).
7. **R1** relies on the File menu item label `检查更新…` / `Check for Updates…`, `net.fetch` honouring the default session proxy, and the dialog `detail` being exactly two lines.
8. **W** uses the real Recycle Bin of the drive that holds `FANBOX_V2170_BASE` (one small file, empty it afterwards). On a drive without a Recycle Bin the delete is permanent and still counts as a change.
9. The process census uses `Get-CimInstance Win32_Process` (PowerShell 5.1); if it returns nothing the check degrades to `tasklist` with a WARN.
10. Ground-truth token totals are only compared strictly when the fixture is less than 12 minutes old (window edges are avoided by 20 minutes, local midnight and timezone are handled).
11. Ports `4770+` (pairs) must be free; the harness picks free pairs itself.

## Results (fill in)

| | |
|---|---|
| Candidate commit | |
| Windows build (`winver`) | |
| Node | |
| Git for Windows | |
| Claude Code (`claude --version`) | |
| Codex (`codex --version`) | |
| Run date / tester | |
| Evidence folder | |

(`environment.json` in the evidence folder has most of these.)

| Case | How | Result (PASS / FAIL / SKIP) | Notes |
|---|---|---|---|
| U1 Codex official data + plan name | manual (+ fixture in UF) | | |
| U2 no auth.json -> 会话快照 | UF (real flow, no login) | | |
| U3 offline keeps 上次成功值 | manual (+ fixture in UF) | | |
| U4 system proxy | manual | | |
| U5 expanders survive refresh | UF + U6 | | |
| U6 500 MB log folder | U6 | | |
| U7 English, no Chinese | UF + ui-usage-en.cjs | | |
| S1 quota line + CLI实时回传 (zh / en) | S1 | | |
| S2 10 min, no second window, < 1 s | S2 soak + manual | | |
| S3 own statusLine wins | manual | | |
| S4 plain `claude` | manual | | |
| S5 Git removed | S5 | | |
| S6 space + CJK home, apostrophe home | S6 | | |
| W1 2,000-file burst | W | | |
| W2 100 identical rewrites | W | | |
| W3 read-only open | manual | | |
| W4 Recycle Bin / node_modules / sub\a.ts | W | | |
| R1 offline update check (zh / en) | R1 | | |
| R2 update offer after publishing | manual | | |
| X1 regression smoke | X1 + 2.16.1 scripts | | |
| G1 install paths | manual | | |
| G2 package audit | manual | | |
| G3 upgrade / uninstall | manual | | |

A failed or skipped required case stops the gate (plan section 3).

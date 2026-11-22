# FanBox 2.20.1 Windows port — manual test checklist

Automated already (re-run any time):

| Suite | Command | Last result |
|---|---|---|
| Upstream tests (Windows-safe) | `npm run test:win` | 82/82 |
| 2.20.1 contracts (Linux-runnable) | `node --test experiments/win-v2201-reach-202611/contract.test.js` | 13/13 |
| Live shells (PowerShell 5.1, cmd, Git Bash) | `node experiments/win-v2201-reach-202611/live-windows.js` | all ok (also reproduces the cmd-metacharacter limit) |
| Electron campaign (isolated profile) | `$env:NODE_PATH = "E:\pw\node_modules"; node experiments\win-v2201-reach-202611\playwright-electron.js` | 14/14 PASS (incl. English-mode render of the new panels, background `/create`) |
| Packaged build (after `npm run dist:win`) | `$env:NODE_PATH = "E:\pw\node_modules"; node experiments\win-v2201-reach-202611\packaged-smoke.js` (optional exe path argument; the portable stub can't be driven by Playwright) | 6/6 PASS on `dist\win-unpacked` built from `4a825c6`; portable checked by hand: backend, asar-read launchers, hook file OK |
| Earlier campaigns | `node --test experiments/win-v2170-usage-202610/contract-bridge.test.js experiments/win-v2170-usage-202610/contract-i18n.test.js`, `node experiments/win-v2161-hooks-202609/contract.test.js`, `node experiments/win-v213-images-202608/contract.test.js` | 67 / 100 / 106 pass |
| Parity scanner | `$env:PARITY_BASE = "v2.20.1"; node experiments/winport-parity-202607/verify.js` | exit 0, no CHK |

**Manual result (2026-11-22):** the user ran this checklist against the 2.20.1 build from `4a825c6`; all steps passed.

Start the dev app from the repo root with `npm run app`. Claude Code steps need a logged-in `claude` (`claude` → `/login`).

## A. Terminals and the new settings

1. Settings (slider button next to the agent buttons) shows an **提醒** block: 系统通知, 断线自动续跑, 窗口互通, 离开时叫我, 飞书. Toggle each; toasts appear; restart FanBox and the toggles persist.
2. Switch FanBox to English: every row, tooltip, flag and toast above is English (no stray Chinese).
3. Sidebar: **离开时叫我** row under the stay-awake switch; hover card says where messages would go; flipping it here also flips it in Settings.
4. 系统通知 off → on: a Windows toast notification "FanBox 系统通知已开启" appears; the in-app toast mentions Windows Settings › System › Notifications (not macOS).
5. Agent list (Settings): DeepSeek Harness after Codex (unchecked), ZCode is a CLI entry, WorkBuddy is gone.

## B. fanbox-notify (no channel connected yet)

6. In a PowerShell tab: `fanbox-notify '测试一下'` → prints `{"ok":false,...,"why":"no_channel","note":"用户没有连微信或飞书…"}` with **readable Chinese**; `$LASTEXITCODE` is 2; `chcp` shows the same code page before and after.
7. Same in a Git Bash tab (`echo $?` → 2) and in `cmd` (`echo %ERRORLEVEL%` → 2).
8. Known limit, reproduced by `live-windows.js`: from PowerShell `fanbox-notify 'a>b'` creates a file named `b`, and `fanbox-notify 'ok&hostname'` runs `hostname` (cmd re-parses a no-space argument). Use Git Bash or avoid `& | < > ^ %`.

## C. Feishu (optional, needs a Feishu group bot)

9. Settings › 飞书: paste the webhook URL (+ secret if signing is on) → the group receives "FanBox 已连上这个群…".
10. In a FanBox PowerShell tab run `Start-Sleep 150; fanbox-notify '离开测试'` and don't touch keyboard or mouse until it finishes → the group receives `「<folder> tN」离开测试`. Run `fanbox-notify '在电脑前'` right away instead → it stays on the desktop (toast only).

## D. Window relay with real Claude Code

11. Open two one-click Claude Code tabs in the **same project folder** (try one opened with a different-case `cd`). In tab A say "以后这个项目都用 pnpm". In tab B send any prompt: Claude B mentions it noticed the pnpm instruction; FanBox shows a toast "已把「…」里你说的 1 句话转告给「…」".
12. Two Claude tabs opened in the home folder, or at `C:\`: nothing is relayed between them.
13. Settings › 窗口互通 off: nothing relayed; on again: words said while off are not replayed.
13b. Mid-turn relay (PostToolUse): while Claude B is busy editing files, say something new in A; B should mention it before its turn ends (it arrives after B's next tool call).

## E. 指挥台 / roster

14. With 2+ sessions, one Claude waiting for input: the roster row shows "等了 N 分钟" after a minute and a reply box; type a reply + Enter → it reaches that Claude and submits (no tab switch).
15. `Ctrl+Alt+L` jumps through waiting sessions in queue order (permission prompts first).
16. Ask Claude (with the fanbox-agent skill) to open a new FanBox terminal while you type in another tab: the new tab opens in the background, your focus and typing stay where they were; with the terminal panel collapsed you get a toast instead of the panel popping open.

## F. Auto-resume (optional, hard to trigger)

17. **Unverified on ConPTY — please try.** Mid-turn in a one-click Claude Code tab, disconnect the network until Claude shows a connection error, reconnect. About a minute later FanBox should type `继续` and show a toast. If nothing happens, note it (ConPTY repaints with cursor moves, so the error-line detection may never match; it should never type while you have text in the input box). A `claude` you type yourself is not tracked on Windows.

## G. WeChat always-on (optional, needs WeChat ClawBot)

18. Connect WeChat, brain = Claude Code. Ask from the phone: "半小时后帮我看看测试跑完没" → reply ends with a ⏰ receipt. Ask "盯着 <repo> 的新 issue" → reply shows the exact watch command; it runs (Git Bash if installed) without "CLI not found".
19. Re-scan the QR code after logging out on the phone: messages from the phone arrive again (2.20.1 fix).

## H. Keyboard (#66 punctuation, now cross-platform)

20. In a terminal tab type `,.?;:'"!` with the English keyboard, then `，。？；：“”！……——` with Microsoft Pinyin (Chinese punctuation mode). Every character arrives once, nothing doubled or lost. If you have an AltGr layout (e.g. German), `@ { [ ] } \ |` still work.

Report anything that fails with the step number; screenshots of EN-mode leftovers help.

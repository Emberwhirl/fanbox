# Windows port v2.16.1 hooks campaign (2026-09)

Linux contract: `node experiments/win-v2161-hooks-202609/contract.test.js`

Drives shipped `win-port-helpers.js` (HTTP hook JSON, flag builders, joinPath/splitRel, snap trailing-sep, updater predicates, localImageAbs) plus source assertions on `server.js` / `electron/main.js` / `public/app.js` / `package.json`.

`playwright-electron.js` is a Gate C fixture (physical Windows). Not gating on Linux.

## Gate C on Windows (run from the checkout, playwright-core out of tree)

```
set FANBOX_MATRIX_HOME=E:\fanbox-gatec\home        (must contain AppData\Roaming and AppData\Local)
set NODE_PATH=<dir>\node_modules                    (playwright-core)
node experiments/winport-parity-202607/matrix/setup-fixtures.js
node experiments/win-v2161-hooks-202609/playwright-electron.js     C1–C11, D6 badge, F1–F3, A3/C6 quit rules
node experiments/win-v2161-hooks-202609/gatec-process-files.js     A1/A2/A5, B1–B3, D5/D6, E1–E5
node experiments/win-v2161-hooks-202609/gatec-ui-en.js             F4/F5/F7/F8 (screenshots to FANBOX_GATEC_EVIDENCE)
```

`playwright-electron.js` puts a fake `claude` (`claude.cmd` → Node shim) on the tab PATH; it reads the `--settings` file FanBox typed and posts the same HTTP-hook events Claude Code sends, so the whole chain (flag → file → header interpolation → `/api/agent/event` → renderer) is exercised without an Anthropic login. C9 also plants a fake Codex npm shim (`codex.cmd` → `node_modules/@openai/codex/bin/codex.js`) and argv-spawns it via `term.spawnCodexInDir` to prove `-c notify=[…]` arrives as one slot. Results of the 2026-09-04 run are in `docs/win-port-implementation-notes-v2.16.1.html`.

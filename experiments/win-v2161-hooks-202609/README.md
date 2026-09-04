# Windows port v2.16.1 hooks campaign (2026-09)

Linux contract: `node experiments/win-v2161-hooks-202609/contract.test.js`

Drives shipped `win-port-helpers.js` (HTTP hook JSON, flag builders, joinPath/splitRel, snap trailing-sep, updater predicates, localImageAbs) plus source assertions on `server.js` / `electron/main.js` / `public/app.js` / `package.json`.

`playwright-electron.js` is a Gate C fixture (physical Windows). Not gating on Linux.

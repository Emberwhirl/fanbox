# Windows v2.13.0 image / path / Typeset / sanitizer campaign

Linux-runnable contract tests drive the **shipped** helpers in `win-port-helpers.js`
(the same module `electron/main.js`, `electron/preload.js`, and `server.js` require).

```bash
node experiments/win-v213-images-202608/contract.test.js
```

Physical-Windows Playwright coverage lives in `playwright-electron.js` and is skipped
unless Electron can launch on win32. Gate C on a Windows machine is the visual/native bar.

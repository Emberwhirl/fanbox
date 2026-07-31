# Windows port parity acceptance (2026-07)

Campaign for the v2.12.1 Windows-port remediation plan
(`docs/win-port-implementation-plan-v2.12.1.html`).

## What it checks

`verify.js` re-checks that every hunk in `git diff master...HEAD` for the five
core JS files falls into an accepted golden-rule category:

- **(a)** inside an `IS_WIN` / `isWindows()` / `PLATFORM === 'win32'` / `isWin()` guard
- **(b)** pure addition (new win-only helper, new dict keys)
- **(c)** whitelisted one-liner rewrite whose only behavioral branch is behind a platform/sep guard

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

Physical Windows manual matrix remains the merge gate for `dev` → `windows`.

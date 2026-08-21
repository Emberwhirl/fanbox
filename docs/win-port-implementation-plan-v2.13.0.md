# FanBox Windows v2.13.0 Port and Release Plan

## 1. Purpose and authorization boundary

FanBox upstream is macOS-only. This fork keeps `master` as the upstream mirror, develops the Windows port on `dev`, and publishes only validated commits through `windows`. The target is upstream v2.13.0 (`ca204a2`), which adds an Option/iTerm terminal hint and replaces the persistent Typeset editor mode with a modal plus native image selection, durable uploads, and image reordering.

`dev` already contains the unmerged PR #60 Markdown sanitizer and follow-up hardening. The port must preserve that security work and all existing Windows behavior while correcting Windows path, localization, release, and updater defects that can auto-merge without textual conflicts.

Approval of this plan authorizes **no execution by itself**. Repository changes, branch promotion, remote pushes, tag creation/push, packaging, draft creation, and public release each require the authorization stated below. Never treat approval of one boundary as approval of another.

**Authorization checkpoints.** An explicit instruction to begin implementation may authorize fetches, local safety refs, work/commits on `dev`, generated-bundle rebuilds, and local validation through candidate freeze. It does not authorize moving `windows`, pushing any ref, packaging, creating or pushing a tag, creating/modifying a draft, uploading/replacing assets, or publication. Each later boundary requires explicit authorization naming the fork, ref/version, and candidate OID; one instruction covers multiple boundaries only when it names each one.

## 2. Reviewed baseline

Revalidate before work; these OIDs are a snapshot, not permission to reset an unexpected ref.

| Ref | Reviewed OID |
|---|---|
| `dev`, `windows`, `github/windows` | `b8b6f707f447ae5b39fe7c476f709be710f27da5` |
| `master`, `github/master` | `ca204a2221377b808473fbc1eb0079fce6d8f820` |
| merge base | `ff054e504d87ac4720dcdfcbb8ab7389825fb066` |

`dev...master` has 15 Windows-side and 2 upstream-side commits. Local `upstream/master` is stale and must be fetched and verified before use. The upstream delta changes eight files and is expected to conflict only in `public/app.js`; automatic merges still require semantic review.

## 3. Goals and final deliverables

1. Make a real two-parent merge of upstream v2.13.0 into `dev`.
2. Preserve existing Windows functionality, PR #60 hardening, preview isolation, and byte-for-byte upstream macOS/Linux paths except for explicitly documented shared safety changes.
3. Make image picking, copy/no-copy decisions, persistence, movement, display, and Rich/Source save-reopen cycles correct for drive-letter and UNC paths.
4. Adopt the Typeset modal and remove the obsolete persistent Typeset mode.
5. Keep Windows Chinese/English UI complete without translating authored article content or showing macOS terminology.
6. Prevent planted-`git.exe` execution, incomplete release uploads, and updater offers for incomplete or fuzzy-matched Windows assets.
7. Preserve dated, repeatable acceptance campaigns for the hard fixes.
8. Validate one immutable commit OID on Linux and physical Windows x64, then fast-forward `windows` to that exact OID.
9. Build and verify both exact artifacts:
   - `FanBox-2.13.0-win-x64.exe`
   - `FanBox-2.13.0-win-x64-portable.exe`
10. Publish only after a complete draft is downloaded back and hash-verified, then validate the live updater.

Evidence must identify the tested OID, environments and tool versions, automated and manual results, package audit, artifact sizes/SHA-256 values, draft-download comparison, and post-publication updater result.

## 4. Ownership, branch flow, and immutable-candidate policy

- **Claude/Linux:** verify refs; merge; edit code/tests/docs; rebuild generated bundles; run static/server/security checks; review diffs; make local commits; fast-forward locally. Remote or tag operations occur only when separately authorized.
- **User/physical Windows:** rebuild native dependencies; verify real ConPTY; run Playwright Electron and manual native/visual tests; audit installer and portable packages; perform authenticated draft work; test the live updater.
- `master` remains immutable. All fixes land on `dev`. Physical source tests use a frozen `RELEASE_CANDIDATE_OID`, transferred privately by Git bundle or another existing private method unless a remote candidate ref is separately authorized.
- Any repository change after freezing the OID creates a new candidate and invalidates candidate-level Windows and package evidence.
- Only a passing candidate may fast-forward `windows`; artifacts must be built from that same OID. Never force-push.
- Commit messages are English only. The final release commit remains conventional and ends with `+ release 2.13.0`.

## 5. Scope and hard constraints

### Included

- Merge upstream `ca204a2` with ancestry.
- Windows-native image containment, serialization, picker/paste/drop persistence, movement, and export naming.
- Typeset modal lifecycle, localization, article-content protection, and sanitizer regression coverage.
- Safe release inspection/preparation and exact-pair updater validation, including HTML fallback.
- Version/lockfile root metadata, README fork wrapper, badge, changelog, generated Milkdown, and acceptance campaigns.
- Windows 10/11 x64 source, NSIS, portable, upgrade, and updater validation.

### Non-goals

- ARM64; macOS packaging/publication; unrelated Linux changes; unrelated dependency upgrades.
- Refactoring upstream POSIX code or `server.js`, weakening preview isolation, or redesigning Milkdown/Typeset/release UI beyond blockers.
- Browser-only durable image insertion, new HEIC/HEIF promises, or Windows code signing acquisition.
- Resubmitting PR #60, unrelated upstream work, editing `skills/fanbox-agent/SKILL.md`, or changing the official README body below the fork wrapper.

### Load-bearing constraints

- Preserve every macOS/Linux branch and literal byte-for-byte relative to `master`; add Windows behavior only through explicit parallel arms. The sole planned shared edit is the `.ts-preview` i18n content-skip boundary. Any additional shared edit is a scope change requiring explicit approval.
- Never build cmd/PowerShell strings from user data, use `shell:true`, or parse OEM-codepage command output for paths. Use argv spawning, `gitExe()`, `winSpawnEnv()`, native `path.win32`, and existing safe helpers.
- `server.js` remains Node-built-ins-only and must not import `electron/`.
- `mdHtml()` remains the Markdown-to-HTML sanitizer choke point. DOMPurify loads before app code and fails closed to escaped text. `semanticSig()` may parse unsanitized Markdown only in an inert `<template>`. Preview iframe origin/sandbox boundaries do not change.
- User-authored article text is never translated. New UI strings originate in Chinese and receive English dictionary entries or explicit Windows translations where the observer cannot reach them.
- Modify `src-vendor/milkdown-entry.js`, follow `docs/06-vendor补丁.md`, and regenerate the committed bundle; never hand-patch minified Milkdown.
- Release/update acceptance requires the exact x64 NSIS and portable pair. Similar names, one-file releases, wrong versions, or wrong architectures fail closed.

## 6. Stop/go gates

| Gate | Pass | Stop |
|---|---|---|
| **A — Integration** | Correct two-parent merge; semantic conflict resolution; sanitizer and Windows branches retained | Wrong ancestry, unexpected topology/conflicts, old Typeset mode, or sanitizer bypass |
| **B — Linux/static** | All syntax, smoke, security, path, updater, vendor, parity, and metadata checks pass on a clean frozen OID | Any hard failure, unexplained parity `CHK`, generated drift, security regression, or dirty tree |
| **C — Windows source** | Exact OID rebuilds; live ConPTY and all automated/manual source tests pass | Build/ABI/PTY/path/UI/security failure, skipped required test, or changed OID |
| **D — Packages** | Exact installer and portable bytes pass content, install/upgrade, runtime, and hash audits | Missing/stale/wrong artifact, debris, dead PTY, acceptance failure, or rebuild after hashing |
| **E1 — Publication readiness** | One OID/tag, complete unpublished draft, matching downloaded bytes/hashes, correct metadata, no blockers, and explicit publication approval | Partial/wrong draft, OID/name/hash/state mismatch, or unresolved blocker |
| **E2 — Public acceptance** | Public release is non-draft/non-prerelease, matches the approved OID/bytes, and installed plus portable updater flows pass | Public-state, asset, hash, or updater failure |

## 7. Execution plan

### Phase 1 — Protect baseline and merge upstream (Gate A)

1. Require clean `dev`. This review copy is not implicitly a release deliverable: if `docs/win-port-implementation-plan-v2.13.0.md` remains present/untracked, stop for an explicit decision to move it outside the checkout or add it to release scope; never delete or commit it silently. Repeat the clean-tree check afterward.
2. Verify `github` is `Emberwhirl/fanbox` and `upstream` is `alchaincyf/fanbox`; fetch branches with `--prune --no-tags`. Verify all reviewed OIDs, merge base/divergence, remotes, upstream `v2.13.0` → `ca204a2`, and absence of local/fork `v2.13.0`. Stop on unexpected movement; do not reset, force-update, rely on default remotes, use `--follow-tags`, or write to `upstream`.
3. Record baseline evidence and create unpushed safety refs for `dev` and `windows`, e.g. `safety/*-pre-v2.13.0-<date>`.
4. On `dev`, merge verified `master` with `--no-ff --no-commit`. Expect only `public/app.js` to conflict; abort and review any unexpected conflict. Audit all eight changed files, especially Electron main/preload and Milkdown source/bundle.
5. Resolve `public/app.js` semantically:
   - retain Rich, Source, and the internal read-only lossy-document fallback;
   - add Insert image and Typeset buttons; use the modal and remove the persistent Typeset tab/host/toolbar branch;
   - keep non-Windows `⌘S` and Option/iTerm wording unchanged; use Windows `Ctrl+S` and suppress unverified Option/iTerm claims;
   - preserve `mdHtml()`, DOMPurify order/fallback, the narrow Windows drive-path URI exception, inert `semanticSig()`, editor disposal, and awaited autosave flushes.
6. Commit with an English merge subject. Verify parent 1 is the reviewed `dev`, parent 2 is `ca204a2`, `master` is unchanged, and `master` is an ancestor of `dev`.

Gate A passes only with no conflict markers, no obsolete Typeset mode, no macOS-only Windows UI, and no sanitizer bypass.

### Phase 2 — Port image/editor behavior

### Native image import and containment

Add a narrow Windows IPC operation through `electron/main.js`/`electron/preload.js`, reusing `path.win32` and `uniqueDest()`. It must validate inputs; compare drive and UNC paths case-insensitively; reject sibling-prefix false positives; leave equal/descendant files unchanged; and copy outside, cross-drive, or different-share files beside the Markdown document without overwrite. Fix `drop:copy-into` by checking same-file status against the unsuffixed intended destination. Keep upstream POSIX logic unchanged and production containment logic directly testable.

### Canonical Markdown destination

Define one renderer serializer from **absolute native Windows path to Markdown destination**; reject relative paths, URI schemes, and already-canonical destinations. Initial contract: normalize native separators, retain a drive prefix such as `C:`, and percent-encode the path exactly once. Encode separators, whitespace, Unicode, `#`, `%`, `&`, brackets, parentheses, and apostrophes; UNC begins from encoded `\\`; one decode must recover the exact native path. A literal `%5C` therefore becomes `%255C`.

Use it at every native ingress: picker, saved screenshot/blob, Explorer drop, persistent File input, and decoded FanBox internal URLs. Insert only canonical values into Monaco/textarea/Milkdown. Never persist `file://`, `/api/raw`, `/api/thumb`, `/fs`, `blob:`, `data:image:`, or `pending-upload:`. `fixLocalImages()` decodes once and uses `/api/raw` for Windows while retaining upstream POSIX `/fs`. Reuse `baseOf()`/dual-separator helpers for export names.

The real marked + vendored Milkdown Rich → Source → Rich → save → reopen cycle must stabilize after one pass. If Milkdown rewrites it, fix the schema/`toMarkdown` boundary with an idempotent normalizer, not another blind encoding pass.

### Durable uploads, movement, Typeset, and i18n

Retain upstream upload, placeholder cleanup, insertion, and move behavior. Persist files through `fanboxDrop.saveInto()` before serialization; isolate per-file failures so successes remain and no failed placeholder survives. Add optional translated labels to move controls (`title` and `aria-label`) without changing non-Windows defaults. Rebuild Milkdown from source.

Add `.ts-preview` to the i18n content-skip selector; keep controls outside it. Explicitly translate Windows editor controls inside skipped `#preview-body`; add dictionary entries for image, movement, modal, export, progress, and errors; localize the native picker with `M(zh, en)`. Opening Typeset flushes pending Rich/Source edits; Escape/backdrop closure removes listeners and returns to the same editor, mode, and content.

Re-audit every Markdown-derived `innerHTML` sink, including Read, Typeset, WeChat, and changelog. Safe drive/UNC images must survive while active SVG, handlers, `javascript:`, and `data:text/html` remain inert. DOMPurify failure must show escaped text; preview isolation remains unchanged.

**Phase success:** all entry surfaces converge on one stable path representation; in-tree picks create no files, outside picks copy once, durable images survive restart, moves preserve source/alt/order, English UI has no Chinese/macOS leakage, authored content remains unchanged, and the sanitizer campaign passes.

### Phase 3 — Fix release and updater blockers

### Release preparation (`server.js`)

- Use `gitExe()` plus `winSpawnEnv()` for every `releaseInspect()` Git call; exact-match versions as `x.y.z`.
- Keep user notes in the notes file, never in generated PowerShell, commit subjects, or release titles.
- In the returned Windows PowerShell sequence, build first and then require both exact, non-empty v2.13.0 artifacts before `gh`; always attach both. Preserve PowerShell 5.1 right-folded chaining, argv rules, and non-Windows behavior.
- The wizard is test coverage, not the production v2.13 publication procedure.

### Updater (`electron/main.js`)

Compute exact names from normalized version and architecture. API mode must require both files. HTML fallback must probe both exact URLs with `HEAD`, then a bounded/aborted GET if needed; never download an entire installer merely to test existence. Return a verified list or `[]`, never a null value that bypasses gating. Keep macOS behavior and installer-first order unchanged.

**Phase success:** planted project `git.exe` cannot execute; notes never enter shell text; build precedes asset checks; neither release preparation nor updater accepts zero, one, fuzzy, wrong-version, or wrong-architecture assets.

### Phase 4 — Acceptance campaigns, metadata, and candidate freeze

1. Add `experiments/win-v213-images-202608/` with a README, Linux pure-contract tests, and physical-Windows Playwright Electron coverage that exercises production helpers/IPC and exits nonzero on failure. Cover containment/copy, serialization and literal `%5C`, marked/Milkdown idempotence, picker/paste/drop, partial failures, Rich/Source/restart, movement/undo, localization/ARIA, Typeset, and sanitizer compatibility.
2. Update existing parity, XSS, audit, and long-image campaigns for the modal (`#ed-typeset-btn`, `.typeset-dialog`, `.ts-preview`), parameterized roots/profiles/ports/evidence, Windows basenames, planted `git.exe`, post-build pair ordering, and removal of stale persistent-Typeset/v2.12 assumptions. Every process tree uses one external evidence root and disposable `USERPROFILE`, `HOME`, `APPDATA`, and `LOCALAPPDATA`; pre/postflight must prove no state reached the real profile. Preserve or increase existing total/per-section assertion counts, mapping any removal to a named replacement. Old-version fixtures run only in disposable checkouts/profiles.
3. Preserve `package.json` v2.13.0 and Windows build settings. Change only lockfile root versions; do not upgrade dependencies. Update only the README fork wrapper and badge. Preserve upstream’s dated `[2.13.0]` changelog entry, add a root-cause-oriented `### Windows port` subsection, and leave `[Unreleased]` empty. Keep the official README body and bundled agent skill byte-identical to `master`.
4. Commit in reviewable English-only units. The final conventional release commit subject ends exactly `+ release 2.13.0`; freeze that clean commit as `RELEASE_CANDIDATE_OID`. Do not commit evidence after freeze.

### Phase 5 — Linux/static verification (Gate B)

- Run `npm ci`; rebuild Milkdown, review the diff, rebuild again, and require no further drift.
- Run `node --check` on touched/generated JS, `git diff --check`, and the isolated standalone server smoke (`/` and `/api/skills/builtin` = 200; `/api/agent/terminals` = 501 outside Electron).
- Run preview guard (16/16), path/serializer/asset/fallback contracts, Linux-capable sanitizer/Typeset tests, and parity verification; manually classify every `CHK` because that script exits zero by design.
- Prove DOMPurify ordering/fail-closed behavior, inert `semanticSig()`, `.ts-preview` exclusion, absence of persistent-Typeset selectors, `server.js` dependency boundary, exact package names/settings, README/skill parity, empty `[Unreleased]`, and preserved non-Windows literals.
- Require a clean worktree and complete external logs.

Any failure returns to `dev`. A fix creates a new candidate; rerun all of Gate B before physical Windows testing.

### Phase 6 — Physical Windows source verification (Gate C)

Transfer the exact candidate privately and check it out detached or on a local RC branch. Use Windows 10 or 11 x64 with an isolated profile. Require x64 Node.js 18+ and VS Build Tools 2022 with Desktop development with C++, a compatible MSVC/Windows SDK, and matching Spectre-mitigated libraries; missing/mismatched prerequisites stop the gate rather than weakening package settings. Record the OID, clean status, OS build, components, and Node/npm/Git/PowerShell/Electron/ImageMagick/ffmpeg versions. Clear `NoDefaultCurrentDirectoryInExePath`, run `npm install` and mandatory `npm run rebuild`, require clean status, launch from source, and prove live ConPTY with a unique PowerShell command; app launch alone is insufficient.

Run all preserved Windows campaigns: phase2/2b, phase3a–f, WeChat driver/shim, updated phase3h/i/j, the new v2.13 image suite, full/sectioned long-image suites, and atlas/xterm suites where documented prerequisites exist. Record assertions, watchdogs, console exceptions, and skips; check repository cleanliness after each.

Required manual matrix:

1. **Terminal/environment:** isolated-profile command and child process show correct output and idle→busy→idle; spaces/CJK project paths preserve cwd/navigation without real-profile leakage.
2. **Picker/containment:** the picker starts in the document directory; cancel is a no-op; multi-select preserves order; equal/descendant paths, case changes, separator changes, and same-tree UNC do not copy; sibling-prefix, cross-drive, and different-share paths copy once; collisions use `uniqueDest()` without overwrite; repeated in-tree insertion creates no duplicate file.
3. **Serialization/editors:** drive and UNC filenames containing spaces, CJK, Markdown punctuation, apostrophe, `%`, and literal `%5C` survive two Rich/Source/save/close/reopen cycles without double encoding. Source cursor/selection insertion is correct. Restarted Markdown contains no transient/internal URL.
4. **Durability/movement:** screenshot paste, Explorer drop, blob/data conversion, and partial multi-file failure persist successes and remove failures. First/middle/last movement, boundaries, repeated moves, undo/redo, alt/source/order, and controls remain correct.
5. **Typeset/export:** unsaved Rich and Source tokens flush before modal open; Escape/backdrop/repeated lifecycle restores state without duplicate listeners, overlays, or editor leaks. WeChat/X copy, agent handoff, full/sectioned export use Windows basenames, write beside the article, and never overwrite. Inspect three app themes, default and Financial Times export styles, and 100%/150% scaling for clipping or missing content.
6. **Localization/content:** exercise all new controls and failures in Chinese and English. English has no new Chinese or macOS terms; labels/ARIA/picker follow language. Article text containing dictionary keys remains byte-faithful while surrounding controls translate.
7. **Security/release:** hostile Markdown is inert across Read, loss detection, Typeset, WeChat/changelog, and purifier-failure paths while safe local images display. Planted `git.exe` creates no marker. Fake release build produces assets only after invocation; either missing asset blocks fake `gh`; hostile notes never enter command text.

Gate C passes only when all required automation and manual cases pass on one unchanged OID. Any code fix creates a new candidate and requires complete Gates B and C again.

### Phase 7 — Promote, build, and accept packages (Gate D)

After separate branch-promotion authorization, verify refs are unchanged and fast-forward local `windows` to the candidate with `--ff-only`; stop before network writes. After separate branch-push authorization, push only `refs/heads/windows:refs/heads/windows` to `github`, without force or implicit tags. Require `dev == windows == github/windows == RELEASE_CANDIDATE_OID`.

After separate packaging authorization, on physical Windows fetch and check out detached `RELEASE_CANDIDATE_OID`. Immediately before packaging require `HEAD == dev == windows == github/windows == RELEASE_CANDIDATE_OID` and a clean tree. Remove stale `dist`, clear the environment override, run `npm install`, mandatory `npm run rebuild`, and `npm run dist:win`; recheck OID/cleanliness before hashing. Require two newly built, non-empty, unrenamed exact files.

Audit that `FanBox.exe`/`pty.node` are x64; app.asar and unpacked loadable `pty.node` exist; required app, sanitizer, Milkdown, changelog, and metadata files are present; excluded compiler intermediates and node-pty source/deps are absent; and `win-unpacked` has live ConPTY.

Test NSIS as a standard user in a custom path containing spaces plus CJK or an apostrophe. Verify app/installed version `2.13.0`, shortcut targets, relaunch/profile persistence, live ConPTY, image/Typeset/sanitizer smoke, v2.12.1 in-place upgrade without stale shortcuts/duplicate entries, uninstall removal of binaries/shortcuts while retaining configured user data, and no orphan processes. Test portable without elevation from Downloads and paths containing spaces/CJK/apostrophe (preferably another drive); run the same core smoke and relaunch checks, plus prove no installer shortcuts, uninstall entry, or install-only side effects. Both forms are mandatory.

After all local tests, record size, SHA-256, OID, tools, and Authenticode status; `NotSigned` is expected, malformed PE or hash failure is not. Write lowercase hashes to `SHA256SUMS.txt` and release notes. Any rebuild invalidates hashes and Gate D evidence.

### Phase 8 — Tag, draft, publish, and verify updater (Gate E)

1. With separate tag-creation authorization, create annotated `v2.13.0` on the candidate and verify its peeled OID. Push only the explicit tag ref to `github` with separate tag-push authorization; once pushed, it is immutable.
2. After separate draft-creation and asset-upload authorization, use authenticated `gh --repo Emberwhirl/fanbox` to create an **unpublished draft** from the already-pushed tag containing both exact executables, `SHA256SUMS.txt`, complete notes, Windows x64/unsigned notice, and tested OID. Do not let `gh` create the tag or permit partial publication.
3. Into an empty evidence directory, list and download all assets, recompute hashes, compare with locally tested bytes, and launch the downloaded portable build with live ConPTY. Any mismatch keeps the release in draft.
4. Publish only after refs/tag equal one OID, Gates A–D passed on the exact hashes, the complete draft and notes are correct, no blocker remains, and the user gives **explicit publication authorization**.
5. After publication, query `Emberwhirl/fanbox` explicitly and require a non-draft, non-prerelease normal latest release whose tag/OID and exact assets match the approved candidate/bytes. Then test installed and portable v2.12.1 update flows: offer only v2.13.0, choose the installer exact name, match its hash, complete upgrade, report current, preserve live ConPTY, and handle interrupted/fallback paths without loops or wrong assets. Do not broadly announce until Gate E2 passes.

## 8. Iteration, failure, and rollback policy

- Unexpected refs, topology, conflicts, dirty state, or prerequisites stop the current gate for reconciliation; never improvise a reset, force-update, or bypass.
- Before the merge commit, abort the merge. After local commits but before push/tag, preserve failed work on a diagnostic branch; reset only with explicit authorization.
- Any repository change after candidate freeze creates a new OID and requires a new freeze plus complete Gates B and C. If Gate D began, discard package/hash/draft evidence and repeat Gate D. Any artifact-byte change likewise repeats Gate D and draft verification. Failed, timed-out, or interrupted gates receive no partial credit: rerun the full gate; never carry evidence across changed inputs or bytes.
- Before `windows` promotion, repair on `dev`. After `windows` push but before tag, fix forward on `dev`, repeat gates, then fast-forward again; never rewrite shared history.
- An unpushed local tag may be recreated. A pushed tag or public release is immutable: warn as needed and prepare v2.13.1 through the full process; never replace binaries silently.
- Retain verified v2.12.1 installer/portable bytes and back up the disposable upgrade profile before testing. Restoration is proven only for that isolated fixture unless a real-profile downgrade is separately tested and authorized; public defects default to a fully validated fix-forward v2.13.1.

## 9. Critical files and utilities

- `public/app.js`: platform/path helpers, `mdHtml()`, local-image cleanup/rendering, `semanticSig()`, editor lifecycle/autosave.
- `electron/main.js`, `electron/preload.js`: `uniqueDest()`, drop/import IPC, `M()`, updater and asset selection.
- `src-vendor/milkdown-entry.js`, `public/vendor/milkdown/milkdown.js`: image upload/move/insertion source and generated bundle.
- `public/i18n.js`, `public/i18n-dict.js`, `public/typeset.js`, `public/style.css`: translation boundary, modal/export behavior.
- `server.js`: `gitExe()`, `winSpawnEnv()`, safe release inspection/preparation.
- `public/index.html`, `public/vendor/purify.min.js`: sanitizer load order.
- `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`, badge: release contract/metadata.
- `experiments/winport-parity-202607/`, export-longimage, atlas-pressure, xterm6-upgrade, and the new v2.13 campaign: regression evidence.

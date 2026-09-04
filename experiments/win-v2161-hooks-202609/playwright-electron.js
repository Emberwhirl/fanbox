#!/usr/bin/env node
'use strict';
/**
 * Gate C (physical Windows) Playwright-Electron script for v2.16.1 hooks.
 * Not gating on Linux. Launch with the matrix launcher from
 * experiments/winport-parity-202607/matrix/launch.js when a Windows box is available.
 *
 * Intended checks (C1–C11 / C9):
 *  - one-click Claude Code types --settings "C:\Users\…\claude-settings.json"
 *  - hook file has no token; hooked:true after first prompt
 *  - permission prompt → tab dot + glow + 指挥台 等你确认
 *  - Codex notify argv dump is byte-exact, else the flag is omitted
 */
console.log('win-v2161-hooks playwright-electron.js is a Gate C fixture; skip on Linux.');
process.exit(0);

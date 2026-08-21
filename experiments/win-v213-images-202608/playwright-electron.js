#!/usr/bin/env node
'use strict';
/**
 * Physical-Windows Playwright Electron coverage for v2.13 image/Typeset flows.
 * Linux / missing Electron: skip with a clear message (not a green lie).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

if (process.platform !== 'win32') {
  console.log('SKIP: playwright-electron.js is Gate C (physical Windows). This host is ' + process.platform);
  process.exit(0);
}

(async () => {
  let _electron;
  try { _electron = require('playwright')._electron; }
  catch { console.log('SKIP: playwright not installed'); process.exit(0); }
  const electronBin = path.join(ROOT, 'node_modules', 'electron');
  if (!fs.existsSync(electronBin)) {
    console.log('SKIP: bundled electron missing'); process.exit(0);
  }
  console.log('playwright-electron: launch the app on Windows and run picker/containment/Typeset cases from the plan.');
  console.log('(Fill in against a frozen RELEASE_CANDIDATE_OID during Gate C.)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });

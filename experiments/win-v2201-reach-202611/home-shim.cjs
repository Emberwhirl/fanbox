'use strict';
// Preload for running upstream's tests on Windows: `npm run test:win`.
// Upstream's 2.18-2.20 tests (e.g. tests/wechat-always.test.js) isolate themselves by setting process.env.HOME to a
// temp dir, but on Windows os.homedir() reads USERPROFILE, so without this shim bridge.js writes into the real
// ~/.fanbox/wechat and the tests read the temp dir and fail. Test-only: never loaded by the app.
const os = require('os');
const orig = os.homedir;
os.homedir = () => process.env.HOME || orig();

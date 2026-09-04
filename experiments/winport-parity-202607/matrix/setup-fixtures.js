// Recreate the per-run fixtures the matrix phases consume (some phases recycle them, so run
// this before every campaign). Idempotent. Static fixtures (preview/, md/, thumbs/, trap-repo/git.exe)
// are copied once by hand; this script only fills what the phases delete or need generated.
//   FANBOX_MATRIX_HOME=<fake home> node experiments/winport-parity-202607/matrix/setup-fixtures.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FAKE_HOME } = require('./launch');
const FIX = path.join(FAKE_HOME, 'fanbox-test-fixtures');
const HOSTILE = path.join(FIX, 'hostile');
const PROJ_SUB = path.join(FIX, 'proj', 'sub');
const NOTES = path.join(FAKE_HOME, 'notes');
const TRAP = path.join(FIX, 'trap-repo');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

for (const d of [HOSTILE, path.join(HOSTILE, 'del-folder'), PROJ_SUB, NOTES, TRAP]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(PROJ_SUB, 'keep.txt'), 'keep\n');
fs.writeFileSync(path.join(HOSTILE, 'del-file.txt'), 'x');
fs.writeFileSync(path.join(HOSTILE, 'del-folder', 'inner.txt'), 'y');
for (const n of ['report[1].png', '%USERNAME%.txt', "it's.txt"]) fs.writeFileSync(path.join(HOSTILE, n), 'x');
const junction = path.join(HOSTILE, 'junction-dir');
if (!fs.existsSync(junction)) execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junction, PROJ_SUB], { stdio: 'ignore' });
// phase3i: an innocent-looking note next to a cover image (the hostile md is written by the phase itself)
if (!fs.existsSync(path.join(NOTES, 'innocent.md'))) fs.writeFileSync(path.join(NOTES, 'innocent.md'), '# innocent\n\n![cover](cover.png)\n');
if (!fs.existsSync(path.join(NOTES, 'cover.png'))) fs.writeFileSync(path.join(NOTES, 'cover.png'), png);
if (!fs.existsSync(path.join(NOTES, 'real.md'))) fs.writeFileSync(path.join(NOTES, 'real.md'), '# real\n\ntext\n');
// phase3j: releaseInspect/releasePrepare need a package.json in the trap repo (git.exe is the planted binary)
if (!fs.existsSync(path.join(TRAP, 'package.json'))) fs.writeFileSync(path.join(TRAP, 'package.json'), JSON.stringify({ name: 'trap-repo', version: '2.12.0', scripts: { dist: 'echo dist', 'dist:win': 'echo dist-win' } }, null, 2) + '\n');
if (!fs.existsSync(path.join(TRAP, 'git.exe'))) console.error('note: trap-repo/git.exe (planted binary) is missing — phase3j will skip; build it from the v2.12.1 plan with csc.exe');
console.log('fixtures ready under ' + FIX);

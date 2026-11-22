'use strict';
// Windows port of upstream's fanbox-notify (2.20.0). FanBox copies this file to ~/.fanbox/bin/fanbox-notify.cjs at
// startup; the two launchers next to it (fanbox-notify.cmd for PowerShell / cmd, fanbox-notify for Git Bash) run it
// with FanBox's own executable as Node (ELECTRON_RUN_AS_NODE=1, path in FANBOX_EXE from the PTY env).
// Same contract as upstream's sh version: text from the arguments (joined with spaces) or, with no arguments, from
// stdin; POST form-encoded to $FANBOX_CTL/notify; print FanBox's JSON answer; exit 0 when "ok":true, 2 when FanBox
// declined, 1 when not inside a FanBox terminal or FanBox is unreachable. Node's http ignores proxy variables, and
// the token travels only in a request header (never on a command line).
// Usage: fanbox-notify "要说的话"   or   命令 | fanbox-notify
const http = require('http');

const ctl = process.env.FANBOX_CTL || '';
const token = process.env.FANBOX_CTL_TOKEN || '';
const term = process.env.FANBOX_TERM_ID || '';

function fail(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function send(text) {
  let u;
  try { u = new URL(ctl.endsWith('/') ? ctl + 'notify' : ctl + '/notify'); } catch { return fail('fanbox-notify：连不上 FanBox，没有发', 1); }
  const body = Buffer.from('text=' + encodeURIComponent(text), 'utf8');
  const req = http.request({
    hostname: u.hostname,
    port: u.port || 80,
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': body.length,
      'x-fanbox-token': token,
      'x-fanbox-term': term,
    },
    timeout: 5000,
  }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      process.stdout.write(out + '\n');
      process.exit(out.includes('"ok":true') ? 0 : 2);
    });
  });
  req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch { /* */ } });
  req.on('error', () => fail('fanbox-notify：连不上 FanBox，没有发', 1));
  req.end(body);
}

if (!ctl) fail('fanbox-notify：不在 FanBox 的终端里，没有发', 1);
const args = process.argv.slice(2);
if (args.length) send(args.join(' '));
else {
  let t = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { t += c; });
  process.stdin.on('end', () => send(t.replace(/\n+$/, '')));
}

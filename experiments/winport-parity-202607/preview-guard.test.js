#!/usr/bin/env node
'use strict';
/**
 * 预览服务器 win32 路径闸的回归测试（对应 code review 的 8.3 短名绕过）。
 *
 * 背景：预览端口开着 allow-same-origin，恶意预览页的 JS 与预览源同源，能 fetch 任意
 * /fs/ 路径再外发。所以「只出主目录、挡掉点目录」这两道闸是安全边界，不是体验优化。
 * NTFS 系统盘默认生成 8.3 短名（.ssh → SSH~1、.claude → CLAUDE~1），短名里没有点，
 * 按段名判「开头是不是 .」的写法会被整条绕过。
 *
 * 这里复刻 server.js previewPathAllowed 的 win32 分支（用 path.win32 + 可注入的 realpath
 * 在 Linux/macOS 上跑），逐条验收。改 server.js 那个函数时，这里要同步改。
 */
const path = require('path');

const HOME = 'C:\\Users\\xiaoyu';

// ---- server.js previewPathAllowed win32 分支的镜像 ----
function previewPathAllowedWin(file, realpathNative) {
  const real = path.win32.resolve(file);
  const home = path.win32.resolve(HOME);
  const expand = (p) => { try { return realpathNative(p); } catch { return null; } };
  const homeC = expand(home) || home;
  const canon = expand(real);
  const target = canon || real;
  const n = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const r = n(target), h = n(homeC);
  if (r !== h && !r.startsWith(h + '/')) return false;
  const rest = target.slice(homeC.length);
  if (!canon && /(^|[\\/])[^\\/]*~\d/.test(rest)) return false;
  return !rest.split(/[\\/]/).some((s) => s.startsWith('.'));
}

// 假 realpath：把已知 8.3 短名展开成长名，其余原样返回；未登记的「不存在」路径抛错
const SHORT = {
  'c:\\users\\xiaoyu\\ssh~1': 'C:\\Users\\xiaoyu\\.ssh',
  'c:\\users\\xiaoyu\\claude~1': 'C:\\Users\\xiaoyu\\.claude',
  'c:\\users\\xiaoyu\\ssh~1\\id_rsa': 'C:\\Users\\xiaoyu\\.ssh\\id_rsa',
  'c:\\users\\xiaoyu\\claude~1\\creden~1.jso': 'C:\\Users\\xiaoyu\\.claude\\credentials.json',
  'c:\\users\\xiaoyu\\junc~1': 'C:\\Windows\\System32', // 目录联接指到系统盘外
};
const EXISTING = new Set([
  'c:\\users\\xiaoyu',
  'c:\\users\\xiaoyu\\report.html',
  'c:\\users\\xiaoyu\\docs\\a.png',
  'c:\\users\\xiaoyu\\.ssh\\id_rsa',
  'c:\\users\\xiaoyu\\版本~1.md',
  'c:\\users\\xiaoyu\\report~1.png', // 真名里就带 ~1 的普通文件
]);
const realpathNative = (p) => {
  const k = p.toLowerCase();
  if (SHORT[k]) return SHORT[k];
  if (EXISTING.has(k)) return p;
  const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
};

const CASES = [
  // [路径, 期望放行?, 说明]
  ['C:\\Users\\xiaoyu\\report.html', true, '主目录下的普通文件'],
  ['C:\\Users\\xiaoyu\\docs\\a.png', true, '子目录下的普通文件'],
  ['C:\\Users\\xiaoyu', true, '主目录本身'],
  ['C:\\Users\\xiaoyu\\report~1.png', true, '文件名真带 ~1，realpath 成功 → 不该误杀'],
  ['C:\\Users\\xiaoyu\\版本~1.md', true, '中文名带 ~1，realpath 成功 → 不该误杀'],

  ['C:\\Users\\xiaoyu\\.ssh\\id_rsa', false, '点目录直连'],
  ['C:\\Users\\xiaoyu\\SSH~1\\id_rsa', false, '8.3 短名绕过点目录（本次修复的主案）'],
  ['C:\\Users\\xiaoyu\\CLAUDE~1\\CREDEN~1.JSO', false, '8.3 短名两段全绕'],
  ['C:\\Users\\xiaoyu\\ssh~1\\id_rsa', false, '短名小写形态'],
  ['C:\\Users\\xiaoyu\\JUNC~1\\config', false, '目录联接指到 C:\\Windows → realpath 展开后越界'],
  ['C:\\Users\\xiaoyu\\NOPE~1\\x', false, 'realpath 失败且含 ~n → 保守拒绝'],

  ['C:\\Windows\\System32\\config\\SAM', false, '主目录之外'],
  ['C:\\Users\\xiaoyu2\\secret.txt', false, '同级兄弟目录前缀相近'],
  ['C:\\Users\\XIAOYU\\.ssh\\id_rsa', false, '大小写翻转仍要挡住点目录'],
  ['C:\\Users\\xiaoyu\\..\\xiaoyu2\\x', false, '点段回溯到兄弟目录'],
  ['C:/Users/xiaoyu/.ssh/id_rsa', false, '正斜杠形态的点目录'],
];

let fail = 0;
for (const [p, want, why] of CASES) {
  let got;
  try { got = previewPathAllowedWin(p, realpathNative); } catch (e) { got = `THREW ${e.message}`; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${want ? '放行' : '拒绝'}  ${p}\n        ${why}${ok ? '' : `  → 实际 ${got}`}`);
}
console.log(`\n${CASES.length - fail}/${CASES.length} passed`);
process.exit(fail ? 1 : 0);

/**
 * 宿主半边的**离线冒烟测试**（手动运行，不在 `npm test` 里）。
 *
 * 为什么不进用例集：它会真的读 PATH、并对白名单命令拉起子进程，属于 I/O 重活，
 * 不适合塞进每次都要跑的 hermetic 用例。
 *
 * 为什么需要它：宿主半边**不会被热重载**（Node 的 ESM 缓存），装了插件也得重启 DSH
 * 才生效。这个脚本用假的 `ctx` 直接把 `apply()` 跑起来、捕获路由、再喂一个假请求，
 * 于是"扫描到底能不能出数据"不必等重启就能验。
 *
 * 用法：node test/host-smoke.mjs
 */
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

assert.equal(name, 'cli-inventory');
assert.deepEqual(inject, ['webServer']);

/** 捕获 apply 注册的东西。 */
const effects = [];
const routes = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return () => { if (typeof dispose === 'function') dispose(); };
  },
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
};

apply(ctx);
assert.equal(routes.length, 1, '应注册且只注册一条路由');
const route = routes[0];
assert.equal(route.kind, 'exact');
assert.equal(route.path, '/api/cli-inventory/list');
console.log('✓ 路由已注册：', route.path, '| effect:', effects.join(' / '));

/** 造一个假请求 / 假响应，把 handler 跑通。 */
function call(headers, method = 'GET', url = '/api/cli-inventory/list') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.from(String(body)));
        resolve({ statusCode: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') });
      },
      write(chunk) { chunks.push(Buffer.from(String(chunk))); return true; },
    };
    Promise.resolve(route.handler({ method, headers, url }, res)).catch(reject);
  });
}

// 1) 非回环 Host 必须被拒
const forbidden = await call({ host: 'evil.example.com' });
assert.equal(forbidden.statusCode, 403, '非本机来源必须 403');
console.log('✓ 非回环 Host 被拒：', JSON.parse(forbidden.body).error);

// 2) 跨站请求必须被拒
const crossSite = await call({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' });
assert.equal(crossSite.statusCode, 403);
console.log('✓ 跨站请求被拒：', JSON.parse(crossSite.body).error);

// 3) 非 GET 必须 405
const wrongMethod = await call({ host: '127.0.0.1:19387' }, 'POST');
assert.equal(wrongMethod.statusCode, 405);
console.log('✓ 非 GET 被拒：405');

// 4) 正常请求
const response = await call({ host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' });
assert.equal(response.statusCode, 200, '同源请求应 200：' + response.body.slice(0, 200));
const report = JSON.parse(response.body);
assert.equal(report.ok, true);
assert.ok(Array.isArray(report.entries) && report.entries.length > 0, '应扫到条目');
assert.ok(report.pathCount > 0, '应至少有一个 PATH 目录');

const harness = report.entries.filter((entry) => entry.source === 'harness');
const commands = report.entries.filter((entry) => entry.source === 'path');
assert.ok(commands.length >= 10, 'PATH 里应扫到足够多的命令，实际 ' + commands.length);
assert.ok(harness.some((entry) => entry.name === 'node'), '应含 harness 自带的 node');

// 版本：白名单里存在的命令应当取到版本
const withVersion = report.entries.filter((entry) => typeof entry.version === 'string' && entry.version !== '');
assert.ok(withVersion.length >= 3, '应至少取到 3 个版本，实际 ' + withVersion.length);
const gh = report.entries.find((entry) => entry.name === 'gh');
if (gh !== undefined) {
  assert.ok(typeof gh.version === 'string' && gh.version.includes('gh version'), 'gh 版本应被取到：' + gh.version);
  console.log('✓ gh 版本探测：', gh.version, '|', gh.path);
}

// 隐私：路径必须已缩略，不得出现绝对家目录
for (const entry of report.entries) {
  assert.ok(!/^\/Users\/[^/]+\//.test(entry.path) || entry.path.startsWith('/usr/'), '路径未缩略：' + entry.path);
}
assert.ok(!response.body.includes('/Users/liao'), '响应里不得出现绝对家目录');

console.log('✓ 扫描结果：', report.pathCount, '个 PATH 目录 ·', commands.length, '个命令 ·',
  withVersion.length, '个取到版本 · harness 运行时', harness.length, '个');
console.log('✓ 前 10 个命令：', commands.slice(0, 10).map((entry) => entry.name).join(', '));
// 5) 分组计数与运行时识别
assert.ok(report.scopeCounts !== null && typeof report.scopeCounts === 'object', '响应应带 scopeCounts');
assert.ok(report.scopeCounts.user >= 1, '应至少识别出 1 个"你自己装的"');
assert.ok(report.scopeCounts.system > 0, '系统段应有条目');
assert.equal(report.truncated, false, '上限已放宽到实际规模之上，不应再截断');
console.log('✓ 分组计数：你自己装的', report.scopeCounts.user, '· 系统自带', report.scopeCounts.system, '· 未截断');

const { existsSync, readdirSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { join } = await import('node:path');
const runtimesRoot = join(homedir(), '.dsh', 'dsh-runtimes');
let pythonOnDisk = false;
if (existsSync(runtimesRoot)) {
  for (const runtimeName of readdirSync(runtimesRoot)) {
    if (existsSync(join(runtimesRoot, runtimeName, 'dependencies', 'python', 'bin', 'python3'))) pythonOnDisk = true;
  }
}
assert.ok(harness.some((entry) => entry.name === 'node'), '应识别出 harness 的 node');
if (pythonOnDisk) {
  // 这条是 D 项修复的回归门禁：早先从 execPath 旁边推 python，桌面版下必然推不到。
  assert.ok(harness.some((entry) => entry.name === 'python3'), '本机 dsh-runtimes 里有 python，却没被识别出来');
  console.log('✓ 运行时识别：node + python3 都找到了（本机存在运行时 python）');
}

// 5) 缓存：重复请求应复用同一份结果；`?fresh=1` 必须重扫
const again = JSON.parse((await call({ host: '127.0.0.1:19387' })).body);
assert.equal(again.scannedAt, report.scannedAt, '未带 fresh 时应复用缓存');
console.log('✓ 缓存复用：scannedAt 不变');
const fresh = JSON.parse((await call({ host: '127.0.0.1:19387' }, 'GET', '/api/cli-inventory/list?fresh=1')).body);
assert.notEqual(fresh.scannedAt, report.scannedAt, 'fresh=1 应绕过缓存重扫');
console.log('✓ fresh=1 绕过缓存：scannedAt 已更新');

console.log('\n宿主半边冒烟测试全部通过。');

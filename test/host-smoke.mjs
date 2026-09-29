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
  // 真实宿主总是有 ctx.on（cordis 核心）；这里补上让插件走真实路径。
  on() { return () => {}; },
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
assert.ok(commands.length >= 3, '应扫到你自己装的命令，实际 ' + commands.length);
assert.ok(commands.length < 100, '系统目录应被整体跳过，命令数不该上百，实际 ' + commands.length);
assert.ok(harness.some((entry) => entry.name === 'node'), '应含 harness 自带的 node');

// 版本：白名单里存在的命令应当取到版本
const withVersion = report.entries.filter((entry) => typeof entry.version === 'string' && entry.version !== '');
assert.ok(withVersion.length >= 1, '应至少取到 1 个版本，实际 ' + withVersion.length);
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

console.log('✓ 扫描结果：PATH', report.pathCount, '个目录（扫了', report.scannedDirCount, '个）·',
  commands.length, '个命令 ·', withVersion.length, '个取到版本 · harness 运行时', harness.length, '个');
console.log('✓ 扫到的命令：', commands.map((entry) => entry.name).join(', '));
// 5) 分组计数与运行时识别
assert.equal(report.truncated, false, '上限已放宽到实际规模之上，不应再截断');
assert.ok(report.scannedDirCount > 0 && report.scannedDirCount < report.pathCount,
  '应只扫一部分目录（系统目录跳过）：' + report.scannedDirCount + '/' + report.pathCount);
// 系统目录必须**完全没有**出现在结果里
const systemish = commands.filter((entry) => /^\/(usr\/bin|usr\/sbin|bin|sbin|System)\//.test(entry.path));
assert.deepEqual(systemish.map((entry) => entry.path), [], '系统目录的命令不该被列出');
console.log('✓ 只扫了', report.scannedDirCount, '/', report.pathCount, '个目录 ·', commands.length, '个命令 · 无系统目录条目');

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

// 5) 无缓存：每次请求都应重新扫描（扫描已降到毫秒级）
const again = JSON.parse((await call({ host: '127.0.0.1:19387' })).body);
assert.notEqual(again.scannedAt, report.scannedAt, '没有缓存了：每次请求都应是新扫描');
console.log('✓ 无缓存：每次请求都是新扫描（scannedAt 变化）');

// 6) 能力段：**容错**（宿主没有 tools/skills 服务时不能崩，只如实报空）
assert.ok(report.capabilities !== null && typeof report.capabilities === 'object', '响应应带 capabilities');
assert.deepEqual(report.capabilities.tools, [], '没有 tools 服务时应为空数组而不是报错');
assert.deepEqual(report.capabilities.skills, [], '没有 skills 服务时应为空数组');
assert.deepEqual(report.capabilities.mcp.servers, []);
console.log('✓ 能力段容错：宿主未提供 tools/skills 服务时如实报空，整页照常返回');

// 7) 能力段：有服务时正确读取与分离（MCP 按 mcp__<服务器>__<工具> 约定拆出）
{
  const capRoutes = [];
  const capCtx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
    webServer: { register(r) { capRoutes.push(r); return () => {}; } },
    get(name) {
      if (name === 'tools') {
        return {
          schemas: () => [
            { name: 'read', description: '读取文件' },
            { name: 'bash', description: '执行 shell' },
            { name: 'mcp__github__create_issue', description: '建 issue' },
            { name: 42 },
          ],
        };
      }
      if (name === 'skills') {
        return { list: async () => [{ name: 'pdf', description: '处理 PDF', provider: 'builtin', whenToUse: 7 }, { notName: true }] };
      }
      return undefined;
    },
  };
  apply(capCtx);
  const caps = await new Promise((resolve, reject) => {
    const res = { statusCode: 0, setHeader() {}, end(body) { resolve(JSON.parse(String(body))); } };
    Promise.resolve(capRoutes[0].handler(
      { method: 'GET', headers: { host: '127.0.0.1:19387' }, url: '/api/cli-inventory/list' }, res,
    )).catch(reject);
  });
  assert.deepEqual(caps.capabilities.tools.map((entry) => entry.name), ['bash', 'read'], '普通工具（脏条目被跳过）');
  assert.deepEqual(caps.capabilities.mcp.servers, ['github'], 'MCP 服务器名从工具名反推');
  assert.deepEqual(caps.capabilities.mcp.tools.map((entry) => entry.tool), ['create_issue']);
  assert.deepEqual(caps.capabilities.skills.map((entry) => entry.name), ['pdf']);
  assert.equal(caps.capabilities.skills[0].whenToUse, undefined, '非字符串字段不得下发');

  // 8) 工具必须**带作用域**读：省略 scope 只有全局视图（实测 1 个），
  //    带上预设作用域的租约才能拿到 Agent 真正那批（实测 40 个）。
  {
    const scopedRoutes = [];
    let disposed = 0;
    let acquired = 0;
    const globalOnly = [{ name: 'load_workspace_dependencies', description: '全局那个' }];
    const scoped = [
      { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: {}, offset: {} }, required: ['file_path'] } },
      { name: 'load_workspace_dependencies', description: '全局那个' },
    ];
    let agentListener;
    const seenScopes = [];
    const scopedCtx = {
      effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
      on(name, listener) { if (name === 'agent/created') agentListener = listener; return () => {}; },
      webServer: { register(r) { scopedRoutes.push(r); return () => {}; } },
      get(name) {
        if (name === 'tools') {
          return {
            schemas: (scope) => {
              seenScopes.push(scope);
              return scope === undefined ? globalOnly : scoped;
            },
          };
        }
        if (name === 'agentPresets') {
          return {
            resolve: async () => ({ id: 'default', isDefault: true }),
            acquireScope: async () => {
              acquired += 1;
              return { key: {}, [Symbol.asyncDispose]: async () => { disposed += 1; } };
            },
          };
        }
        if (name === 'skills') return { list: async () => [] };
        return undefined;
      },
    };
    apply(scopedCtx);
    const withScope = await new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(body) { resolve(JSON.parse(String(body))); } };
      Promise.resolve(scopedRoutes[0].handler(
        { method: 'GET', headers: { host: '127.0.0.1:19387' }, url: '/api/cli-inventory/list' }, res,
      )).catch(reject);
    });
    assert.deepEqual(withScope.capabilities.tools.map((entry) => entry.name), ['load_workspace_dependencies', 'read'],
      '应读到作用域视图（2 个），不是全局视图（1 个）');
    assert.deepEqual(withScope.capabilities.tools.find((entry) => entry.name === 'read').params,
      ['file_path', 'offset'], '参数名应下发');
    assert.deepEqual(withScope.capabilities.tools.find((entry) => entry.name === 'read').required, ['file_path']);
    assert.equal(acquired, 1, '应借一次作用域租约');
    assert.equal(disposed, 1, '读完必须释放租约（AsyncDisposable）');
    // 逐字段断言（不用 deepEqual：脚本里对 undefined 键的呈现不稳定）
    assert.equal(withScope.capabilities.toolsScope.preset, 'default');
    assert.equal(withScope.capabilities.toolsScope.scoped, true);
    assert.equal(withScope.capabilities.toolsScope.live, false, '没有 agent 时应标注为冷启动视图');

    // 一旦有 agent/created，就该改用**该会话的作用域**（那里才有会话级工具）
    assert.equal(typeof agentListener, 'function', '应注册 agent/created 监听');
    const sessionScope = { tag: 'agent-scope' };
    agentListener.call(sessionScope, { agent: { id: 'session-abc' } });
    const live = await new Promise((resolve, reject) => {
      const res = { statusCode: 0, setHeader() {}, end(body) { resolve(JSON.parse(String(body))); } };
      Promise.resolve(scopedRoutes[0].handler(
        { method: 'GET', headers: { host: '127.0.0.1:19387' } }, res,
      )).catch(reject);
    });
    assert.deepEqual(seenScopes[seenScopes.length - 1], sessionScope, '有 agent 后应把该作用域交给 schemas()');
    assert.equal(live.capabilities.toolsScope.live, true, '应标注来自会话视图');
    assert.equal(live.capabilities.toolsScope.sessionId, 'session-abc');
    console.log('✓ 工具视图优先用会话作用域：live =', live.capabilities.toolsScope.live,
      '· sessionId =', live.capabilities.toolsScope.sessionId);
    console.log('✓ 工具按作用域读取：', withScope.capabilities.tools.length, '个（租约获取', acquired, '/ 释放', disposed, '）· 预设', withScope.capabilities.toolsScope.preset);
  }
  console.log('✓ 能力段读取：工具', caps.capabilities.tools.length, '个 · MCP 服务器',
    caps.capabilities.mcp.servers.join(','), '· 技能', caps.capabilities.skills.length, '个');
}

console.log('\n宿主半边冒烟测试全部通过。');

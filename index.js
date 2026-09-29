/**
 * ============================================================================
 * dsh-cli-inventory —— 宿主半边
 * ============================================================================
 *
 * 【职责】把"这台机器上有哪些命令行工具、什么版本"整理成 JSON，交给浏览器半边
 * 渲染成设置页里的一个页面（`settings.section`）。浏览器读不到 PATH，所以这一步
 * 必须在宿主做。
 *
 * 【安全边界（重要，README 与 disclosure 里同步声明）】
 *   · **只读**：枚举 PATH 目录、`stat` 条目，不写任何文件、不联网、不碰凭据。
 *   · **只执行白名单**：取版本需要执行二进制，所以只对 `lib/allowlist.js` 里写死的
 *     清单执行、参数固定、带超时、只取第一条输出行。**白名单之外的命令只列名称与
 *     路径，绝不执行** —— 否则等于让插件执行用户 PATH 里的任意程序。
 *   · 路由带同源 / 跨站 / 非回环守卫（与余额路由同一套判定）。
 *
 * @module dsh-cli-inventory
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, probeArgsFor } from './lib/allowlist.js';
import {
  MCP_TOOL_PREFIX, normalizeSkill, normalizeTool, sortByName, summarizeCapabilities,
} from './lib/capabilities.js';
import {
  PER_DIR_LIMIT, USER_TOTAL_LIMIT,
  cap, classifyDir, isCommandEntry, joinDir, mergeByPathOrder, parseVersion, splitPath,
} from './lib/path-scan.js';

/** 插件名（与 cordis.patch.yml、package.json 一致）。 */
const name = 'cli-inventory';

/** 需要注入的服务：webServer（注册数据路由）。本插件的存在意义就是给 Web GUI 提供数据，
 *  没有 webServer 时它无事可做，所以这里是硬依赖而不是可选注入。 */
const inject = ['webServer'];

/** 数据路由。 */
const LIST_PATH = '/api/cli-inventory/list';

/** 响应上限（探测并发之外的另一个保险）。 */
const MAX_BODY = 512 * 1024;

/**
 * 把家目录前缀缩成 `~`。
 *
 * 两个好处：界面里路径短得多；用户分享截图时不会顺带暴露自己的用户名。
 *
 * @param filePath - 绝对路径。
 * @returns 缩略后的路径。
 */
function tilde(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return filePath;
  const home = homedir();
  if (typeof home !== 'string' || home === '' || home === '/') return filePath;
  return filePath === home ? '~' : (filePath.startsWith(home + '/') ? '~' + filePath.slice(home.length) : filePath);
}

/**
 * 判断一个请求是否来自本机同源页面。
 *
 * 与 `dsh-usage-meter` 的余额路由同一套判定，因为 `@deepseek-ai/dsh-host-webserver`
 * 只绑定回环地址、不带任何鉴权或来源策略 —— 插件必须自己守。
 *
 * @param req - HTTP 请求。
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`。
 */
function allowRequest(req) {
  const host = String(req.headers.host || '');
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    return { ok: false, reason: 'forbidden host' };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== '' && origin !== 'null') {
    let originHost;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return { ok: false, reason: 'malformed origin' };
    }
    if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '::1') {
      return { ok: false, reason: 'cross-origin request rejected' };
    }
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return { ok: false, reason: 'cross-site request rejected' };
  }
  return { ok: true };
}

/**
 * 执行一次版本探测。失败/超时一律返回 null（不影响其它条目）。
 * @param binary - 绝对路径。
 * @param args - 固定参数。
 * @returns 版本字符串或 null。
 */
function runProbe(binary, args) {
  return new Promise((settle) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      settle(value);
    };
    try {
      execFile(binary, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        // 有的命令把版本写到 stderr（如 java -version），所以两边都看
        finish(parseVersion(String(stdout || '') + '\n' + String(stderr || '')));
      });
    } catch {
      finish(null);
    }
  });
}

/**
 * 按白名单并发探测版本。
 * @param commands - `[{ name, path }]`。
 * @returns `Map<名称, 版本|null>`。
 */
async function probeVersions(commands) {
  const targets = commands.filter((command) => probeArgsFor(command.name) !== undefined);
  const versions = new Map();
  for (let index = 0; index < targets.length; index += PROBE_CONCURRENCY) {
    const batch = targets.slice(index, index + PROBE_CONCURRENCY);
    const settled = await Promise.all(batch.map(async (command) => [
      command.name,
      await runProbe(command.path, probeArgsFor(command.name)),
    ]));
    for (const [key, value] of settled) versions.set(key, value);
  }
  return versions;
}

/**
 * 枚举 PATH 里的命令。
 * @returns `{ dirs, commands, truncated }`。
 */
async function scanCommands() {
  const home = homedir();
  const dirs = splitPath(process.env.PATH, delimiter);
  const scans = [];
  let scannedDirs = 0;
  for (const dir of dirs) {
    // **只扫"你自己装的"目录**：系统目录（/usr/bin、/sbin…）占了实测 1270 条里的 1263 条，
    // 既没有实用价值，也是那 800ms 的来源。跳过它们之后扫描从 800ms 掉到 ~40ms。
    if (classifyDir(dir, home) === 'system') continue;
    scannedDirs += 1;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue; // 目录不存在 / 无权限：跳过，不影响其它目录
    }
    const capped = cap(names, PER_DIR_LIMIT);
    const entries = [];
    for (const entryName of capped.items) {
      try {
        // stat 跟随符号链接，与 which 语义一致
        const info = await stat(joinDir(dir, entryName));
        if (isCommandEntry({ name: entryName, isFile: info.isFile(), isDirectory: info.isDirectory(), mode: info.mode })) {
          entries.push(entryName);
        }
      } catch {
        // 断链、竞态删除等，跳过
      }
    }
    scans.push({ dir, entries });
  }
  const merged = mergeByPathOrder(scans);
  const users = cap(merged, USER_TOTAL_LIMIT);
  return {
    dirs, scannedDirs, commands: users.items, total: merged.length, truncated: users.truncated,
  };
}

/**
 * 最近一次创建的 Agent 作用域。
 *
 * 【为什么需要】会话级组合的工具（`subagent`、`spawn_teammate`、`team_task_*`、
 * `schedule_*`、`cordis_inspect_*`、`plugin_manager`）只在 **Agent 自己的视图**里可见 ——
 * 服务契约的原话是 "delegation tools are composed for a Session"。借预设作用域
 * （`agentPresets.acquireScope()`，官方用途是 cold transcript presentation）读到的是
 * **冷启动视图**：实测 26 个，而当前会话实际有 40 个。
 *
 * `agent/created` 事件的契约是 `(this: Scoped<Agent>, payload: { agent, … })` ——
 * `this` 就是该 agent 的作用域对象，而 `ScopeKey` 就是 `object`，所以拿它当 scope
 * 调 `tools.schemas(this)` 即可读到该会话真实的工具视图。
 */
let liveAgentScope;
/** 最近一次创建的那个 agent 的 id（只用于界面标注来源）。 */
let liveAgentId;

/** 运行时目录里，值得列出来的可执行文件。 */
const RUNTIME_BINARIES = ['node', 'python3'];

/**
 * 找出 DSH 自带的运行时（由 harness 提供，不是用户装的），与 PATH 里的命令区分开。
 *
 * 两个来源，缺一不可：
 *   1. **当前宿主进程自己**（`process.execPath`）—— 桌面版跑在 app 自带的 node 上，
 *      这一条就是"实际在跑的是什么"。
 *   2. **`$DSH_HOME/dsh-runtimes/<runtime>/dependencies/<dep>/bin/*`** —— CLI 侧安装的
 *      node / python。
 *
 * 【踩过的坑】早先只从 `process.execPath` 旁边推 python 路径（`../python/bin/python3`）。
 * 那在 CLI 启动时成立，但在**桌面版下必然失败** —— app 的 node 旁边没有 python，
 * 于是界面上只有一个 node、python 凭空消失。改成扫运行时目录后两种启动方式都能列全。
 *
 * @returns `[{ name, path, version }]`。
 */
async function scanHarnessRuntimes() {
  const runtimes = [];
  const seen = new Set();

  /** 收一个运行时（按真实路径去重，探一次版本）。 */
  const collect = async (binaryName, filePath) => {
    if (typeof filePath !== 'string' || filePath === '' || seen.has(filePath)) return;
    if (!existsSync(filePath)) return;
    seen.add(filePath);
    runtimes.push({ name: binaryName, path: filePath, version: await runProbe(filePath, ['--version']) });
  };

  await collect('node', process.execPath);

  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const runtimesRoot = join(dshHome, 'dsh-runtimes');
  let runtimeNames = [];
  try {
    runtimeNames = await readdir(runtimesRoot);
  } catch {
    runtimeNames = []; // 没装 CLI 运行时也正常（纯桌面版环境）
  }
  for (const runtimeName of runtimeNames) {
    const dependenciesRoot = join(runtimesRoot, runtimeName, 'dependencies');
    let dependencyNames = [];
    try {
      dependencyNames = await readdir(dependenciesRoot);
    } catch {
      continue;
    }
    for (const dependencyName of dependencyNames) {
      const binDir = join(dependenciesRoot, dependencyName, 'bin');
      let binaries = [];
      try {
        binaries = await readdir(binDir);
      } catch {
        continue;
      }
      for (const binary of binaries) {
        if (!RUNTIME_BINARIES.includes(binary)) continue;
        await collect(binary, join(binDir, binary));
      }
    }
  }
  return runtimes;
}

/**
 * 读取「我能用什么」：工具 / 技能 / MCP。
 *
 * 【为什么放在宿主】这三样都在宿主服务里（`ctx.tools` / `ctx.skills` / MCP 工具注册进
 * `ctx.tools`），浏览器半边读不到。全部**只读**、全部**容错**：服务不存在（旧宿主、
 * 未装对应 bundle）或抛错都只是留空，绝不让整页失败。
 *
 * 与"这台机器上有什么可执行文件"相比，这才是**能力清单**：`tools.schemas()` 就是每次
 * 真正发给 Agent 的那批工具，换预设或加 MCP 服务器都会跟着变。
 *
 * @param ctx - 插件上下文。
 * @returns `{ tools, skills, mcp: { servers, tools } }`。
 */
async function scanCapabilities(ctx) {
  const tools = [];
  const mcpTools = [];
  let toolsScope = { preset: undefined, scoped: false };

  // 工具注册表。
  //
  // 【为什么必须带 scope】`tools.schemas()` 省略 scope 拿到的是**全局视图** ——
  // 实测只有 1 个（load_workspace_dependencies 这类不带作用域的），而 Agent 真正
  // 拿到的是 40 个：read/write/bash/web_search/subagent… 都注册在**预设作用域**里。
  // 契约原文：`schemas(scope?)` 的 scope 是"the viewing scope (the agent);
  // omitted = the global view"。
  //
  // 所以这里借一个预设作用域的租约（`agentPresets.acquireScope()`，官方给的用法是
  // "cold transcript presentation"：拿租约 → 读 → 释放），读完立刻释放。
  try {
    const registry = ctx.get('tools');
    if (registry !== undefined && typeof registry.schemas === 'function') {
      const presets = ctx.get('agentPresets');
      let lease;
      let presetId;
      // 首选当前会话的 agent 作用域（视图最全）；拿不到才借预设作用域
      const usingLive = liveAgentScope !== undefined;
      if (!usingLive && presets !== undefined && typeof presets.acquireScope === 'function') {
        try {
          if (typeof presets.resolve === 'function') {
            const preset = await presets.resolve();
            presetId = preset !== undefined && preset !== null ? preset.id : undefined;
          }
          lease = await presets.acquireScope();
        } catch {
          lease = undefined; // 拿不到作用域就退回全局视图，不让整页失败
        }
      }
      try {
        const effectiveScope = usingLive ? liveAgentScope : (lease === undefined ? undefined : lease.key);
        const visible = registry.schemas(effectiveScope);
        if (Array.isArray(visible)) {
          toolsScope = {
            preset: presetId,
            scoped: effectiveScope !== undefined,
            live: usingLive,
            sessionId: usingLive ? liveAgentId : undefined,
          };
          for (const raw of visible) {
            const entry = normalizeTool(raw);
            if (entry === null) continue;
            if (entry.mcp === null) {
              tools.push({
                name: entry.name, description: entry.description, params: entry.params, required: entry.required,
              });
            } else {
              mcpTools.push({
                name: entry.name, server: entry.mcp.server, tool: entry.mcp.tool,
                description: entry.description, params: entry.params, required: entry.required,
              });
            }
          }
        }
      } finally {
        // 官方要求：读完就释放租约（AsyncDisposable）。
        if (lease !== undefined) {
          const dispose = typeof lease[Symbol.asyncDispose] === 'function'
            ? lease[Symbol.asyncDispose].bind(lease)
            : (typeof lease.dispose === 'function' ? lease.dispose.bind(lease) : undefined);
          if (dispose !== undefined) {
            try { await dispose(); } catch { /* 释放失败不该影响这次读 */ }
          }
        }
      }
    }
  } catch {
    // 服务不可用/接口变了：留空即可，页面会如实显示 0
  }

  // 技能注册表（`~/.dsh/skills` 与各技能提供者都会汇总到这里）
  const skills = [];
  try {
    const registry = ctx.get('skills');
    if (registry !== undefined && typeof registry.list === 'function') {
      for (const raw of await registry.list()) {
        const entry = normalizeSkill(raw);
        if (entry !== null) skills.push(entry);
      }
    }
  } catch {
    // 同上
  }

  const summary = summarizeCapabilities(tools, skills, mcpTools);
  return {
    tools: sortByName(tools),
    skills: sortByName(skills),
    mcp: { servers: summary.mcpServers, tools: sortByName(mcpTools) },
    toolsScope,
  };
}

/**
 * 组装完整数据。
 * @param ctx - 插件上下文（能力段需要读宿主服务）。
 * @returns 响应对象。
 */
async function buildReport(ctx) {
  const { dirs, scannedDirs, commands, truncated, total } = await scanCommands();
  const [versions, runtimes] = await Promise.all([probeVersions(commands), scanHarnessRuntimes()]);
  const capabilities = await scanCapabilities(ctx);
  const entries = [
    ...runtimes.map((runtime) => ({ ...runtime, path: tilde(runtime.path), source: 'harness' })),
    // 只发 name/path/version：`dir` 对界面没用，而且是**未缩略的绝对路径** ——
    // 漏出去等于把家目录里的用户名一并发出（这条是被 test/host-smoke.mjs 抓到的）。
    ...commands.map((command) => ({
      name: command.name,
      path: tilde(command.path),
      source: 'path',
      version: versions.get(command.name) ?? null,
    })),
  ];
  return {
    ok: true,
    scannedAt: Date.now(),
    capabilities,
    platform: process.platform + '/' + process.arch,
    nodeVersion: process.versions.node,
    pathCount: dirs.length,
    scannedDirCount: scannedDirs,
    pathDirs: dirs.map(tilde),
    total,
    truncated,
    entries,
  };
}

// 【为什么没有缓存】原先扫描要 800ms（1270 次 stat），所以加了 15 秒缓存 + 「重新扫描」
// 按钮。现在系统目录整个不扫了，剩下的只有个位数条目，一次全量扫描是毫秒级 ——
// 缓存与刷新按钮都成了多余的机关，去掉更简单，也永远是新的。

/**
 * 宿主入口：注册只读数据路由。
 * @param ctx - 插件上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIST_PATH,
    handler: async (req, res) => {
      const guard = allowRequest(req);
      if (!guard.ok) {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: 'dsh-cli-inventory: ' + guard.reason }));
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      try {
        const report = await buildReport(ctx);
        const body = JSON.stringify(report);
        if (body.length > MAX_BODY) throw new Error('report too large');
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
      }
    },
  }), 'cli-inventory: /api/cli-inventory/list route');
  // 记下存活 Agent 的作用域：会话级工具只在它自己的视图里可见。
  // 用普通 function 而不是箭头函数 —— 作用域是通过 `this` 传进来的。
  // ctx.on 是 cordis 核心能力（官方指南也这么用），这里仍加一层守卫：
  // 监听不到 agent 只会退化成"冷启动视图"，不该让整个插件挂掉。
  ctx.effect(() => (typeof ctx.on === 'function'
    ? ctx.on('agent/created', function captureAgentScope(payload) {
      liveAgentScope = this;
      liveAgentId = payload !== null && typeof payload === 'object' && payload.agent !== null
        && typeof payload.agent === 'object' && typeof payload.agent.id === 'string'
        ? payload.agent.id
        : undefined;
    })
    : undefined), 'cli-inventory: agent scope capture');
}

export { apply, inject, name };

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
import { delimiter, dirname, join, resolve } from 'node:path';
import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, probeArgsFor } from './lib/allowlist.js';
import {
  PER_DIR_LIMIT, SYSTEM_TOTAL_LIMIT, USER_TOTAL_LIMIT,
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
  const scopes = new Map();
  for (const dir of dirs) {
    const scope = classifyDir(dir, home);
    scopes.set(dir, scope);
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
  const merged = mergeByPathOrder(scans)
    .map((command) => ({ ...command, scope: scopes.get(command.dir) === 'system' ? 'system' : 'user' }));
  // 分类限流：先保证"你自己装的"全在，再拿剩下的额度放系统工具。
  const users = cap(merged.filter((command) => command.scope === 'user'), USER_TOTAL_LIMIT);
  const systems = cap(merged.filter((command) => command.scope === 'system'), SYSTEM_TOTAL_LIMIT);
  return {
    dirs,
    commands: [...users.items, ...systems.items],
    total: merged.length,
    scopeCounts: { user: users.items.length, system: systems.items.length },
    truncated: users.truncated || systems.truncated,
  };
}

/**
 * 找出 DSH 自带的运行时（由 harness 提供，不是用户装的），与 PATH 里的命令区分开。
 * @returns `[{ name, path, version }]`。
 */
async function scanHarnessRuntimes() {
  const runtimes = [];
  const execPath = process.execPath;
  if (typeof execPath === 'string' && execPath !== '') {
    runtimes.push({ name: 'node', path: execPath, version: await runProbe(execPath, ['--version']) });
  }
  // 由 node 的位置推出同级 python：<runtime>/dependencies/{node,python}/bin/*
  const candidates = [resolve(dirname(execPath), '..', '..', 'python', 'bin', 'python3')];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    runtimes.push({ name: 'python3', path: candidate, version: await runProbe(candidate, ['--version']) });
  }
  return runtimes;
}

/**
 * 组装完整数据。
 * @returns 响应对象。
 */
async function buildReport() {
  const { dirs, commands, truncated, total, scopeCounts } = await scanCommands();
  const [versions, runtimes] = await Promise.all([probeVersions(commands), scanHarnessRuntimes()]);
  const entries = [
    ...runtimes.map((runtime) => ({ ...runtime, path: tilde(runtime.path), source: 'harness' })),
    // 只发 name/path/version：`dir` 对界面没用，而且是**未缩略的绝对路径** ——
    // 漏出去等于把家目录里的用户名一并发出（这条是被 test/host-smoke.mjs 抓到的）。
    ...commands.map((command) => ({
      name: command.name,
      path: tilde(command.path),
      source: 'path',
      scope: command.scope,
      version: versions.get(command.name) ?? null,
    })),
  ];
  return {
    ok: true,
    scannedAt: Date.now(),
    platform: process.platform + '/' + process.arch,
    nodeVersion: process.versions.node,
    pathCount: dirs.length,
    pathDirs: dirs.map(tilde),
    total,
    scopeCounts,
    truncated,
    entries,
  };
}

/**
 * 扫描结果的短缓存。
 *
 * 一次全量扫描约 800 ms（1270 次 stat + 十几次白名单探测）。设置在页面上被打开时没必要
 * 每次都重扫，所以同一份结果在 {@link CACHE_TTL_MS} 内直接复用；界面上的「重新扫描」按钮
 * 会带上 `?fresh=1` 绕过缓存，保证按钮按下去一定是最新的。
 */
const CACHE_TTL_MS = 15000;
let cache = { at: 0, report: null };

/**
 * 取报告（按需重扫）。
 * @param fresh - 是否强制绕过缓存。
 * @returns 报告对象。
 */
async function reportFor(fresh) {
  const now = Date.now();
  if (fresh !== true && cache.report !== null && now - cache.at < CACHE_TTL_MS) return cache.report;
  const report = await buildReport();
  cache = { at: Date.now(), report };
  return report;
}

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
        let fresh = false;
        if (typeof req.url === 'string' && req.url !== '') {
          try {
            fresh = new URL(req.url, 'http://127.0.0.1').searchParams.get('fresh') === '1';
          } catch {
            fresh = false;
          }
        }
        const report = await reportFor(fresh);
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
}

export { apply, inject, name };

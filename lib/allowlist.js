/**
 * 版本探测**白名单**。
 *
 * 【为什么必须有白名单】
 *   枚举 PATH 只是读目录，安全；但取版本要**执行**二进制。若对扫到的每个可执行文件都跑
 *   一遍 `--version`，就等于让插件执行用户 PATH 里的任意程序 —— 这是不可接受的设计。
 *   所以只对一个**写死在源码里的清单**执行，且固定参数、带超时、只读第一行输出。
 *
 *   白名单之外的命令照常出现在列表里（名称 + 路径），只是**不执行**。
 *
 * 【新增条目】必须是"无副作用、会打印版本后退出"的命令；参数写死，不接受用户输入。
 *
 * @module dsh-cli-inventory/allowlist
 */

/** 单次探测超时（毫秒）。超时即视为"取不到版本"，不影响其余条目。 */
export const PROBE_TIMEOUT_MS = 5000;

/** 并发探测数上限。条数本身已被白名单限定（≤ 表长），这里防的是同时拉起太多进程。 */
export const PROBE_CONCURRENCY = 6;

/**
 * 命令 → 版本参数。顺序即探测优先级（越靠前越先占配额）。
 * @type {ReadonlyArray<{ name: string, args: readonly string[] }>}
 */
export const VERSION_PROBES = Object.freeze([
  // 版本控制
  { name: 'git', args: ['--version'] },
  { name: 'gh', args: ['--version'] },
  { name: 'glab', args: ['--version'] },
  // 语言运行时
  { name: 'node', args: ['--version'] },
  { name: 'deno', args: ['--version'] },
  { name: 'bun', args: ['--version'] },
  { name: 'go', args: ['version'] },
  { name: 'rustc', args: ['--version'] },
  { name: 'java', args: ['-version'] },
  { name: 'ruby', args: ['--version'] },
  { name: 'php', args: ['--version'] },
  { name: 'python3', args: ['--version'] },
  // 包管理器
  { name: 'npm', args: ['--version'] },
  { name: 'pnpm', args: ['--version'] },
  { name: 'yarn', args: ['--version'] },
  { name: 'uv', args: ['--version'] },
  { name: 'pip3', args: ['--version'] },
  { name: 'cargo', args: ['--version'] },
  { name: 'brew', args: ['--version'] },
  { name: 'port', args: ['version'] },
  // 常用工具
  { name: 'jq', args: ['--version'] },
  { name: 'yq', args: ['--version'] },
  { name: 'rg', args: ['--version'] },
  { name: 'fd', args: ['--version'] },
  { name: 'fzf', args: ['--version'] },
  { name: 'curl', args: ['--version'] },
  { name: 'wget', args: ['--version'] },
  { name: 'docker', args: ['--version'] },
  { name: 'kubectl', args: ['version', '--client'] },
  { name: 'terraform', args: ['--version'] },
  { name: 'make', args: ['--version'] },
  { name: 'cmake', args: ['--version'] },
  { name: 'gcc', args: ['--version'] },
  { name: 'clang', args: ['--version'] },
  { name: 'ffmpeg', args: ['-version'] },
  { name: 'tmux', args: ['-V'] },
  { name: 'vim', args: ['--version'] },
  { name: 'nvim', args: ['--version'] },
  { name: 'code', args: ['--version'] },
]);

/** 名字 → 参数 的查表（构建一次，避免每次线性找）。 */
const PROBE_BY_NAME = new Map(VERSION_PROBES.map((probe) => [probe.name, probe.args]));

/**
 * 取某命令的版本参数。
 * @param name - 命令名。
 * @returns 参数数组；不在白名单时返回 undefined（调用方据此跳过执行）。
 */
export function probeArgsFor(name) {
  return PROBE_BY_NAME.get(name);
}

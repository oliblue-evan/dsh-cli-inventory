/**
 * PATH 扫描的**纯逻辑**（零依赖、可被普通 node 进程直接单测）。
 *
 * 与 `index.js`（真正碰文件系统）分开是有意的：这一层只做"给定输入怎么算"，
 * 所以不需要伪造文件系统就能把边界情况测干净（路径顺序、同名去重、可执行位、
 * 截断、版本行清洗）。
 *
 * @module dsh-cli-inventory/path-scan
 */

/**
 * 单个目录最多收集多少个可执行文件。
 *
 * 实测本机 `/usr/bin` 有 932 项、全部 PATH 合计 1271 项（约 100 KB JSON），所以这里
 * 只是**防止病态目录塞爆响应**的保险丝，不是常规限流：全量发出才能让界面上的搜索是完整的。
 */
export const PER_DIR_LIMIT = 2000;

/** 「你自己装的」条目总量上限（实测只有个位数，这里是保险丝）。 */
export const USER_TOTAL_LIMIT = 400;

/** 系统自带条目总量上限（覆盖 1271 的实际规模，留出余量）。 */
export const SYSTEM_TOTAL_LIMIT = 1400;

/** 系统自带的目录（判定用，见 {@link classifyDir}）。 */
const SYSTEM_DIRS = new Set(['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/libexec']);

/** 系统自带的目录前缀。 */
const SYSTEM_PREFIXES = ['/System/', '/Library/Apple/', '/usr/lib/'];

/**
 * 判断一个 PATH 目录算"系统自带"还是"你自己装的"。
 *
 * 【为什么需要】`/usr/bin` 这类目录动辄上千项，而用户真正关心的（`~/.local/bin`、
 * `~/.cargo/bin`、`/opt/homebrew/bin`）往往在 PATH 后面。如果不加区分地按总量截断，
 * 就会**把用户装的工具挤掉、只留下系统工具** —— 那正好回答错了用户的问题。
 * 所以分类之后各自限流，「你自己装的」永远不会被系统目录挤出去。
 *
 * `/usr/local/bin` 与 `/opt/**` 归为"你自己装的"：那是安装器/包管理器落地的地方。
 *
 * @param dir - PATH 里的一个目录。
 * @param home - 家目录（用于判定 `~` 下的一切）。
 * @returns `'user'` 或 `'system'`。
 */
export function classifyDir(dir, home) {
  if (typeof dir !== 'string' || dir === '') return 'user';
  if (typeof home === 'string' && home !== '' && home !== '/' && (dir === home || dir.startsWith(home + '/'))) {
    return 'user';
  }
  if (SYSTEM_DIRS.has(dir)) return 'system';
  for (const prefix of SYSTEM_PREFIXES) {
    if (dir.startsWith(prefix)) return 'system';
  }
  return 'user';
}

/**
 * 拆解 PATH。
 *
 * 空段按 POSIX 语义视为当前目录（这里保留为空串以如实反映），重复目录只留第一次出现
 * 的位置（PATH 里重复很常见，重复扫描没有意义）。
 *
 * @param pathValue - `process.env.PATH` 的值。
 * @param delimiter - 分隔符；Windows 是 `;`，POSIX 是 `:`。由调用方传入
 *   （宿主半边用 `node:path` 的 `delimiter`），保持本函数零依赖。
 * @returns 目录列表（顺序即优先级）。
 */
export function splitPath(pathValue, delimiter = ':') {
  if (typeof pathValue !== 'string' || pathValue === '') return [];
  const seen = new Set();
  const dirs = [];
  for (const raw of pathValue.split(delimiter)) {
    const dir = raw === '' ? '.' : raw;
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * 一个目录条目是否算"可执行命令"。
 *
 * 只看常规文件的执行位；目录即使可执行也不算命令。带 `.` 的条目按 shell 惯例保留
 * （`pip3.12`、`python3.12` 这类是常见命名），符号链接由调用方先解析。
 *
 * @param entry - `{ name, isFile, isDirectory, mode }`。
 * @returns 是否计入。
 */
export function isCommandEntry(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  if (typeof entry.name !== 'string' || entry.name === '') return false;
  if (entry.name.startsWith('.')) return false; // 隐藏文件不是命令
  if (entry.isDirectory === true) return false;
  if (entry.isFile !== true) return false;
  return (entry.mode & 0o111) !== 0;
}

/**
 * 把各目录扫到的条目合并成"PATH 顺序优先"的命令表。
 *
 * 与 `which` 语义一致：**先出现的目录赢**；同一目录内按名称排序保证输出稳定。
 *
 * @param scans - `[{ dir, entries }]`，顺序即 PATH 顺序。
 * @returns `[{ name, path, dir }]`，按名称排序。
 */
export function mergeByPathOrder(scans) {
  const byName = new Map();
  for (const scan of scans) {
    if (scan === null || typeof scan !== 'object' || !Array.isArray(scan.entries)) continue;
    for (const name of scan.entries) {
      if (typeof name !== 'string' || name === '' || byName.has(name)) continue;
      byName.set(name, { name, dir: scan.dir, path: joinDir(scan.dir, name) });
    }
  }
  return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * 拼出绝对路径（纯字符串拼接，不碰文件系统）。
 * @param dir - 目录。
 * @param name - 文件名。
 * @returns 路径。
 */
export function joinDir(dir, name) {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/**
 * 清洗 `--version` 的输出。
 *
 * 真实世界的输出五花八门：多行、末尾空行、CR、ANSI 颜色、前面还可能有警告。
 * 这里取**第一条非空行**、去 ANSI、限长，够用且不会把整段 help 灌进界面。
 *
 * @param stdout - 进程输出。
 * @param maxLength - 最大长度，默认 120。
 * @returns 版本字符串；无有效内容时返回 null。
 */
export function parseVersion(stdout, maxLength = 120) {
  if (typeof stdout !== 'string') return null;
  const withoutAnsi = stdout.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  for (const line of withoutAnsi.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
  }
  return null;
}

/**
 * 按上限截断列表。
 * @param items - 列表。
 * @param limit - 上限。
 * @returns `{ items, truncated }`。
 */
export function cap(items, limit) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= limit) return { items: list, truncated: false };
  return { items: list.slice(0, limit), truncated: true };
}

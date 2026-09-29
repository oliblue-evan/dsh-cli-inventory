/**
 * 「我能用什么」的纯逻辑：工具 / 技能 / MCP 条目的识别与归一化。
 *
 * 与 `path-scan.js` 同样的分工：这里只做"给定输入怎么算"，不碰任何服务，
 * 所以边界情况（脏条目、MCP 名字拆解、排序）都能直接单测。
 *
 * @module dsh-cli-inventory/capabilities
 */

/**
 * MCP 工具的命名前缀。
 *
 * 【怎么知道的】`dsh-mcp-client` 里工具是这么注册的：
 *   `const publicName = publicToolName(opts.serverName, tool.name)`
 * 而 `publicToolName` 的形态就是 `mcp__<serverName>__<rawName>`。
 * 所以**服务器名可以从工具名反推出来**，不必去读 MCP 的配置。
 */
export const MCP_TOOL_PREFIX = 'mcp__';

/**
 * 拆解 MCP 工具名。
 *
 * 只按**第一个** `__` 切分：服务器名里出现单个下划线是常见的，按最后一段切会把它们拆坏。
 *
 * @param name - 工具名。
 * @returns `{ server, tool }`；不是 MCP 工具时返回 null。
 */
export function parseMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const cut = rest.indexOf('__');
  if (cut <= 0 || cut + 2 >= rest.length) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/**
 * 从一个工具的参数 JSON Schema 里取出参数名与必填项。
 *
 * 契约里 `ToolSchema.parameters` 的类型是 `Record<string, unknown>`（宿主只承诺
 * "是个对象"），所以这里**逐层做类型守卫**：形状不对就当没有参数，绝不抛错。
 *
 * @param parameters - 参数 schema。
 * @returns `{ params, required }`。
 */
export function readParameters(parameters) {
  const empty = { params: [], required: [] };
  if (parameters === null || typeof parameters !== 'object') return empty;
  const properties = parameters.properties;
  const params = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties).filter((key) => key !== '')
    : [];
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((name) => typeof name === 'string' && name !== '')
    : [];
  return { params, required };
}

/**
 * 归一化一条工具注册表条目（`tools.schemas()` 的一项）。
 *
 * 取名称、描述与参数名/必填项，**忽略其余**：注册表条目的完整形状随宿主版本演进，
 * 只依赖这几个字段最不容易被升级打断。
 *
 * 参数列表是"展开这张卡才有内容"的关键 —— 工具卡的文字部分就是描述，
 * 没有参数的话展开只是取消截断（说明本来就短的工具点了等于没反应）。
 *
 * @param schema - 注册表条目。
 * @returns `{ name, description, params, required, mcp }`；无法识别时返回 null。
 */
export function normalizeTool(schema) {
  if (schema === null || typeof schema !== 'object') return null;
  const name = schema.name;
  if (typeof name !== 'string' || name === '') return null;
  const description = typeof schema.description === 'string' ? schema.description : '';
  const { params, required } = readParameters(schema.parameters);
  return { name, description, params, required, mcp: parseMcpToolName(name) };
}

/**
 * 归一化一条技能摘要（`skills.list()` 的一项）。
 *
 * `source` / `provider` 在契约里可能是联合类型或对象，所以只在**确实是字符串**时采用，
 * 免得把 `[object Object]` 渲染到界面上。
 *
 * @param summary - 技能摘要。
 * @returns `{ name, description, provider, whenToUse }`；无法识别时返回 null。
 */
export function normalizeSkill(summary) {
  if (summary === null || typeof summary !== 'object') return null;
  const name = summary.name;
  if (typeof name !== 'string' || name === '') return null;
  const text = (value) => (typeof value === 'string' && value !== '' ? value : undefined);
  return {
    name,
    description: text(summary.description) === undefined ? '' : summary.description,
    provider: text(summary.provider),
    whenToUse: text(summary.whenToUse),
  };
}

/**
 * 按名称排序（不改动入参）。
 * @param list - 条目数组。
 * @returns 新数组。
 */
export function sortByName(list) {
  const items = Array.isArray(list) ? list : [];
  return [...items].sort((left, right) => String(left.name === undefined ? '' : left.name)
    .localeCompare(String(right.name === undefined ? '' : right.name)));
}

/**
 * 把工具与技能摘要成"能力画像"。
 *
 * @param tools - 归一化后的工具。
 * @param skills - 归一化后的技能。
 * @param mcpTools - 归一化后的 MCP 工具。
 * @returns `{ tools, skills, mcpServers, mcpTools }`（均为计数或名称列表）。
 */
export function summarizeCapabilities(tools, skills, mcpTools) {
  const toolList = Array.isArray(tools) ? tools : [];
  const skillList = Array.isArray(skills) ? skills : [];
  const mcpList = Array.isArray(mcpTools) ? mcpTools : [];
  const servers = [];
  for (const entry of mcpList) {
    if (entry !== null && typeof entry === 'object' && typeof entry.server === 'string' && !servers.includes(entry.server)) {
      servers.push(entry.server);
    }
  }
  return { tools: toolList.length, skills: skillList.length, mcpServers: servers, mcpTools: mcpList.length };
}

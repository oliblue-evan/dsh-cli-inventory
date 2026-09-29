/**
 * 环境与能力 —— 客户端半边：**「设置」里的一个页面**。
 *
 * 【这一页回答什么问题】不是"这台机器上装了哪些文件"，而是
 * **"这个 Agent 到底能操作什么"**：工具注册表（真正发给模型的那批工具）、
 * 技能注册表、MCP 服务器贡献的工具，然后是命令行工具与运行时。
 * 系统自带的上千项只是兜底信息，默认折叠。
 *
 * 【本文件的组织方式】
 *   客户端 bundle **必须是单文件**：宿主把各插件的 bundle 拼接成一个 combo 脚本、
 *   以**传统脚本**执行（`window.__ModuleLoader__` 处于 queue 模式，只登记工厂函数），
 *   所以这里写 ES 相对 import 并不成立。用「目录 + 显式 region 标记」代替拆文件：
 *
 *     1. 纯逻辑     过滤 / 分组 / 排序 / 范围 / 摘要 / 截断（不含 React/DOM，可被测试抽取）
 *     2. 文案       中英词典
 *     3. 样式       CSS，数值与 token 对齐宿主
 *     4. 组件       设置页本体
 *     5. apply      注册到 settings.section
 *
 *   第 1 节包在 `#region 纯逻辑` 里，`test/extract-client.mjs` 按标记抽取后直接单测。
 *
 * 【三条纪律】（都是踩过的坑）
 *   · 样式在 `apply` 里幂等注入、不随 dispose 移除 —— 否则出现孤儿注册时页面会变成
 *     「组件还在、样式没了」。
 *   · `slots.inject` 返回 dispose 函数，**必须**用 `ctx.effect` 包住，否则注册会泄漏。
 *   · 内联 SVG 必须写死宽高：只有 viewBox 的 SVG 在没有 CSS 时会撑满容器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cli-inventory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    // ========================================================================
    // 1. 纯逻辑（不含 React/DOM）
    // ========================================================================

    // #region 纯逻辑

    /** 每段最多渲染多少行；其余靠搜索缩小范围。 */
    const ROW_LIMIT = 80;

    /** 命令行部分可选的范围（能力段不受它影响）。 */
    const SCOPES = ['user', 'system', 'all'];

    /**
     * 按关键词过滤条目。
     *
     * 同一函数同时服务于**能力条目**（名称/描述/何时使用）与**命令条目**
     * （名称/版本/路径/所属服务器）—— 检索字段取并集就够用，不必写两个近似函数。
     *
     * @param entries - 条目数组。
     * @param query - 关键词。
     * @returns 过滤后的数组（无关键词时原样返回）。
     */
    function filterEntries(entries, query) {
      const list = Array.isArray(entries) ? entries : [];
      const needle = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
      if (needle === '') return list;
      return list.filter((entry) => {
        if (entry === null || typeof entry !== 'object') return false;
        return [entry.name, entry.description, entry.whenToUse, entry.version, entry.path, entry.server]
          .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
      });
    }

    /**
     * 分三段：**DSH 自带运行时** / **你自己装的** / **系统自带**。
     * @param entries - 条目数组。
     * @returns `{ runtimes, user, system }`。
     */
    function groupEntries(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const usable = list.filter((entry) => entry !== null && typeof entry === 'object');
      return {
        runtimes: usable.filter((entry) => entry.source === 'harness'),
        user: usable.filter((entry) => entry.source !== 'harness' && entry.scope !== 'system'),
        system: usable.filter((entry) => entry.source !== 'harness' && entry.scope === 'system'),
      };
    }

    /**
     * 排序：**取到版本的排前面**（有版本信息量更大），同组内按名称。
     * @param entries - 条目数组。
     * @returns 新数组（不改原数组）。
     */
    function sortForDisplay(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const hasVersion = (entry) => entry !== null && typeof entry === 'object'
        && typeof entry.version === 'string' && entry.version !== '';
      return [...list].sort((left, right) => {
        const leftHas = hasVersion(left);
        const rightHas = hasVersion(right);
        if (leftHas !== rightHas) return leftHas ? -1 : 1;
        return String(left.name === undefined ? '' : left.name)
          .localeCompare(String(right.name === undefined ? '' : right.name));
      });
    }

    /**
     * 实际生效的范围。**有关键词就按「全部」找**（否则搜系统命令会一无所获）。
     * @param scope - 用户选的范围。
     * @param query - 搜索关键词。
     * @returns `'user' | 'system' | 'all'`。
     */
    function resolveScope(scope, query) {
      const searching = String(query === undefined || query === null ? '' : query).trim() !== '';
      if (searching) return 'all';
      return SCOPES.includes(scope) ? scope : 'user';
    }

    /**
     * 某个范围内该渲染哪几段**命令行**（能力段始终显示）。
     * @param scope - 生效范围。
     * @returns 段名数组。
     */
    function visibleGroups(scope) {
      if (scope === 'system') return ['system'];
      if (scope === 'all') return ['runtimes', 'user', 'system'];
      return ['runtimes', 'user'];
    }

    /**
     * 从宿主报告里取出要显示的数字。
     * @param report - 宿主返回的报告。
     * @returns 计数对象。
     */
    function summarize(report) {
      const source = report !== null && typeof report === 'object' ? report : {};
      const entries = Array.isArray(source.entries) ? source.entries : [];
      const commands = entries.filter((entry) => entry !== null && typeof entry === 'object' && entry.source !== 'harness');
      const caps = source.capabilities !== null && typeof source.capabilities === 'object' && source.capabilities !== undefined
        ? source.capabilities
        : {};
      const count = (value) => (Array.isArray(value) ? value.length : 0);
      const mcp = caps.mcp !== null && typeof caps.mcp === 'object' && caps.mcp !== undefined ? caps.mcp : {};
      const counts = source.scopeCounts !== null && typeof source.scopeCounts === 'object' && source.scopeCounts !== undefined
        ? source.scopeCounts
        : {};
      const countOf = (key, fallback) => (Number(counts[key]) > 0 ? Number(counts[key]) : fallback);
      return {
        tools: count(caps.tools),
        skills: count(caps.skills),
        mcpServers: count(mcp.servers),
        mcpTools: count(mcp.tools),
        pathCount: Number(source.pathCount) || 0,
        total: Number(source.total) || commands.length,
        withVersion: entries.filter(
          (entry) => entry !== null && typeof entry === 'object' && typeof entry.version === 'string' && entry.version !== '',
        ).length,
        user: countOf('user', commands.filter((entry) => entry.scope !== 'system').length),
        system: countOf('system', commands.filter((entry) => entry.scope === 'system').length),
        truncated: source.truncated === true,
      };
    }

    /**
     * 行数截断（默认 {@link ROW_LIMIT}）。
     * @param entries - 要渲染的条目。
     * @param limit - 上限。
     * @returns `{ rows, hidden }`。
     */
    function capRows(entries, limit) {
      const list = Array.isArray(entries) ? entries : [];
      const max = Number.isFinite(limit) && limit > 0 ? limit : ROW_LIMIT;
      return { rows: list.slice(0, max), hidden: Math.max(0, list.length - max) };
    }

    // #endregion 纯逻辑

    // ========================================================================
    // 2. 文案
    // ========================================================================

    const NS = 'cli-inventory';
    /** 宿主路由。 */
    const API = '/api/cli-inventory/list';

    const ZH = {
      'nav': '环境与能力',
      'title': '环境与能力',
      'refresh': '重新扫描',
      'loading': '正在读取…',
      'search': '搜索工具、技能、命令…',
      'searchAll': '搜索时在所有范围内查找',
      'scopeLabel': '命令行范围',
      'scope.user': '自己装的',
      'scope.system': '系统自带',
      'scope.all': '全部',
      'group.tools': '工具',
      'group.skills': '技能',
      'group.mcp': 'MCP',
      'group.runtimes': 'DSH 自带运行时',
      'group.user': '你自己安装的',
      'group.system': '系统自带',
      'summaryCaps': '工具 {tools} · 技能 {skills} · MCP 服务器 {mcpServers}',
      'summary': 'PATH {dirs} 个目录 · 命令 {total} 个 · 取到版本 {withVersion} 个',
      'breakdown': '你自己装的 {user} · 系统自带 {system}',
      'summaryTruncated': '（扫描已截断，只列出一部分）',
      'mcpServers': 'MCP 服务器：{servers}',
      'empty.tools': '读不到工具注册表（宿主未提供 tools 服务）。',
      'empty.skills': '还没有技能。',
      'empty.mcp': '还没有配置 MCP 服务器。',
      'hint.skills': '把技能放到 ~/.dsh/skills/<名字>/SKILL.md 就会出现；装了技能包插件也会汇总到这里。',
      'hint.mcp': '配置 MCP 服务器后，它们贡献的工具会出现在这里（命名形如 mcp__<服务器>__<工具>）。',
      'empty': '没有匹配项',
      'expand': '展开',
      'collapse': '收起',
      'hidden': '另有 {count} 项未显示，用上面的搜索缩小范围',
      'noVersion': '未取版本',
      'failed': '读取失败：{reason}',
      'note': '工具与技能来自宿主注册表（只读，容错：服务不可用就显示 0）；命令行工具只枚举 PATH 目录，且仅对内置白名单执行 `--version` 取版本。',
    };

    const EN = {
      'nav': 'Environment & capabilities',
      'title': 'Environment & capabilities',
      'refresh': 'Rescan',
      'loading': 'Reading…',
      'search': 'Search tools, skills, commands…',
      'searchAll': 'Searching across every scope',
      'scopeLabel': 'Command scope',
      'scope.user': 'Installed',
      'scope.system': 'System',
      'scope.all': 'All',
      'group.tools': 'Tools',
      'group.skills': 'Skills',
      'group.mcp': 'MCP',
      'group.runtimes': 'Bundled DSH runtimes',
      'group.user': 'Installed by you',
      'group.system': 'System',
      'summaryCaps': '{tools} tools · {skills} skills · {mcpServers} MCP servers',
      'summary': '{dirs} PATH directories · {total} commands · {withVersion} with a version',
      'breakdown': '{user} installed by you · {system} system',
      'summaryTruncated': ' (scan truncated; only part is listed)',
      'mcpServers': 'MCP servers: {servers}',
      'empty.tools': 'The tool registry is unavailable (no `tools` service on this host).',
      'empty.skills': 'No skills yet.',
      'empty.mcp': 'No MCP server configured yet.',
      'hint.skills': 'Drop one at ~/.dsh/skills/<name>/SKILL.md, or install a skills package — both surface here.',
      'hint.mcp': 'Once a server is configured, the tools it contributes appear here (named mcp__<server>__<tool>).',
      'empty': 'Nothing matches',
      'expand': 'Expand',
      'collapse': 'Collapse',
      'hidden': '{count} more hidden — narrow it with the search above',
      'noVersion': 'no version',
      'failed': 'Failed to read: {reason}',
      'note': 'Tools and skills come from the host registries (read-only, fault-tolerant: an unavailable service reads as 0). The command list only enumerates PATH directories, and executes `--version` for a built-in allowlist only.',
    };

    /**
     * 段 / 范围的文案 key 映射。
     *
     * 【为什么写成映射】拼字符串（`t('group.' + key)`）会让"词条有没有被引用"这类静态检查
     * 失效 —— 结构测试就因此把这些词条判成未使用过。写成映射后每个 key 都是字面量。
     */
    const GROUP_LABEL = {
      tools: 'group.tools',
      skills: 'group.skills',
      mcp: 'group.mcp',
      runtimes: 'group.runtimes',
      user: 'group.user',
      system: 'group.system',
    };
    const SCOPE_LABEL = { user: 'scope.user', system: 'scope.system', all: 'scope.all' };

    /**
     * 文案函数：优先框架绑定的 t，缺词典时退回本地中文。
     * @param props - 槽位属性，可能带 `t`。
     * @returns 取词函数。
     */
    function translator(props) {
      return (key, params) => {
        let text;
        if (typeof props.t === 'function') {
          try {
            text = props.t(key, params);
          } catch {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) {
          text = ZH[key] !== undefined ? ZH[key] : key;
        }
        if (params) {
          for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
        }
        return text;
      };
    }

    // ========================================================================
    // 3. 样式
    // ========================================================================

    const CSS = `
.ciPage{display:grid;gap:14px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:18px}
.ciHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ciTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.ciBtn{flex:none;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;
  color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.ciBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ciBtn[disabled]{cursor:default;opacity:.5;background:0 0}
.ciSummary,.ciBreakdown{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.ciChips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ciChip{padding:3px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:0 0;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;corner-shape:round}
.ciChip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ciChip[aria-selected="true"]{border-color:transparent;background:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary-foreground)}
.ciChipLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ciHint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ciSearch{box-sizing:border-box;width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;
  background:0 0;color:var(--dsw-alias-label-primary);font:inherit}
.ciSearch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ciGroup{display:grid;gap:0}
.ciGroupHead{display:flex;align-items:baseline;gap:8px;width:100%;padding:6px 0;border:0;background:0 0;
  color:var(--dsw-alias-label-primary);font:inherit;font-weight:500;text-align:left;cursor:pointer}
.ciGroupHead:hover .ciGroupTitle{color:var(--dsw-alias-brand-primary)}
.ciGroupHead[aria-expanded="false"] .ciChevron{transform:rotate(-90deg)}
.ciChevron{flex:none;align-self:center;width:12px;height:12px;transition:transform .12s ease}
.ciCount{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;font-variant-numeric:tabular-nums}
.ciMeta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.ciRows{display:grid;gap:0}
.ciRow{display:grid;grid-template-columns:minmax(70px,auto) minmax(110px,1fr) minmax(0,1.5fr);gap:12px;
  align-items:baseline;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ciCapRow{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);gap:12px;
  align-items:baseline;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ciRow:last-child,.ciCapRow:last-child{border-bottom:0}
.ciName{color:var(--dsw-alias-label-primary);font-weight:500}
.ciDesc{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ciVer{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ciVer[data-missing='true']{color:var(--dsw-alias-label-tertiary)}
.ciPath{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ciPath,.ciVer{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.ciEmpty,.ciNote{color:var(--dsw-alias-label-tertiary);font-size:12px}
.ciError{color:var(--dsw-alias-state-error-primary);font-size:12px}
`;

    // ========================================================================
    // 4. 组件
    // ========================================================================

    /** 稳定的空值（避免每次渲染都造新对象，破坏 useMemo 依赖）。 */
    const EMPTY_OBJECT = {};
    const EMPTY_MCP = { servers: [], tools: [] };

    /**
     * 折叠指示三角。
     * @param props.open - 是否展开。
     * @returns 内联 SVG（宽高写死：无 CSS 时才不会撑满容器）。
     */
    function ChevronIcon({ open }) {
      return h('svg', {
        viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'ciChevron',
      }, h('path', { d: open ? 'M2.5 4.5 6 8l3.5-3.5' : 'M4.5 2.5 8 6l-3.5 3.5' }));
    }

    /**
     * 一行命令（名称 / 版本 / 路径）。
     * @param props.entry - 命令条目。
     * @param props.t - 文案函数。
     * @returns 行元素。
     */
    function CommandRow({ entry, t }) {
      const hasVersion = typeof entry.version === 'string' && entry.version !== '';
      return h('div', { className: 'ciRow' },
        h('span', { className: 'ciName' }, entry.name),
        h('span', {
          className: 'ciVer',
          'data-missing': hasVersion ? 'false' : 'true',
          title: hasVersion ? entry.version : undefined,
        }, hasVersion ? entry.version : t('noVersion')),
        h('span', { className: 'ciPath', title: entry.path }, entry.path));
    }

    /**
     * 一行能力（工具 / 技能 / MCP 工具：名称 + 说明，说明前可带来源）。
     * @param props.entry - 能力条目。
     * @returns 行元素。
     */
    function CapabilityRow({ entry }) {
      const description = typeof entry.description === 'string' && entry.description !== ''
        ? entry.description
        : (typeof entry.whenToUse === 'string' ? entry.whenToUse : '');
      const meta = typeof entry.server === 'string' && entry.server !== ''
        ? entry.server
        : (typeof entry.provider === 'string' ? entry.provider : '');
      return h('div', { className: 'ciCapRow' },
        h('span', { className: 'ciName', title: entry.name }, entry.name),
        h('span', { className: 'ciDesc', title: description || undefined },
          meta === '' ? null : h('span', { className: 'ciMeta' }, meta + ' · '),
          description));
    }

    /**
     * 一段（可折叠：点标题栏展开/收起）。
     * @param props - `{ title, count, children, open, onToggle, t }`。
     * @returns 段元素。
     */
    function GroupSection({ title, count, children, open, onToggle, t }) {
      return h('div', { className: 'ciGroup' },
        h('button', {
          type: 'button',
          className: 'ciGroupHead',
          'aria-expanded': open,
          title: open ? t('collapse') : t('expand'),
          onClick: onToggle,
        },
          h(ChevronIcon, { open }),
          h('span', { className: 'ciGroupTitle' }, title),
          h('span', { className: 'ciCount' }, String(count))),
        open ? h('div', { className: 'ciRows' }, children) : null);
    }

    /**
     * 「环境与能力」设置页。
     * @param props - 槽位属性（`t` / `close` 等）。
     * @returns 页面元素。
     */
    function CapabilitySection(props) {
      const t = translator(props);
      const [report, setReport] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');
      const [scope, setScope] = useState('user');
      // 默认展开：三个能力段 + 运行时 + 「你自己安装的」；
      // **系统段默认折叠** —— 它是上千项的那一段。
      const [open, setOpen] = useState({
        tools: true, skills: true, mcp: true, runtimes: true, user: true, system: false,
      });

      const load = useCallback(async (fresh) => {
        setBusy(true);
        setError(null);
        try {
          const url = fresh === true ? API + '?fresh=1' : API;
          const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
          const data = await response.json().catch(() => null);
          if (data === null || data.ok !== true) {
            throw new Error((data && data.error) || ('HTTP ' + response.status));
          }
          setReport(data);
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => { load(false); }, [load]);

      const capabilities = report !== null && report.capabilities !== null && typeof report.capabilities === 'object'
        ? report.capabilities
        : EMPTY_OBJECT;
      const mcp = capabilities.mcp !== null && typeof capabilities.mcp === 'object' && capabilities.mcp !== undefined
        ? capabilities.mcp
        : EMPTY_MCP;

      const tools = useMemo(() => filterEntries(capabilities.tools, query), [capabilities, query]);
      const skills = useMemo(() => filterEntries(capabilities.skills, query), [capabilities, query]);
      const mcpTools = useMemo(() => filterEntries(mcp.tools, query), [mcp, query]);
      const filteredCommands = useMemo(() => filterEntries(report === null ? [] : report.entries, query), [report, query]);
      const groups = useMemo(() => groupEntries(filteredCommands), [filteredCommands]);
      const rows = useMemo(() => ({
        runtimes: sortForDisplay(groups.runtimes),
        user: sortForDisplay(groups.user),
        system: sortForDisplay(groups.system),
      }), [groups]);

      const effectiveScope = resolveScope(scope, query);
      const shownCommands = visibleGroups(effectiveScope);
      const stats = summarize(report);
      // 有关键词时范围会被强制成「全部」，提示一声免得以为筛选失效
      const searching = effectiveScope !== scope;

      const toggle = (key) => setOpen((current) => ({ ...current, [key]: current[key] !== true }));

      /** 渲染一个命令行段。 */
      const renderCommandGroup = (key) => {
        const capped = capRows(rows[key]);
        return h(GroupSection, {
          key,
          title: t(GROUP_LABEL[key]),
          count: rows[key].length,
          open: open[key] === true,
          onToggle: () => toggle(key),
          t,
        },
          capped.rows.map((entry) => h(CommandRow, { key: entry.name + entry.path, entry, t })),
          capped.hidden === 0 ? null : h('div', { key: 'hidden', className: 'ciNote' }, t('hidden', { count: capped.hidden })));
      };

      /** 渲染一个能力段（空的时候给出"怎么才会有"的提示）。 */
      const renderCapabilityGroup = (key, list, emptyKey, hintKey) => {
        const capped = capRows(list);
        return h(GroupSection, {
          key,
          title: t(GROUP_LABEL[key]),
          count: list.length,
          open: open[key] === true,
          onToggle: () => toggle(key),
          t,
        }, list.length === 0
          ? [h('div', { key: 'empty', className: 'ciEmpty' }, t(emptyKey)),
            hintKey === null ? null : h('div', { key: 'hint', className: 'ciNote' }, t(hintKey))]
          : capped.rows.map((entry) => h(CapabilityRow, { key: entry.name, entry })));
      };

      return h('div', { className: 'ciPage' },
        h('div', { className: 'ciHead' },
          h('div', { className: 'ciTitle' }, t('title')),
          h('button', {
            type: 'button',
            className: 'ciBtn',
            disabled: busy,
            onClick: () => { load(true); },
          }, busy ? t('loading') : t('refresh'))),
        report === null ? null : h('div', { className: 'ciSummary' },
          t('summaryCaps', { tools: stats.tools, skills: stats.skills, mcpServers: stats.mcpServers })),
        report === null ? null : h('div', { className: 'ciBreakdown' },
          t('summary', { dirs: stats.pathCount, total: stats.total, withVersion: stats.withVersion })
            + (stats.truncated ? t('summaryTruncated') : '')
            + ' · ' + t('breakdown', { user: stats.user, system: stats.system })),
        error === null ? null : h('div', { className: 'ciError' }, t('failed', { reason: error })),
        h('input', {
          type: 'search',
          className: 'ciSearch',
          placeholder: t('search'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        report === null ? null : h('div', null,
          renderCapabilityGroup('tools', tools, 'empty.tools', null),
          renderCapabilityGroup('skills', skills, 'empty.skills', 'hint.skills'),
          renderCapabilityGroup('mcp', mcpTools, 'empty.mcp', 'hint.mcp'),
          stats.mcpServers === 0 ? null : h('div', { className: 'ciNote' },
            t('mcpServers', { servers: (Array.isArray(mcp.servers) ? mcp.servers : []).join(', ') }))),
        h('div', { className: 'ciChips' },
          h('span', { className: 'ciChipLabel' }, t('scopeLabel')),
          SCOPES.map((key) => h('button', {
            key,
            type: 'button',
            className: 'ciChip',
            'aria-selected': scope === key,
            onClick: () => {
              setScope(key);
              if (key === 'system') setOpen((current) => ({ ...current, system: true }));
            },
          }, t(SCOPE_LABEL[key]))),
          searching ? h('span', { className: 'ciHint' }, t('searchAll')) : null),
        report === null ? null : h('div', null,
          filteredCommands.length === 0 && tools.length + skills.length + mcpTools.length === 0
            ? h('div', { className: 'ciEmpty' }, t('empty'))
            : null,
          shownCommands.map((key) => (rows[key].length === 0 ? null : renderCommandGroup(key)))),
        h('div', { className: 'ciNote' }, t('note')));
    }

    // ========================================================================
    // 5. apply
    // ========================================================================

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 与官方设置页一致：词典先注册，再用 bind(NS) 拿取词函数给导航标签用
        // （label 是 thunk，每次投影重读，所以切语言时导航文字会跟着变）。
        const tn = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'cli-inventory: dictionaries');
        // 样式：幂等 + 带键 + 不随 dispose 移除（孤儿注册仍需样式；官方也是先按 key 查再注入）。
        ctx.effect(() => {
          let style = document.querySelector('style[data-dsh-style="cli-inventory"]');
          if (style === null) {
            style = document.createElement('style');
            style.setAttribute('data-dsh-style', 'cli-inventory');
            (document.head || document.documentElement).appendChild(style);
          }
          style.textContent = CSS;
        }, 'cli-inventory: styles');
        // slots.inject 返回 dispose 函数，必须由 ctx.effect 管住，否则插件 dispose 后注册会泄漏。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cli-inventory',
          order: 30,
          label: () => tn('nav'),
          locale: NS,
        }, CapabilitySection)), 'cli-inventory: settings section');
      },
    };
  },
});

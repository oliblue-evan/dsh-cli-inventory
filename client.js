/**
 * 环境与能力 —— 客户端半边：**「设置」里的一个页面**。
 *
 * 【这一页回答什么问题】**"这个 Agent 到底能操作什么"**：工具注册表（真正发给模型的
 * 那批工具）、技能注册表、MCP 服务器贡献的工具，然后是"你自己装的"命令行工具与
 * DSH 自带运行时。
 *
 * 【版式对齐官方「内置插件」页】整套行/卡片体系照 `dsh-client-ui-settings-plugin-inventory`
 * 抄：`max-width:760px` 的 section、带放大镜的搜索框、组标题（可折叠 + chevron）与
 * `·` 分隔的副行、两列卡片网格（窄容器回落单列）、等宽「身份标签」放路径。
 * 用的是**设置页专用 token**（`--dsw-alias-settings-card-stroke/-fill`、
 * `--dsw-alias-bg-module-platform`、`--dsw-radius-*`），所以它在设置里看起来是原生的。
 *
 * 【一处值得记下的巧合】官方注入样式的方式是「按 `data-plugin-css` 键 querySelector，
 * 已存在就复用、**从不移除**」—— 与我修完「组件还在、样式没了」那个 bug 后改成的写法
 * 完全一致，算是事后拿到了官方背书。
 *
 * 【本文件的组织方式】
 *   客户端 bundle **必须是单文件**：宿主把各插件的 bundle 拼接成一个 combo 脚本、
 *   以**传统脚本**执行（`window.__ModuleLoader__` 处于 queue 模式，只登记工厂函数），
 *   所以这里写 ES 相对 import 并不成立。用「目录 + 显式 region 标记」代替拆文件：
 *
 *     1. 纯逻辑     过滤 / 分组 / 排序 / 摘要 / 截断（不含 React/DOM，可被测试抽取）
 *     2. 文案       中英词典
 *     3. 样式       CSS，照官方内置插件页
 *     4. 组件       设置页本体
 *     5. apply      注册到 settings.section
 *
 *   第 1 节包在 `#region 纯逻辑` 里，`test/extract-client.mjs` 按标记抽取后直接单测。
 *
 * 【三条纪律】（都是踩过的坑）
 *   · 样式幂等注入、不随 dispose 移除 —— 否则出现孤儿注册时页面会变成「组件还在、样式没了」。
 *   · `slots.inject` 返回 dispose 函数，**必须**用 `ctx.effect` 包住，否则注册会泄漏。
 *   · 内联 SVG 必须写死宽高：只有 viewBox 的 SVG 在没有 CSS 时会撑满容器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cli-inventory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;

    // ========================================================================
    // 1. 纯逻辑（不含 React/DOM）
    // ========================================================================

    // #region 纯逻辑

    /** 每段最多渲染多少张卡片；其余靠搜索缩小范围。 */
    const ROW_LIMIT = 80;

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
     * 分两段：**DSH 自带运行时**（harness 提供）与**你自己装的**（PATH 里扫到的）。
     * @param entries - 条目数组。
     * @returns `{ runtimes, user }`。
     */
    function groupEntries(entries) {
      const list = Array.isArray(entries) ? entries : [];
      const usable = list.filter((entry) => entry !== null && typeof entry === 'object');
      return {
        runtimes: usable.filter((entry) => entry.source === 'harness'),
        user: usable.filter((entry) => entry.source !== 'harness'),
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
      return {
        tools: count(caps.tools),
        skills: count(caps.skills),
        mcpServers: count(mcp.servers),
        mcpTools: count(mcp.tools),
        pathCount: Number(source.pathCount) || 0,
        scannedDirCount: Number(source.scannedDirCount) || 0,
        total: Number(source.total) || commands.length,
        withVersion: entries.filter(
          (entry) => entry !== null && typeof entry === 'object' && typeof entry.version === 'string' && entry.version !== '',
        ).length,
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
      'search': '搜索工具、技能、命令…',
      'loading': '正在读取…',
      'group.tools': '工具',
      'group.skills': '技能',
      'group.mcp': 'MCP',
      'group.runtimes': 'DSH 自带运行时',
      'group.user': '你自己安装的',
      'sub.tools': '来自宿主工具注册表',
      'sub.skills': '来自 ~/.dsh/skills 与技能提供者',
      'sub.mcp': '服务器：{servers}',
      'sub.mcpNone': '未配置服务器',
      'sub.runtimes': '由 harness 自带',
      'sub.user': '扫了 PATH 中 {scanned}/{dirs} 个目录',
      'sub.versions': '取到版本 {withVersion} 个',
      'sub.truncated': '已截断，只列出一部分',
      'empty.tools': '读不到工具注册表（宿主未提供 tools 服务）。',
      'empty.skills': '还没有技能。把技能放到 ~/.dsh/skills/<名字>/SKILL.md 就会出现。',
      'empty.mcp': '还没有配置 MCP 服务器；配置后它们贡献的工具会出现在这里。',
      'empty': '没有匹配项',
      'expand': '展开',
      'collapse': '收起',
      'noVersion': '未取版本',
      'hidden': '另有 {count} 项未显示，用上面的搜索缩小范围',
      'failed': '读取失败：{reason}',
      'note': '工具与技能来自宿主注册表（只读且容错：服务不可用就显示 0）。命令行工具只扫「你自己装的」目录 —— 系统目录有上千项、没有参考价值，故不列出；且仅对内置白名单执行 `--version` 取版本。',
    };

    const EN = {
      'nav': 'Environment & capabilities',
      'search': 'Search tools, skills, commands…',
      'loading': 'Reading…',
      'group.tools': 'Tools',
      'group.skills': 'Skills',
      'group.mcp': 'MCP',
      'group.runtimes': 'Bundled DSH runtimes',
      'group.user': 'Installed by you',
      'sub.tools': 'from the host tool registry',
      'sub.skills': 'from ~/.dsh/skills and skill providers',
      'sub.mcp': 'servers: {servers}',
      'sub.mcpNone': 'no server configured',
      'sub.runtimes': 'shipped by the harness',
      'sub.user': 'scanned {scanned}/{dirs} PATH directories',
      'sub.versions': '{withVersion} with a version',
      'sub.truncated': 'truncated; only part is listed',
      'empty.tools': 'The tool registry is unavailable (no `tools` service on this host).',
      'empty.skills': 'No skills yet. Drop one at ~/.dsh/skills/<name>/SKILL.md and it shows up here.',
      'empty.mcp': 'No MCP server configured yet; the tools it contributes will appear here.',
      'empty': 'Nothing matches',
      'expand': 'Expand',
      'collapse': 'Collapse',
      'noVersion': 'no version',
      'hidden': '{count} more hidden — narrow it with the search above',
      'failed': 'Failed to read: {reason}',
      'note': 'Tools and skills come from the host registries (read-only, fault-tolerant: an unavailable service reads as 0). The command list scans only the directories you installed into — system directories hold a thousand-odd entries and are not listed — and executes `--version` for a built-in allowlist only.',
    };

    /**
     * 段的文案 key 映射。
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
    };

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
    // 3. 样式（照 dsh-client-ui-settings-plugin-inventory 的体系）
    // ========================================================================

    const CSS = `
.ciSection{box-sizing:border-box;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);
  flex-direction:column;gap:14px;display:flex;container:ci-inventory/inline-size}
.ciSearch{position:relative;width:100%;color:var(--dsw-alias-label-tertiary);align-items:center;display:flex}
.ciSearch>svg{pointer-events:none;position:absolute;left:12px}
.ciSearch input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;outline:none;padding:0 34px 0 36px}
.ciSearch input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ciSearch input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%, transparent)}
.ciGroup{flex-direction:column;gap:10px;display:flex}
.ciGroup+.ciGroup{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.ciGroupTitleRow{align-items:center;gap:8px;min-height:36px;display:flex}
.ciGroupToggle{color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;flex:none;
  align-items:center;gap:8px;padding:0;display:flex}
.ciGroupToggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.ciGroupToggle>.ciChevron{transform:rotate(-90deg)}
.ciGroupToggle[aria-expanded=true]>.ciChevron{transform:none}
.ciGroupTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.ciCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}
.ciGroupSub{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex-wrap:wrap;row-gap:4px;
  margin:-6px 0 0 20px;font-size:12px;line-height:18px;display:flex}
.ciGroupSub>*+*:before{content:"·";color:var(--dsw-alias-label-tertiary);padding:0 6px}
.ciGroupBody{flex-direction:column;gap:10px;display:flex}
.ciCards{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none;display:grid}
.ciCard{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);
  background:var(--dsw-alias-settings-card-fill);flex-direction:column;min-width:0;display:flex;overflow:hidden}
.ciCardContent{box-sizing:border-box;width:100%;min-height:52px;color:inherit;font:inherit;text-align:left;
  background:0 0;border:0;flex-direction:column;flex:auto;align-items:stretch;gap:2px;padding:12px 14px;display:flex}
.ciCardMainRow{justify-content:space-between;align-items:center;gap:12px;min-width:0;display:flex}
.ciCardTitle,.ciCardIdentity{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ciCardTitle{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:20px}
.ciCardDescription{color:var(--dsw-alias-label-tertiary);text-wrap:pretty;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  font-size:12px;line-height:18px;display:-webkit-box;overflow:hidden}
.ciCardDescription[data-missing=true]{color:var(--dsw-alias-label-tertiary);font-style:normal;opacity:.85}
.ciCardMeta{margin-top:auto;padding-top:6px;display:flex}
.ciCardIdentity{box-sizing:border-box;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);
  max-width:100%;color:var(--dsw-alias-label-secondary);padding:1px 6px;display:block;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.ciChevron{color:var(--dsw-alias-label-tertiary);flex:none;align-self:center;width:12px;height:12px}
.ciSkeletonCard{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);
  background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:8px;padding:15px 14px;display:flex}
.ciSkeletonBar{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);width:40%;height:14px}
.ciSkeletonBar+.ciSkeletonBar{width:80%;height:12px}
.ciEmpty,.ciNote{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.ciError{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}
@media (prefers-reduced-motion:no-preference){.ciChevron{transition:transform .14s ease}
.ciSkeletonBar{animation:2s cubic-bezier(.36,0,.64,1) infinite ci-inventory-skeleton}}
@keyframes ci-inventory-skeleton{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}
@container ci-inventory (width<=520px){.ciCards{grid-template-columns:minmax(0,1fr)}}
`;

    // ========================================================================
    // 4. 组件
    // ========================================================================

    /** 稳定的空值（避免每次渲染都造新对象，破坏 useMemo 依赖）。 */
    const EMPTY_OBJECT = {};
    const EMPTY_MCP = { servers: [], tools: [] };

    /**
     * 折叠指示三角（12px，颜色随父级）。
     * @param props - 未使用（保持与官方同构的签名）。
     * @returns 内联 SVG（宽高写死：无 CSS 时才不会撑满容器）。
     */
    function ChevronIcon(props) {
      void props;
      return h('svg', {
        viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'ciChevron',
      }, h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }));
    }

    /**
     * 搜索框里的放大镜。
     * @returns 内联 SVG。
     */
    function SearchIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('circle', { cx: 7, cy: 7, r: 4.5 }),
      h('path', { d: 'M10.5 10.5 14 14' }));
    }

    /**
     * 一张卡片：标题 + 描述 + 可选等宽身份标签。
     * @param props.title - 主标题（工具名 / 命令名）。
     * @param props.description - 描述（工具说明 / 版本行）。
     * @param props.descriptionMissing - 描述是否表示"没有版本"（用弱化样式）。
     * @param props.identity - 等宽标签（路径 / 来源）。
     * @returns 卡片元素。
     */
    function Card({ title, description, descriptionMissing, identity }) {
      const hasIdentity = typeof identity === 'string' && identity !== '';
      return h('li', { className: 'ciCard' },
        h('div', { className: 'ciCardContent' },
          h('div', { className: 'ciCardMainRow' },
            h('span', { className: 'ciCardTitle', title }, title)),
          description === '' || description === undefined ? null : h('div', {
            className: 'ciCardDescription',
            'data-missing': descriptionMissing === true ? 'true' : 'false',
            title: description,
          }, description),
          hasIdentity ? h('div', { className: 'ciCardMeta' },
            h('span', { className: 'ciCardIdentity', title: identity }, identity)) : null));
    }

    /**
     * 加载骨架（照官方的 skeletonCard）。
     * @param label - 无障碍标签（「正在读取…」）。
     * @returns 三张占位卡。
     */
    function Skeleton(label) {
      return h('div', { className: 'ciGroup', role: 'status', 'aria-label': label },
        h('ul', { className: 'ciCards' },
          [0, 1, 2].map((index) => h('li', { key: index, className: 'ciSkeletonCard' },
            h('div', { className: 'ciSkeletonBar' }),
            h('div', { className: 'ciSkeletonBar' })))));
    }

    /**
     * 一组（可折叠）。组标题行 = chevron + 标题；副行用 `·` 分隔若干事实。
     * @param props - `{ title, count, facts, children, open, onToggle, t }`。
     * @returns 组元素。
     */
    function Group({ title, count, facts, children, open, onToggle, t }) {
      const items = Array.isArray(facts) ? facts.filter((item) => typeof item === 'string' && item !== '') : [];
      return h('section', { className: 'ciGroup' },
        h('div', { className: 'ciGroupTitleRow' },
          h('button', {
            type: 'button',
            className: 'ciGroupToggle',
            'aria-expanded': open,
            title: open ? t('collapse') : t('expand'),
            onClick: onToggle,
          },
            h(ChevronIcon, {}),
            h('span', { className: 'ciGroupTitle' }, title)),
          h('span', { className: 'ciCount' }, String(count))),
        items.length === 0 ? null : h('div', { className: 'ciGroupSub' },
          items.map((item) => h('span', { key: item }, item))),
        open ? h('div', { className: 'ciGroupBody' }, children) : null);
    }

    /**
     * 「环境与能力」设置页。
     *
     * 没有刷新按钮：宿主一次扫描约 40ms，且每次打开这一页都会重新取数 ——
     * 按钮只会多一个需要解释的机关。
     *
     * @param props - 槽位属性（`t` / `close` 等）。
     * @returns 页面元素。
     */
    function CapabilitySection(props) {
      const t = translator(props);
      const [report, setReport] = useState(null);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState('');
      const [open, setOpen] = useState({ tools: true, skills: true, mcp: true, runtimes: true, user: true });

      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(API, { credentials: 'same-origin', headers: { accept: 'application/json' } });
            const data = await response.json().catch(() => null);
            if (cancelled) return;
            if (data === null || data.ok !== true) {
              throw new Error((data && data.error) || ('HTTP ' + response.status));
            }
            setReport(data);
          } catch (failure) {
            if (!cancelled) setError(String(failure && failure.message ? failure.message : failure));
          }
        })();
        return () => { cancelled = true; };
      }, []);

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
      }), [groups]);
      const stats = summarize(report);
      const nothingMatched = query.trim() !== ''
        && tools.length + skills.length + mcpTools.length + filteredCommands.length === 0;

      const toggle = (key) => setOpen((current) => ({ ...current, [key]: current[key] !== true }));

      /** 渲染一组卡片（空则显示一句说明）。 */
      const renderCards = (key, list, cards, emptyKey) => {
        const capped = capRows(cards);
        return h(Group, {
          key,
          title: t(GROUP_LABEL[key]),
          count: list.length,
          facts: factsOf(key),
          open: open[key] === true,
          onToggle: () => toggle(key),
          t,
        },
          list.length === 0 ? h('p', { className: 'ciEmpty' }, t(emptyKey)) : null,
          list.length === 0 ? null : h('ul', { className: 'ciCards' }, capped.rows),
          capped.hidden === 0 ? null : h('p', { className: 'ciNote' }, t('hidden', { count: capped.hidden })));
      };

      /** 每一组的副行事实（照官方 groupSub 的用法：几条短事实用 `·` 连起来）。 */
      const factsOf = (key) => {
        if (key === 'tools') return [t('sub.tools')];
        if (key === 'skills') return [t('sub.skills')];
        if (key === 'mcp') {
          const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
          return [servers.length === 0 ? t('sub.mcpNone') : t('sub.mcp', { servers: servers.join(', ') })];
        }
        if (key === 'runtimes') return [t('sub.runtimes')];
        const facts = [t('sub.user', { scanned: stats.scannedDirCount, dirs: stats.pathCount })];
        if (stats.withVersion > 0) facts.push(t('sub.versions', { withVersion: stats.withVersion }));
        if (stats.truncated) facts.push(t('sub.truncated'));
        return facts;
      };

      /** 命令卡片：描述放版本行，等宽标签放路径。 */
      const commandCards = (list) => list.map((entry) => {
        const hasVersion = typeof entry.version === 'string' && entry.version !== '';
        return h(Card, {
          key: entry.name + entry.path,
          title: entry.name,
          description: hasVersion ? entry.version : t('noVersion'),
          descriptionMissing: !hasVersion,
          identity: entry.path,
        });
      });

      /** 能力卡片：描述放说明，等宽标签放来源（技能提供者 / MCP 服务器）。 */
      const capabilityCards = (list) => list.map((entry) => {
        const description = typeof entry.description === 'string' && entry.description !== ''
          ? entry.description
          : (typeof entry.whenToUse === 'string' ? entry.whenToUse : '');
        const identity = typeof entry.server === 'string' && entry.server !== ''
          ? entry.server
          : (typeof entry.provider === 'string' ? entry.provider : '');
        return h(Card, { key: entry.name, title: entry.name, description, identity });
      });

      return h('div', { className: 'ciSection' },
        h('div', { className: 'ciSearch' },
          h(SearchIcon, {}),
          h('input', {
            type: 'search',
            'aria-label': t('search'),
            placeholder: t('search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          })),
        error === null ? null : h('p', { className: 'ciError' }, t('failed', { reason: error })),
        report === null && error === null ? Skeleton(t('loading')) : null,
        report === null ? null : h('div', null,
          nothingMatched ? h('p', { className: 'ciEmpty' }, t('empty')) : null,
          renderCards('tools', tools, capabilityCards(tools), 'empty.tools'),
          renderCards('skills', skills, capabilityCards(skills), 'empty.skills'),
          renderCards('mcp', mcpTools, capabilityCards(mcpTools), 'empty.mcp'),
          rows.runtimes.length === 0 ? null : renderCards('runtimes', rows.runtimes, commandCards(rows.runtimes), 'empty'),
          rows.user.length === 0 ? null : renderCards('user', rows.user, commandCards(rows.user), 'empty')),
        h('p', { className: 'ciNote' }, t('note')));
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
        // 样式：幂等 + 带键 + 不随 dispose 移除（官方 dsh-client-ui-* 也是这个写法：
        // 按 data-plugin-css 键查，已存在就复用）。
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

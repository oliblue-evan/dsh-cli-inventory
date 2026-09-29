/**
 * 环境与能力 —— 客户端半边：**「设置」里的一个页面**。
 *
 * 【这一页回答什么问题】**"这个 Agent 到底能操作什么"**：工具注册表（真正发给模型的
 * 那批工具）、技能注册表、MCP 服务器贡献的工具，然后是"你自己装的"命令行工具与
 * DSH 自带运行时。
 *
 * 【版式与交互照官方源码】不是从打包产物反推，而是照
 * `packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx`
 * 与同目录 `.module.css` 逐项对齐：
 *
 *   .section(gap 14 / max-width 760 / container)      ← 根
 *     └ .catalog(gap 12)
 *         ├ label.search(内嵌放大镜 + visuallyHidden 标签 + input)
 *         └ section.group
 *             ├ .groupTitleRow  → button.groupToggle(chevron + 标题)
 *             ├ p.groupSub      → 若干 span，用 `·` 分隔（**计数也在这里**）
 *             └ .groupBody      → ul.cards → li.card
 *
 * 卡片是**可点击展开**的：`li.card[data-open]` 内是 `button.cardContent`
 * （`aria-expanded` + `aria-controls`），右侧 `.cardTrailing` 里放 chevron
 * （展开时 `rotate(180deg)`），展开后渲染 `.cardDetails` —— 里面是
 * `<code class="entryValue">` 加一张 `<dl class="details">` 键值表
 * （`grid-template-columns:76px minmax(0,1fr)`，`div{display:contents}`）。
 * **同时只展开一张卡**（官方 `expanded: string | null`）。
 *
 * 【本文件的组织方式】客户端 bundle **必须是单文件**（宿主把各插件 bundle 拼成
 * combo 脚本、以传统脚本执行），所以用「目录 + region 标记」代替拆文件。
 * 第 1 节包在 `#region 纯逻辑` 里，`test/extract-client.mjs` 按标记抽取后直接单测。
 *
 * 【三条纪律】（都是踩过的坑）
 *   · 样式幂等注入、不随 dispose 移除（官方也是按键 querySelector 复用、从不移除）。
 *   · `slots.inject` 返回 dispose 函数，**必须**用 `ctx.effect` 包住，否则注册会泄漏。
 *   · 内联 SVG 必须写死宽高：只有 viewBox 的 SVG 在没有 CSS 时会撑满容器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-cli-inventory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useId } = React;

    // ========================================================================
    // 1. 纯逻辑（不含 React/DOM）
    // ========================================================================

    // #region 纯逻辑

    /** 每段最多渲染多少张卡片；其余靠搜索缩小范围。 */
    const ROW_LIMIT = 80;

    /** 骨架卡片的数量（官方 SKELETON_CARDS 是 4 个）。 */
    const SKELETON_CARDS = [0, 1, 2, 3];

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
      const hit = (field) => {
        if (typeof field === 'string') return field.toLowerCase().includes(needle);
        // 参数名 / 必填项是数组：搜 "offset" 应该能找到 read 这种工具。
        if (Array.isArray(field)) {
          return field.some((item) => typeof item === 'string' && item.toLowerCase().includes(needle));
        }
        return false;
      };
      return list.filter((entry) => {
        if (entry === null || typeof entry !== 'object') return false;
        return [entry.name, entry.description, entry.whenToUse, entry.version, entry.path, entry.server,
          entry.params, entry.required].some(hit);
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

    /**
     * 展开时显示的键值对（照官方 CardFacts 的形状：`[label, value]`）。
     *
     * 【不要重复卡片上已有的东西】官方那条 CSS 是
     * `.card[data-open='true'] .cardDescription { display: block }` —— **展开时描述会取消
     * 两行截断**，完整说明已经在卡体里了。所以这里**绝不能**再放 description；
     * 同理命令卡的 `version`（它就是卡片的描述行）也不能再列一次。
     * 早先两处都放进来了，结果同一段话在展开后出现两遍（用户一眼就看到了）。
     *
     * 详情只承载"卡片上看不到的"：技能提供者/何时使用、MCP 服务器/原始工具名。
     * 标识（路径、名字）则由 Card 的 identity → `entryValue` 呈现 —— 那里的意义是
     * **芯片会截断、展开行不截断**，与官方"chip 安静 / 展开行醒目"的分工一致。
     *
     * @param entry - 条目。
     * @param t - 文案函数。
     * @returns `[label, value]` 数组（自动跳过空值）。
     */
    function factsFor(entry, t) {
      const rows = [];
      const push = (label, value) => {
        if (value === undefined || value === null || value === '') return;
        rows.push([label, String(value)]);
      };
      if (typeof entry.server === 'string' && entry.server !== '') push(t('fact.server'), entry.server);
      if (typeof entry.tool === 'string' && entry.tool !== '') push(t('fact.rawName'), entry.tool);
      if (typeof entry.provider === 'string' && entry.provider !== '') push(t('fact.provider'), entry.provider);
      if (typeof entry.whenToUse === 'string' && entry.whenToUse !== '') push(t('fact.whenToUse'), entry.whenToUse);
      // 工具的参数是"展开才有内容"的关键：卡片正文就是描述，没有参数的话展开只是
      // 取消两行截断 —— 说明本来就短的工具点了等于没反应。
      if (Array.isArray(entry.params) && entry.params.length > 0) push(t('fact.params'), entry.params.join(' · '));
      if (Array.isArray(entry.required) && entry.required.length > 0) push(t('fact.required'), entry.required.join(' · '));
      return rows;
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
      'heading': '环境与能力',
      'intro': '这个 Agent 能操作什么：工具、技能、MCP，以及本机的命令行工具与运行时。',
      'search': '搜索工具、技能、命令…',
      'loading': '正在读取…',
      'retry': '重试',
      'countUnit': '个',
      'group.tools': '工具',
      'group.skills': '技能',
      'group.mcp': 'MCP',
      'group.runtimes': 'DSH 自带运行时',
      'group.user': '你自己安装的',
      'sub.tools': '来自宿主工具注册表',
      'sub.toolsScope': '按预设 {preset}',
      'sub.toolsLive': '当前会话视图',
      'sub.skills': '来自 ~/.dsh/skills 与技能提供者',
      'sub.mcp': '服务器：{servers}',
      'sub.mcpNone': '未配置服务器',
      'sub.runtimes': '由 harness 自带',
      'sub.user': '扫了 PATH 中 {scanned}/{dirs} 个目录',
      'sub.versions': '取到版本 {withVersion} 个',
      'sub.truncated': '已截断，只列出一部分',
      'fact.server': '服务器',
      'fact.rawName': '原始工具名',
      'fact.provider': '提供者',
      'fact.whenToUse': '何时使用',
      'fact.params': '参数',
      'fact.required': '必填',
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
      'heading': 'Environment & capabilities',
      'intro': 'What this agent can actually operate: tools, skills, MCP, plus local CLIs and runtimes.',
      'search': 'Search tools, skills, commands…',
      'loading': 'Reading…',
      'retry': 'Retry',
      'countUnit': 'items',
      'group.tools': 'Tools',
      'group.skills': 'Skills',
      'group.mcp': 'MCP',
      'group.runtimes': 'Bundled DSH runtimes',
      'group.user': 'Installed by you',
      'sub.tools': 'from the host tool registry',
      'sub.toolsScope': 'as preset {preset}',
      'sub.toolsLive': 'current session view',
      'sub.skills': 'from ~/.dsh/skills and skill providers',
      'sub.mcp': 'servers: {servers}',
      'sub.mcpNone': 'no server configured',
      'sub.runtimes': 'shipped by the harness',
      'sub.user': 'scanned {scanned}/{dirs} PATH directories',
      'sub.versions': '{withVersion} with a version',
      'sub.truncated': 'truncated; only part is listed',
      'fact.server': 'server',
      'fact.rawName': 'raw tool name',
      'fact.provider': 'provider',
      'fact.whenToUse': 'when to use',
      'fact.params': 'parameters',
      'fact.required': 'required',
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
    // 3. 样式（照 PluginInventorySettingsTab.module.css）
    // ========================================================================

    const CSS = `
.ciSection{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary)}
.ciHeading{margin:0;font-size:18px;font-weight:600}
.ciIntro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.ciPanel{min-width:0;padding-top:2px}
.ciStatus{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ciStatusWithDot{display:inline-flex;align-items:center;gap:6px}
.ciFailure{display:flex;align-items:center;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}
.ciFailure p{margin:0}
.ciFailure button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:4px 10px;
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.ciCatalog{container:ci-inventory/inline-size;display:flex;flex-direction:column;gap:12px}
.ciSearch{position:relative;display:flex;align-items:center;width:100%;color:var(--dsw-alias-label-tertiary)}
.ciSearch>svg{position:absolute;left:12px;pointer-events:none}
.ciSearch input{width:100%;height:36px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  padding:0 34px 0 36px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px}
.ciSearch input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ciSearch input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%, transparent)}
.ciCards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}
.ciCard{display:flex;flex-direction:column;min-width:0;overflow:hidden;border:.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.ciCard[data-open='true']{border-color:var(--dsw-alias-border-l3)}
.ciCard:nth-child(odd)[data-open='true']+.ciCard,
.ciCard:nth-child(odd):has(+.ciCard[data-open='true']){align-self:start}
.ciCardContent{box-sizing:border-box;display:flex;flex:1 1 auto;flex-direction:column;align-items:stretch;gap:2px;width:100%;
  min-height:52px;border:0;padding:12px 14px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ciCardContent:hover,.ciCard[data-open='true']>.ciCardContent{background:var(--dsw-alias-interactive-bg-hover)}
.ciCardContent:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.ciCardMainRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.ciCardTitle,.ciCardIdentity{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ciCardTitle{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:500}
.ciCardDescription{display:-webkit-box;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  text-wrap:pretty;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.ciCard[data-open='true'] .ciCardDescription{display:block}
.ciCardMeta{display:flex;margin-top:auto;padding-top:6px}
.ciCardIdentity,.ciEntryValue{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
.ciCardIdentity{display:block;box-sizing:border-box;max-width:100%;border-radius:var(--dsw-radius-xs);padding:1px 6px;
  background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.ciCardTrailing{display:inline-flex;flex:none;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary)}
.ciGroup{display:flex;flex-direction:column;gap:10px}
.ciGroupTitleRow{display:flex;align-items:center;gap:8px;min-height:36px}
.ciGroup+.ciGroup{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.ciGroupToggle{display:flex;flex:none;align-items:center;gap:8px;border:0;padding:0;background:transparent;color:inherit;
  font:inherit;text-align:left;cursor:pointer}
.ciGroupToggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.ciGroupToggle>.ciChevron{transform:rotate(-90deg)}
.ciGroupToggle[aria-expanded='true']>.ciChevron{transform:none}
.ciGroupTitle{font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.ciGroupSub{display:flex;flex-wrap:wrap;row-gap:4px;margin:-6px 0 0 20px;color:var(--dsw-alias-label-tertiary);
  font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.ciGroupSub>*+*::before{content:'·';padding:0 6px;color:var(--dsw-alias-label-tertiary)}
.ciGroupBody{display:flex;flex-direction:column;gap:10px}
.ciChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.ciCard[data-open='true'] .ciChevron{transform:rotate(180deg)}
.ciCardDetails{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;background:var(--dsw-alias-bg-module-platform)}
.ciEntryValue{display:block;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.ciDetails{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;margin:8px 0 0}
.ciDetails div{display:contents}
.ciDetails dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.ciDetails dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}
.ciSkeletonCard{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-xl);padding:15px 14px;background:var(--dsw-alias-settings-card-fill)}
.ciSkeletonBar{width:40%;height:14px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton)}
.ciSkeletonBar+.ciSkeletonBar{width:80%;height:12px}
.ciNote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.ciVisuallyHidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:no-preference){.ciChevron{transition:transform 140ms ease}
.ciSkeletonBar{animation:ci-inventory-skeleton 2s cubic-bezier(.36,0,.64,1) infinite}}
@keyframes ci-inventory-skeleton{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}
@container ci-inventory (max-width:520px){.ciCards{grid-template-columns:minmax(0,1fr)}}
`;

    // ========================================================================
    // 4. 组件
    // ========================================================================

    /** 稳定的空值（避免每次渲染都造新对象，破坏 useMemo 依赖）。 */
    const EMPTY_OBJECT = {};
    const EMPTY_MCP = { servers: [], tools: [] };

    /**
     * 向下的三角（展开时由 CSS 旋转 180°）。
     * @returns 内联 SVG（宽高写死：无 CSS 时才不会撑满容器）。
     */
    function ChevronDown() {
      // 线宽 1 与尺寸 12 都照官方：ICON_REGULAR_STROKE = 1（medium 才 1.3）、
      // 内置插件页给 chevron 传的就是 size={12}。
      return h('svg', {
        viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'ciChevron',
      }, h('path', { d: 'M2.5 4.5 6 8l3.5-3.5' }));
    }

    /**
     * 搜索框里的放大镜。
     * @returns 内联 SVG。
     */
    function SearchIcon() {
      // 官方 IconProps 的 size 默认 14（搜索框里也没传 size），线宽同为 1。
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, h('circle', { cx: 7, cy: 7, r: 4.5 }), h('path', { d: 'M10.5 10.5 14 14' }));
    }

    /**
     * 一张可展开的卡片（照官方 PluginCard）。
     *
     * 折叠时：标题行（标题 + 尾部 chevron）、两行截断的描述、可选等宽身份标签。
     * 展开时：`.ciCardDetails` 里给出 identity 与一张键值表（完整描述在这里）。
     *
     * @param props - `{ title, description, descriptionMissing, identity, facts, open, onToggle, t }`。
     * @returns 卡片元素。
     */
    function Card({ title, description, descriptionMissing, identity, facts, open, onToggle, t }) {
      const detailId = useId();
      const descriptionId = useId();
      const hasDescription = typeof description === 'string' && description !== '';
      const hasIdentity = typeof identity === 'string' && identity !== '';
      const rows = Array.isArray(facts) ? facts : [];
      // 有东西可展开才给 button 挂 aria-controls、才渲染详情区 ——
      // 否则会出现"指向不存在元素"的无障碍引用，以及一条空白的详情条。
      const hasReveal = hasIdentity || rows.length > 0;
      return h('li', { className: 'ciCard', 'data-open': open ? 'true' : undefined },
        h('button', {
          type: 'button',
          className: 'ciCardContent',
          'aria-expanded': open,
          'aria-controls': hasReveal ? detailId : undefined,
          // 官方把描述用 aria-describedby 挂在按钮上，读屏时会一起念出来
          'aria-describedby': hasDescription ? descriptionId : undefined,
          'aria-label': title + ' — ' + t(open ? 'collapse' : 'expand'),
          onClick: onToggle,
        },
          h('span', { className: 'ciCardMainRow' },
            h('strong', { className: 'ciCardTitle', title }, title),
            h('span', { className: 'ciCardTrailing' }, h(ChevronDown, {}))),
          hasDescription ? h('span', {
            className: 'ciCardDescription',
            id: descriptionId,
            'data-missing': descriptionMissing === true ? 'true' : undefined,
          }, description) : null,
          hasIdentity ? h('span', { className: 'ciCardMeta' },
            h('code', { className: 'ciCardIdentity', title: identity }, identity)) : null),
        open && hasReveal ? h('div', { className: 'ciCardDetails', id: detailId },
          hasIdentity ? h('code', { className: 'ciEntryValue' }, identity) : null,
          rows.length === 0 ? null : h('dl', { className: 'ciDetails' },
            rows.map(([label, value]) => h('div', { key: label + value },
              h('dt', null, label),
              h('dd', null, value))))) : null);
    }

    /**
     * 骨架卡片（照官方：用同一个 `.cards` 网格）。
     * @param props.label - 无障碍标签。
     * @returns 骨架网格。
     */
    function SkeletonCards({ label }) {
      return h('div', { className: 'ciCards', role: 'status' },
        h('span', { className: 'ciVisuallyHidden' }, label),
        SKELETON_CARDS.map((slot) => h('div', { key: slot, className: 'ciSkeletonCard', 'aria-hidden': true },
          h('span', { className: 'ciSkeletonBar' }),
          h('span', { className: 'ciSkeletonBar' }))));
    }

    /**
     * 一组（照官方 section.group）。
     * @param props - `{ title, facts, children, open, onToggle, t }`。
     * @returns 组元素。
     */
    function Group({ title, facts, children, open, onToggle, t }) {
      const bodyId = useId();
      const items = Array.isArray(facts) ? facts.filter((item) => typeof item === 'string' && item !== '') : [];
      return h('section', { className: 'ciGroup' },
        h('div', { className: 'ciGroupTitleRow' },
          h('button', {
            type: 'button',
            className: 'ciGroupToggle',
            'aria-expanded': open,
            'aria-controls': bodyId,
            title: open ? t('collapse') : t('expand'),
            onClick: onToggle,
          },
            h(ChevronDown, {}),
            h('span', { className: 'ciGroupTitle' }, title))),
        items.length === 0 ? null : h('p', { className: 'ciGroupSub' },
          items.map((item, index) => h('span', { key: item + index }, item))),
        open ? h('div', { className: 'ciGroupBody', id: bodyId }, children) : null);
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
      const [request, setRequest] = useState(0);
      const [query, setQuery] = useState('');
      // 照官方：同时只展开一张卡（`string | null`）
      const [expanded, setExpanded] = useState(null);
      const [open, setOpen] = useState({ tools: true, skills: true, mcp: true, runtimes: true, user: true });
      const searchId = useId();

      useEffect(() => {
        let cancelled = false;
        setError(null);
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
      }, [request]);

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
      const nothingMatches = query.trim() !== ''
        && tools.length + skills.length + mcpTools.length + filteredCommands.length === 0;

      const toggleGroup = (key) => setOpen((current) => ({ ...current, [key]: current[key] !== true }));
      const toggleCard = (key) => setExpanded((current) => (current === key ? null : key));

      /** 组的副行事实（照官方：计数也是其中一项）。 */
      const factsOf = (key, count) => {
        const facts = [String(count) + ' ' + t('countUnit')];
        if (key === 'tools') {
          facts.push(t('sub.tools'));
          // 工具视图的来源如实写出来：**当前会话**（含 subagent/teams/schedule 这类
          // 会话级工具）还是**冷启动的预设视图**（少了那批）。
          const scope = capabilities.toolsScope;
          if (scope !== null && typeof scope === 'object') {
            if (scope.live === true) facts.push(t('sub.toolsLive'));
            else if (scope.scoped === true && typeof scope.preset === 'string') {
              facts.push(t('sub.toolsScope', { preset: scope.preset }));
            }
          }
        }
        else if (key === 'skills') facts.push(t('sub.skills'));
        else if (key === 'mcp') {
          const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
          facts.push(servers.length === 0 ? t('sub.mcpNone') : t('sub.mcp', { servers: servers.join(', ') }));
        } else if (key === 'runtimes') facts.push(t('sub.runtimes'));
        else {
          facts.push(t('sub.user', { scanned: stats.scannedDirCount, dirs: stats.pathCount }));
          if (stats.withVersion > 0) facts.push(t('sub.versions', { withVersion: stats.withVersion }));
          if (stats.truncated) facts.push(t('sub.truncated'));
        }
        return facts;
      };

      /** 命令卡片：描述放版本行，等宽身份标签放路径，展开看版本与路径。 */
      const commandCards = (list) => list.map((entry) => {
        const hasVersion = typeof entry.version === 'string' && entry.version !== '';
        const key = 'cmd:' + entry.name + entry.path;
        return h(Card, {
          key,
          title: entry.name,
          description: hasVersion ? entry.version : t('noVersion'),
          descriptionMissing: !hasVersion,
          identity: entry.path,
          facts: factsFor(entry, t),
          open: expanded === key,
          onToggle: () => toggleCard(key),
          t,
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
        const key = 'cap:' + entry.name;
        return h(Card, {
          key,
          title: entry.name,
          description,
          identity,
          facts: factsFor(entry, t),
          open: expanded === key,
          onToggle: () => toggleCard(key),
          t,
        });
      });

      /** 渲染一组卡片（空则一句话说明）。 */
      const renderGroup = (key, list, cards, emptyKey) => {
        const capped = capRows(cards);
        return h(Group, {
          key,
          title: t(GROUP_LABEL[key]),
          facts: factsOf(key, list.length),
          open: open[key] === true,
          onToggle: () => toggleGroup(key),
          t,
        },
          list.length === 0 ? h('p', { className: 'ciStatus' }, t(emptyKey)) : null,
          list.length === 0 ? null : h('ul', { className: 'ciCards' }, capped.rows),
          capped.hidden === 0 ? null : h('p', { className: 'ciStatus' }, t('hidden', { count: capped.hidden })));
      };

      return h('div', { className: 'ciSection', 'aria-busy': report === null && error === null },
        // 标题区由 section 自己渲染 —— 框架不会代劳，没有它顶部就是一片空白
        // （这正是与官方「内置插件」页对不上的地方）。
        h('h2', { className: 'ciHeading' }, t('heading')),
        h('p', { className: 'ciIntro' }, t('intro')),
        h('div', { className: 'ciPanel' },
        error === null ? null : h('div', { className: 'ciFailure' },
          h('p', { role: 'alert' }, t('failed', { reason: error })),
          h('button', { type: 'button', onClick: () => setRequest((value) => value + 1) }, t('retry'))),
        report === null && error === null ? h(SkeletonCards, { label: t('loading') }) : null,
        report === null ? null : h('div', { className: 'ciCatalog' },
          h('label', { className: 'ciSearch', htmlFor: searchId },
            h(SearchIcon, {}),
            h('span', { className: 'ciVisuallyHidden' }, t('search')),
            h('input', {
              id: searchId,
              type: 'search',
              value: query,
              placeholder: t('search'),
              'aria-label': t('search'),
              onChange: (event) => setQuery(event.currentTarget.value),
            })),
          nothingMatches ? h('p', { className: 'ciStatus' }, t('empty')) : null,
          renderGroup('tools', tools, capabilityCards(tools), 'empty.tools'),
          renderGroup('skills', skills, capabilityCards(skills), 'empty.skills'),
          renderGroup('mcp', mcpTools, capabilityCards(mcpTools), 'empty.mcp'),
          rows.runtimes.length === 0 ? null : renderGroup('runtimes', rows.runtimes, commandCards(rows.runtimes), 'empty'),
          rows.user.length === 0 ? null : renderGroup('user', rows.user, commandCards(rows.user), 'empty'),
          h('p', { className: 'ciNote' }, t('note')))));
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

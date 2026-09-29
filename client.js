/**
 * 环境与 CLI —— 客户端半边：**「设置」里的一个页面**。
 *
 * 【本文件的组织方式】
 *   客户端 bundle **必须是单文件**：宿主把各插件的 bundle 拼接成一个 combo 脚本、
 *   以**传统脚本**执行（`window.__ModuleLoader__` 处于 queue 模式，只登记工厂函数），
 *   所以这里写 ES 相对 import 并不成立。用「目录 + 显式 region 标记」代替拆文件：
 *
 *     1. 纯逻辑     过滤 / 分组 / 摘要 / 截断（不含 React/DOM，可被测试抽取）
 *     2. 文案       中英词典
 *     3. 样式       CSS，数值与 token 对齐宿主
 *     4. 组件       设置页本体
 *     5. apply      注册到 settings.section
 *
 *   第 1 节包在 `#region 纯逻辑` 里，`test/extract-client.mjs` 按标记抽取后直接单测。
 *
 * 【样式】在 `apply` 里注入一次、挂在插件 fiber 上。**不能**塞在组件树里 —— 组件只在
 *   自己的槽位渲染，换一个槽位就一个样式都拿不到（在 dsh-usage-pill 上踩过这个坑）。
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

    /** 最多渲染多少行；其余靠搜索缩小范围（PATH 里几百个命令全铺出来既慢也没用）。 */
    const ROW_LIMIT = 80;

    /**
     * 按关键词过滤条目（名称 / 版本 / 路径，均不区分大小写）。
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
        return [entry.name, entry.version, entry.path].some(
          (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
        );
      });
    }

    /**
     * 分三段：**DSH 自带运行时** / **你自己装的** / **系统自带**。
     *
     * 【为什么值得分】`/usr/bin` 一台机器上就有近千项，而你真正装的往往只有个位数。
     * 不分段的话，界面上先看到的一屏全是系统工具，等于答非所问。
     *
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
     * 从宿主报告里取出要显示的数字。
     * @param report - 宿主返回的报告。
     * @returns `{ pathCount, total, withVersion, truncated }`。
     */
    function summarize(report) {
      const source = report !== null && typeof report === 'object' ? report : {};
      const entries = Array.isArray(source.entries) ? source.entries : [];
      const commands = entries.filter((entry) => entry !== null && typeof entry === 'object' && entry.source !== 'harness');
      return {
        pathCount: Number(source.pathCount) || 0,
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
     * @returns `{ rows, hidden }`；`hidden` 是被隐藏的条数。
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
      'nav': '环境与 CLI',
      'title': '环境与 CLI',
      'refresh': '重新扫描',
      'loading': '正在扫描…',
      'search': '过滤命令名或路径…',
      'group.runtimes': 'DSH 自带运行时',
      'group.user': '你自己安装的',
      'group.system': '系统自带',
      'summary': 'PATH {dirs} 个目录 · 命令 {total} 个 · 取到版本 {withVersion} 个',
      'summaryTruncated': '（扫描已截断，只列出一部分）',
      'hidden': '另有 {count} 项未显示，用上面的搜索缩小范围',
      'noVersion': '未取版本',
      'empty': '没有匹配的命令',
      'failed': '读取失败：{reason}',
      'note': '只读：宿主只枚举 PATH 目录，并仅对内置白名单执行 `--version` 取版本；白名单之外只列名称与路径。',
    };

    const EN = {
      'nav': 'Environment & CLIs',
      'title': 'Environment & CLIs',
      'refresh': 'Rescan',
      'loading': 'Scanning…',
      'search': 'Filter by command name or path…',
      'group.runtimes': 'Bundled DSH runtimes',
      'group.user': 'Installed by you',
      'group.system': 'System',
      'summary': '{dirs} PATH directories · {total} commands · {withVersion} with a version',
      'summaryTruncated': ' (scan truncated; only part is listed)',
      'hidden': '{count} more hidden — narrow it with the search above',
      'noVersion': 'no version',
      'empty': 'No matching command',
      'failed': 'Failed to read: {reason}',
      'note': 'Read-only: the host only enumerates PATH directories, and executes `--version` for a built-in allowlist only; everything else is listed by name and path.',
    };

    /**
     * 文案函数：优先框架绑定的 t（走 `locale: NS` 注册的词典），缺词典时退回本地中文。
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
.ciPage{display:grid;gap:16px;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:18px}
.ciHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.ciTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.ciBtn{flex:none;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;
  color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.ciBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ciBtn[disabled]{cursor:default;opacity:.5;background:0 0}
.ciSummary{color:var(--dsw-alias-label-tertiary);font-size:12px}
.ciSearch{box-sizing:border-box;width:100%;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;
  background:0 0;color:var(--dsw-alias-label-primary);font:inherit}
.ciSearch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ciGroup{display:grid;gap:0}
.ciGroupTitle{display:flex;align-items:baseline;gap:8px;padding:6px 0;color:var(--dsw-alias-label-primary);font-weight:500}
.ciCount{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;font-variant-numeric:tabular-nums}
.ciRow{display:grid;grid-template-columns:minmax(70px,auto) minmax(110px,1fr) minmax(0,1.5fr);gap:12px;
  align-items:baseline;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ciRow:last-child{border-bottom:0}
.ciName{color:var(--dsw-alias-label-primary);font-weight:500}
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

    /**
     * 一行命令。
     * @param props.entry - `{ name, version, path, source }`。
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
     * 「环境与 CLI」设置页。
     * @param props - 槽位属性（`t` / `close` 等）。
     * @returns 页面元素。
     */
    function CliInventorySection(props) {
      const t = translator(props);
      const [report, setReport] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');

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

      const filtered = useMemo(() => filterEntries(report === null ? [] : report.entries, query), [report, query]);
      const groups = useMemo(() => groupEntries(filtered), [filtered]);
      const stats = summarize(report);
      // 三段各自限流：系统段再长也不会把「你自己装的」挤掉
      const runtimeRows = useMemo(() => capRows(groups.runtimes), [groups]);
      const userRows = useMemo(() => capRows(groups.user), [groups]);
      const systemRows = useMemo(() => capRows(groups.system), [groups]);
      const hidden = runtimeRows.hidden + userRows.hidden + systemRows.hidden;

      /** 渲染一段（标题 + 计数 + 行）；空段整段不渲染。 */
      const renderGroup = (titleKey, count, capped) => (capped.rows.length === 0 ? null : h('div', { className: 'ciGroup' },
        h('div', { className: 'ciGroupTitle' }, t(titleKey),
          h('span', { className: 'ciCount' }, String(count))),
        capped.rows.map((entry) => h(CommandRow, { key: entry.name + entry.path, entry, t }))));

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
          t('summary', { dirs: stats.pathCount, total: stats.total, withVersion: stats.withVersion })
            + (stats.truncated ? t('summaryTruncated') : '')),
        error === null ? null : h('div', { className: 'ciError' }, t('failed', { reason: error })),
        h('input', {
          type: 'search',
          className: 'ciSearch',
          placeholder: t('search'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        renderGroup('group.runtimes', groups.runtimes.length, runtimeRows),
        renderGroup('group.user', groups.user.length, userRows),
        renderGroup('group.system', groups.system.length, systemRows),
        groups.runtimes.length + groups.user.length + groups.system.length === 0
          ? h('div', { className: 'ciEmpty' }, t('empty'))
          : null,
        hidden === 0 ? null : h('div', { className: 'ciNote' }, t('hidden', { count: hidden })),
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
        // 样式注入一次、挂在插件 fiber 上（卸载时移除）。放进组件树里的话，
        // 换个槽位渲染就一个样式都拿不到（在 dsh-usage-pill 上踩过）。
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-cli-inventory', '');
          style.textContent = CSS;
          (document.head || document.documentElement).appendChild(style);
          return () => { style.remove(); };
        }, 'cli-inventory: styles');
        // 同 usage-pill 的教训：slots.inject 返回 dispose 函数，必须由 ctx.effect 管住，
        // 否则插件被 dispose 后这个注册会泄漏，出现「组件还在、样式没了」。
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'cli-inventory',
          order: 30,
          label: () => tn('nav'),
          locale: NS,
        }, CliInventorySection)), 'cli-inventory: settings section');
      },
    };
  },
});

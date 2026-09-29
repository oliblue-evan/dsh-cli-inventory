/**
 * 客户端纯逻辑（过滤 / 分组 / 排序 / 范围 / 摘要 / 截断）的断言。
 * 从 `client.js` 的 `#region 纯逻辑` 抽取后直接求值（那段不含 React/DOM）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientScope } from './extract-client.mjs';

const c = clientScope([
  'ROW_LIMIT', 'filterEntries', 'groupEntries', 'sortForDisplay', 'summarize', 'capRows', 'factsFor',
]);

/** 造一份条目。 */
const entry = (name, extra = {}) => ({ name, path: '/usr/bin/' + name, version: null, source: 'path', ...extra });

test('过滤：空关键词原样返回；命中名称/版本/路径任一即可；大小写不敏感', () => {
  const list = [
    entry('gh', { version: 'gh version 2.101.0', path: '/Users/me/.local/bin/gh' }),
    entry('git', { version: 'git version 2.54.0' }),
    entry('jq', { version: 'jq-1.7.1' }),
  ];
  assert.equal(c.filterEntries(list, ''), list, '空关键词返回原数组');
  assert.equal(c.filterEntries(list, '   '), list, '只有空白也算空');
  assert.deepEqual(c.filterEntries(list, 'GH').map((e) => e.name), ['gh'], '大小写不敏感');
  assert.deepEqual(c.filterEntries(list, '2.54').map((e) => e.name), ['git'], '可按版本过滤');
  assert.deepEqual(c.filterEntries(list, '.local').map((e) => e.name), ['gh'], '可按路径过滤');
  assert.deepEqual(c.filterEntries(list, 'nope'), []);
  assert.deepEqual(c.filterEntries(null, 'x'), [], '脏输入不炸');
  assert.deepEqual(c.filterEntries([null, 'x', entry('a')], ''), [null, 'x', entry('a')], '不过滤时不清理脏项');
  assert.deepEqual(c.filterEntries([null, entry('a')], 'a').map((e) => e.name), ['a'], '过滤时跳过脏项');
  // 同一函数也服务于能力条目：描述、何时使用、所属 MCP 服务器都要能被搜到
  const capabilities = [
    { name: 'pdf', description: '处理 PDF 文件', whenToUse: '当用户提到 PDF' },
    { name: 'mcp__github__issue', description: '建 issue', server: 'github' },
  ];
  assert.deepEqual(c.filterEntries(capabilities, '处理').map((e) => e.name), ['pdf'], '按描述过滤');
  assert.deepEqual(c.filterEntries(capabilities, '用户提到').map((e) => e.name), ['pdf'], '按 whenToUse 过滤');
  assert.deepEqual(c.filterEntries(capabilities, 'github').map((e) => e.name), ['mcp__github__issue'], '按服务器过滤');
  // 参数名与必填项也要能搜到（它们是数组字段）
  const withParams = [
    { name: 'read', description: '读文件', params: ['file_path', 'offset', 'limit'], required: ['file_path'] },
    { name: 'bash', description: '跑命令', params: ['command'], required: ['command'] },
  ];
  assert.deepEqual(c.filterEntries(withParams, 'offset').map((e) => e.name), ['read'], '按参数名过滤');
  assert.deepEqual(c.filterEntries(withParams, 'command').map((e) => e.name), ['bash'], '按必填项过滤');
  assert.deepEqual(c.filterEntries([{ name: 'x', params: 42, required: null }], 'x').map((e) => e.name), ['x'],
    'params/required 是非字符串非数组的脏值时安全跳过（仍按名称命中）');
  assert.deepEqual(c.filterEntries([{ name: 'y', params: 42 }], '42').map((e) => e.name), [],
    '脏值不参与匹配，也不会抛错');
});

test('分组：harness → 运行时段，其余 → 你自己装的（系统目录宿主根本不扫）', () => {
  const list = [
    entry('node', { source: 'harness' }),
    entry('gh'),
    entry('python3', { source: 'harness' }),
    entry('uv'),
  ];
  const groups = c.groupEntries(list);
  assert.deepEqual(groups.runtimes.map((e) => e.name), ['node', 'python3']);
  assert.deepEqual(groups.user.map((e) => e.name), ['gh', 'uv']);
  assert.deepEqual(c.groupEntries(null), { runtimes: [], user: [] });
  assert.deepEqual(c.groupEntries([null, 'x']), { runtimes: [], user: [] }, '脏项被过滤掉而不是抛错');
});

test('排序：取到版本的排前面，同组内按名称；不改动传入的数组', () => {
  const list = [
    entry('AssetCacheLocatorUtil'),
    entry('zzz', { version: 'zzz 1.0' }),
    entry('BTLEServer'),
    entry('git', { version: 'git 2.54.0' }),
    entry('aaa', { version: 'aaa 1.0' }),
    entry('DeRez'),
  ];
  const before = list.map((e) => e.name);
  assert.deepEqual(
    c.sortForDisplay(list).map((e) => e.name),
    ['aaa', 'git', 'zzz', 'AssetCacheLocatorUtil', 'BTLEServer', 'DeRez'],
    '有版本的在前，其余按名称',
  );
  assert.deepEqual(list.map((e) => e.name), before, '应是新数组，不改动入参');
  assert.deepEqual(c.sortForDisplay(null), []);
  assert.equal(c.sortForDisplay([null]).length, 1, '脏项不抛错');
  assert.deepEqual(
    c.sortForDisplay([entry('b', { version: '' }), entry('a', { version: '' })]).map((e) => e.name),
    ['a', 'b'],
    '空字符串版本视为没有版本',
  );
});

test('摘要：能力计数取 capabilities，命令行计数优先用宿主给的分组计数', () => {
  const report = {
    pathCount: 12, scannedDirCount: 3, total: 7, truncated: false,
    capabilities: {
      tools: [{ name: 'read' }, { name: 'bash' }],
      skills: [{ name: 'pdf' }],
      mcp: { servers: ['gh'], tools: [{ name: 'mcp__gh__issue' }] },
    },
    entries: [
      entry('node', { source: 'harness', version: 'v24.0.0' }),
      entry('gh', { version: 'gh 2', scope: 'user' }),
      entry('git', { scope: 'system' }),
    ],
  };
  assert.deepEqual(c.summarize(report), {
    tools: 2, skills: 1, mcpServers: 1, mcpTools: 1,
    pathCount: 12, scannedDirCount: 3, total: 7, withVersion: 2, truncated: false,
  });
  // total 缺失时按条目自行统计（不含 harness 运行时）
  const fallback = c.summarize({ entries: report.entries });
  assert.equal(fallback.total, 2);
  assert.equal(fallback.tools, 0, '没有 capabilities 时能力计数为 0');
  const empty = {
    tools: 0, skills: 0, mcpServers: 0, mcpTools: 0,
    pathCount: 0, scannedDirCount: 0, total: 0, withVersion: 0, truncated: false,
  };
  assert.deepEqual(c.summarize(null), empty);
  assert.deepEqual(c.summarize('nonsense'), empty);
  // capabilities 存在但字段是脏的，也应该报 0 而不是抛错
  assert.equal(c.summarize({ capabilities: { tools: 'nope', skills: null, mcp: 42 } }).tools, 0);
  assert.equal(c.summarize({ capabilities: { mcp: { servers: null, tools: undefined } } }).mcpServers, 0);
});

test('截断：默认上限生效，hidden 计数正确', () => {
  const list = Array.from({ length: c.ROW_LIMIT + 3 }, (unused, index) => entry('c' + index));
  const capped = c.capRows(list);
  assert.equal(capped.rows.length, c.ROW_LIMIT);
  assert.equal(capped.hidden, 3);
  assert.deepEqual(c.capRows([entry('a')], 5), { rows: [entry('a')], hidden: 0 });
  assert.equal(c.capRows(list, 0).rows.length, c.ROW_LIMIT, '非法上限回落到默认值');
  assert.deepEqual(c.capRows(null), { rows: [], hidden: 0 });
});

test('展开的详情不得重复卡片上已有的内容（说明 / 版本），只给卡片上看不到的事实', () => {
  // 官方 CSS 是 `.card[data-open='true'] .cardDescription{display:block}` —— 展开时
  // 描述会**取消两行截断**，完整说明已经在卡体里了。所以详情里再放一次说明就是
  // 同一段话出现两遍（这条是用户直接看到并指出来的）。
  const identity = (key) => key;
  const entry = {
    name: 'office-docx',
    description: 'Create, read, edit, and check Word documents…',
    version: 'office-docx 1.2.3',
    path: '/usr/local/bin/office-docx',
    provider: 'dsh-office',
    whenToUse: '当用户要求处理 Word 文档',
    server: 'github',
    tool: 'create_issue',
    params: ['file_path', 'offset'],
    required: ['file_path'],
  };
  const rows = c.factsFor(entry, identity);
  const labels = rows.map(([label]) => label);
  const values = rows.map(([, value]) => value);
  assert.deepEqual(labels, ['fact.server', 'fact.rawName', 'fact.provider', 'fact.whenToUse', 'fact.params', 'fact.required']);
  assert.ok(values.includes('file_path · offset'), '参数是展开后真正的新内容，应当出现');
  assert.ok(values.includes('file_path'), '必填项应出现');
  assert.ok(!values.includes(entry.description), '详情里不得再出现说明');
  assert.ok(!values.includes(entry.version), '详情里不得再出现版本（它就是卡片的描述行）');
  assert.ok(!values.includes(entry.path), '路径由 identity → entryValue 呈现，不走 fact');
  // 脏值 / 空值不产生行
  assert.deepEqual(c.factsFor({ name: 'x' }, identity), []);
  assert.deepEqual(c.factsFor({ name: 'x', server: '', tool: 42, provider: null, whenToUse: '' }, identity), []);
});

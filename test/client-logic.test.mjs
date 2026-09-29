/**
 * 客户端纯逻辑（过滤 / 分组 / 排序 / 范围 / 摘要 / 截断）的断言。
 * 从 `client.js` 的 `#region 纯逻辑` 抽取后直接求值（那段不含 React/DOM）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientScope } from './extract-client.mjs';

const c = clientScope([
  'ROW_LIMIT', 'SCOPES', 'filterEntries', 'groupEntries', 'sortForDisplay',
  'resolveScope', 'visibleGroups', 'summarize', 'capRows',
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
});

test('分组：harness → 运行时段；scope=system → 系统段；其余 → 你自己装的', () => {
  const list = [
    entry('node', { source: 'harness' }),
    entry('gh'),
    entry('python3', { source: 'harness' }),
    entry('git', { scope: 'system' }),
    entry('uv', { scope: 'user' }),
  ];
  const groups = c.groupEntries(list);
  assert.deepEqual(groups.runtimes.map((e) => e.name), ['node', 'python3']);
  assert.deepEqual(groups.user.map((e) => e.name), ['gh', 'uv'], 'scope 非 system 都算你自己装的');
  assert.deepEqual(groups.system.map((e) => e.name), ['git']);
  assert.deepEqual(c.groupEntries(null), { runtimes: [], user: [], system: [] });
  assert.deepEqual(
    c.groupEntries([null, 'x']),
    { runtimes: [], user: [], system: [] },
    '脏项被过滤掉而不是抛错',
  );
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

test('范围：有关键词时一律「全部」，否则用所选范围；非法值回落到「自己装的」', () => {
  assert.equal(c.resolveScope('user', ''), 'user');
  assert.equal(c.resolveScope('system', '   '), 'system', '只有空白不算搜索');
  assert.equal(c.resolveScope('system', 'git'), 'all', '搜索时跨范围找，否则搜 git 会一无所获');
  assert.equal(c.resolveScope('user', 'git'), 'all');
  assert.equal(c.resolveScope('bogus', ''), 'user');
  assert.equal(c.resolveScope(undefined, undefined), 'user');
  assert.deepEqual(c.SCOPES, ['user', 'system', 'all']);
});

test('可见段：自己装的 → 运行时+自己装的；系统 → 只有系统；全部 → 三段', () => {
  assert.deepEqual(c.visibleGroups('user'), ['runtimes', 'user']);
  assert.deepEqual(c.visibleGroups('system'), ['system']);
  assert.deepEqual(c.visibleGroups('all'), ['runtimes', 'user', 'system']);
  assert.deepEqual(c.visibleGroups('bogus'), ['runtimes', 'user'], '未知范围按默认视图处理');
});

test('摘要：优先用宿主给的分组计数，缺失时按条目自行统计', () => {
  const report = {
    pathCount: 12, total: 1270, truncated: false, scopeCounts: { user: 7, system: 1263 },
    entries: [
      entry('node', { source: 'harness', version: 'v24.0.0' }),
      entry('gh', { version: 'gh 2', scope: 'user' }),
      entry('git', { scope: 'system' }),
    ],
  };
  assert.deepEqual(c.summarize(report), {
    pathCount: 12, total: 1270, withVersion: 2, user: 7, system: 1263, truncated: false,
  });
  // 宿主没给 scopeCounts / total 时按条目自行统计
  const fallback = c.summarize({ entries: report.entries });
  assert.equal(fallback.user, 1);
  assert.equal(fallback.system, 1);
  assert.equal(fallback.total, 2, 'total 缺失时按 PATH 段条目数兜底（不含 harness 运行时）');
  assert.deepEqual(c.summarize(null), { pathCount: 0, total: 0, withVersion: 0, user: 0, system: 0, truncated: false });
  assert.deepEqual(c.summarize('nonsense'), { pathCount: 0, total: 0, withVersion: 0, user: 0, system: 0, truncated: false });
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

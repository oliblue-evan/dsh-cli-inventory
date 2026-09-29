/**
 * PATH 扫描纯逻辑的断言。
 *
 * 这一层是"给定输入怎么算"，所以边界情况（路径顺序、同名去重、可执行位、隐藏文件、
 * 截断、版本行清洗）都能在这里测干净，不需要真的去碰文件系统。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PER_DIR_LIMIT, SYSTEM_TOTAL_LIMIT, USER_TOTAL_LIMIT,
  cap, classifyDir, isCommandEntry, joinDir, mergeByPathOrder, parseVersion, splitPath,
} from '../lib/path-scan.js';

test('拆 PATH：按优先级去重、空段视为当前目录、支持自定义分隔符', () => {
  assert.deepEqual(splitPath('/usr/bin:/bin'), ['/usr/bin', '/bin']);
  assert.deepEqual(splitPath('/usr/bin:/usr/bin:/bin'), ['/usr/bin', '/bin'], '重复目录只留第一次');
  assert.deepEqual(splitPath('/usr/bin::/bin'), ['/usr/bin', '.', '/bin'], '空段按 POSIX 视为当前目录');
  assert.deepEqual(splitPath(''), []);
  assert.deepEqual(splitPath(undefined), []);
  assert.deepEqual(splitPath('C:\\a;C:\\b', ';'), ['C:\\a', 'C:\\b'], 'Windows 分隔符由调用方传入');
});

test('可执行判定：只看常规文件的执行位，隐藏文件与目录都不算', () => {
  const file = (name, mode) => ({ name, isFile: true, isDirectory: false, mode });
  assert.equal(isCommandEntry(file('gh', 0o755)), true);
  assert.equal(isCommandEntry(file('readme.txt', 0o644)), false, '没有执行位');
  assert.equal(isCommandEntry(file('.hidden', 0o755)), false, '隐藏文件不是命令');
  assert.equal(isCommandEntry({ name: 'dir', isFile: false, isDirectory: true, mode: 0o755 }), false, '目录不是命令');
  assert.equal(isCommandEntry(file('symlink-target', 0o755)), true, '调用方已 stat 跟随符号链接');
  assert.equal(isCommandEntry(null), false);
  assert.equal(isCommandEntry({ name: '', isFile: true, mode: 0o755 }), false);
});

test('合并：PATH 顺序优先（与 which 同语义），同目录内按名称稳定排序', () => {
  const merged = mergeByPathOrder([
    { dir: '/first', entries: ['b', 'a'] },
    { dir: '/second', entries: ['a', 'c'] },
  ]);
  assert.deepEqual(merged.map((e) => e.name), ['a', 'b', 'c']);
  assert.equal(merged.find((e) => e.name === 'a').dir, '/first', '先出现的目录赢');
  assert.equal(merged.find((e) => e.name === 'c').dir, '/second');
  assert.equal(merged.find((e) => e.name === 'a').path, '/first/a');
  assert.deepEqual(mergeByPathOrder([]), []);
  assert.deepEqual(mergeByPathOrder([{ dir: '/x' }]), [], '缺 entries 的扫描结果被忽略');
});

test('路径拼接：目录末尾有斜杠时不重复', () => {
  assert.equal(joinDir('/usr/bin', 'gh'), '/usr/bin/gh');
  assert.equal(joinDir('/usr/bin/', 'gh'), '/usr/bin/gh');
});

test('版本行清洗：取第一条非空行、去 ANSI、限长；无内容返回 null', () => {
  assert.equal(parseVersion('git version 2.54.0\n'), 'git version 2.54.0');
  assert.equal(parseVersion('\n\n  v24.21.0  \n'), 'v24.21.0', '跳过空行并 trim');
  assert.equal(parseVersion('openjdk version "21"\r\nsecond line'), 'openjdk version "21"', '处理 CRLF 且只取第一行');
  assert.equal(parseVersion('\u001b[1m1.7.1\u001b[0m'), '1.7.1', '去掉 ANSI 颜色');
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('   \n  '), null);
  assert.equal(parseVersion(undefined), null);
  const long = 'x'.repeat(200);
  const capped = parseVersion(long, 20);
  assert.equal(capped.length, 20);
  assert.ok(capped.endsWith('…'), '超长时截断并加省略号');
});

test('截断：不超限时 truncated 为 false', () => {
  assert.deepEqual(cap([1, 2], 5), { items: [1, 2], truncated: false });
  assert.deepEqual(cap([1, 2, 3], 2), { items: [1, 2], truncated: true });
  assert.deepEqual(cap(null, 2), { items: [], truncated: false });
  assert.ok(PER_DIR_LIMIT > 0 && SYSTEM_TOTAL_LIMIT > 0 && USER_TOTAL_LIMIT > 0);
  assert.ok(PER_DIR_LIMIT >= 1000, '保险丝要大于 /usr/bin 的实际规模，否则会截掉 git 这类常用命令');
});

test('目录分类：家目录与 /usr/local、/opt 算"你自己装的"，/usr/bin 等算系统自带', () => {
  const home = '/Users/me';
  for (const dir of ['/Users/me/.local/bin', '/Users/me', '/usr/local/bin', '/opt/homebrew/bin', '/Users/me/.cargo/bin']) {
    assert.equal(classifyDir(dir, home), 'user', dir + ' 应算你自己装的');
  }
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/libexec', '/System/Cryptexes/App/usr/bin', '/Library/Apple/usr/bin']) {
    assert.equal(classifyDir(dir, home), 'system', dir + ' 应算系统自带');
  }
  assert.equal(classifyDir('/usr/binary', home), 'user', '前缀相同但不是 /usr/bin 的目录不该被误判');
  assert.equal(classifyDir('', home), 'user');
  assert.equal(classifyDir(undefined, home), 'user');
  assert.equal(classifyDir('/usr/local/bin', '/'), 'user', '家目录为 / 时不做特殊处理');
});

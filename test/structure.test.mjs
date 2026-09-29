/**
 * 结构契约：单文件 bundle 的可测边界、样式注入方式、宿主半边依赖面、中英文案一致性。
 *
 * 这几条都是从 `dsh-usage-pill` 上踩过的坑固化下来的：
 *   · 样式塞在组件树里 → 换个槽位渲染就没样式（必须插件级注入）；
 *   · 宿主半边出现裸模块名 → `link:` 安装下解析失败，整个宿主半边起不来；
 *   · 词条只改一边 → 另一种语言显示成 key。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientSource, pureLogicBlock } from './extract-client.mjs';

/** 测试依赖的纯逻辑符号。 */
const REQUIRED = ['ROW_LIMIT', 'filterEntries', 'groupEntries', 'summarize', 'capRows'];

test('纯逻辑标记各出现一次，且区块内确有测试依赖的符号', () => {
  const source = clientSource();
  assert.equal(source.split('// #region 纯逻辑').length - 1, 1);
  assert.equal(source.split('// #endregion 纯逻辑').length - 1, 1);
  const block = pureLogicBlock();
  const missing = REQUIRED.filter((name) => !new RegExp('(function|const)\\s+' + name + '\\b').test(block));
  assert.deepEqual(missing, [], '这些符号不在纯逻辑区块里了：' + missing.join(', '));
});

test('纯逻辑区块不含 React / DOM（这是它能被直接求值的前提）', () => {
  const code = pureLogicBlock()
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const forbidden of ['React', 'document.', 'window.', 'useState', 'useEffect']) {
    assert.ok(!code.includes(forbidden), '纯逻辑区块里出现了 ' + forbidden + '，应移到界面区块');
  }
});

test('样式在插件级注入一次，而不是塞在组件树里', () => {
  const source = clientSource();
  assert.match(
    source,
    /ctx\.effect\(\(\) => \{\s*const style = document\.createElement\('style'\)/,
    '缺少插件级样式注入（ctx.effect + document.createElement(\'style\')）',
  );
  assert.ok(!/h\('style'/.test(source), '不应在组件树里渲染 <style>：换个槽位就一个样式都拿不到');
});

test('宿主半边只用相对路径与 node: 内置模块（link: 安装下裸模块名解析不到）', () => {
  for (const file of ['index.js', 'lib/path-scan.js', 'lib/allowlist.js']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^\s*import\s[^'"]*?['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('node:'),
        file + ' 引入了裸模块名 "' + specifier + '"',
      );
    }
  }
});

test('注册进 settings.section，且导航标签是 thunk（跟随语言）', () => {
  const source = clientSource();
  assert.match(source, /slots\.inject\('settings\.section'/, '必须注册进 settings.section（一个设置页）');
  assert.match(source, /label: \(\) => tn\('nav'\)/, 'label 应是 thunk，切语言时导航文字才会跟着变');
  assert.match(source, /id: 'cli-inventory'/, '应使用自己的 id，避免复用到别人的槽位单元');
  assert.match(source, /locale: NS/, '应声明词典命名空间，导航标签与页面用同一套文案');
});

test('中英文案键完全一致，且没有声明了却用不到的词条', () => {
  const source = clientSource();
  const block = (name) => {
    const start = source.indexOf('const ' + name + ' = {');
    const end = source.indexOf('\n    };', start);
    assert.ok(start > 0 && end > start, '找不到 ' + name + ' 词典');
    return source.slice(start, end);
  };
  const keys = (text) => new Set([...text.matchAll(/'([A-Za-z]+\.[A-Za-z]+|[a-z]+)':/g)].map((m) => m[1]));
  const zh = keys(block('ZH'));
  const en = keys(block('EN'));
  assert.deepEqual([...zh].sort(), [...en].sort(), '中英词条集合必须一致');
  const rest = source.replace(block('ZH'), '').replace(block('EN'), '');
  const unused = [...zh].filter((key) => !rest.includes("'" + key + "'"));
  assert.deepEqual(unused, [], '这些词条声明了但没被引用：' + unused.join(', '));
});

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
const REQUIRED = ['ROW_LIMIT', 'filterEntries', 'groupEntries', 'sortForDisplay', 'summarize', 'capRows'];

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

test('样式是插件级幂等注入：按键复用同一个 <style>，且不塞进某个槽位的组件树里', () => {
  const source = clientSource();
  // 踩过的坑 1：<style> 原先放在徽标组件的返回树里，而设置卡是在**另一个槽位**
  // （插件页的 plugins.bundle.config）渲染的 —— 那边一个样式都拿不到，
  // 整张卡退化成挤成一行的裸文字 + 原生复选框。所以样式必须挂在插件 fiber 上。
  // 踩过的坑 2：原先 dispose 时移除 <style>，一旦出现孤儿注册（HMR 重载期间的旧实例），
  // 页面就变成「组件还在、样式没了」。所以改成按键复用、不随 dispose 移除。
  assert.match(
    source,
    /ctx\.effect\(\(\) => \{\s*let style = document\.querySelector\('style\[data-dsh-style=/,
    '缺少插件级幂等样式注入（按键 querySelector 复用，官方也是这个写法）',
  );
  assert.match(source, /style\.textContent = CSS/, '每次 apply 都应刷新样式内容，否则更新版本会用到旧样式');
  assert.ok(
    !/style\.remove\(\)/.test(source),
    '不应随 dispose 移除：孤儿注册仍需样式，否则页面会变成「组件还在、样式没了」',
  );
  assert.ok(
    !/h\('style', null, CSS\)/.test(source),
    '不应再在组件树里渲染 <style>：其它槽位的组件拿不到它',
  );
});

test('每个内联 SVG 都必须有显式 width/height', () => {
  // 一个只有 viewBox 的 SVG 在没有 CSS 时**会撑满容器** —— 这正是"徽标变成巨型
  // 图标"那个故障的放大器。根因修掉之后，这条门禁保证放大器不会回来。
  const source = clientSource();
  const marker = "h('svg', {";
  const offenders = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let end = index + marker.length - 1;
    for (let cursor = end; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    const block = source.slice(index, end + 1);
    if (!/\bwidth:\s*\d/.test(block) || !/\bheight:\s*\d/.test(block)) {
      offenders.push(block.replace(/\s+/g, ' ').slice(0, 70));
    }
    index = source.indexOf(marker, end);
  }
  assert.ok(offenders.length === 0, '这些内联 SVG 缺显式宽高：' + offenders.join(' | '));
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

test('每个 slots.inject 都必须紧贴在 ctx.effect(() => …) 里（否则 dispose 后会泄漏成"组件在、样式没了"）', () => {
  const source = clientSource();
  // 只认**紧贴**的写法：中间除空白外不允许有别的东西。
  // 【教训】先前这版门禁是"往前 160 字符里出现过 ctx.effect( 就算过" —— 变异测试证明它
  // 抓不到回退：有多处注入时，没包住的那处仍能看到前一处的 ctx.effect(。
  const total = [...source.matchAll(/ctx\.slots\.inject\(/g)].length;
  const wrapped = [...source.matchAll(/ctx\.effect\(\(\)\s*=>\s*ctx\.slots\.inject\(/g)].length;
  assert.ok(total > 0, '本插件应当至少有一处 slots.inject');
  assert.equal(wrapped, total, `有 ${total - wrapped} 处 slots.inject 没有紧跟 ctx.effect(() => …)`);
});

test('凡是用 999px / 50% 做圆角的地方，都必须显式退出全局超椭圆', () => {
  // 宿主用 `*,:before,:after { corner-shape: superellipse(1.5) }` 把全局圆角改成了超椭圆，
  // 于是"胶囊/正圆"会被压成偏方的形状。想要真圆必须自己声明 corner-shape:round。
  const source = clientSource();
  const match = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(match !== null, '找不到 CSS 模板字符串');
  const offenders = [];
  for (const block of match[1].split('}')) {
    if (!/border-radius\s*:\s*(999px|50%)/.test(block)) continue;
    if (!/corner-shape\s*:\s*round/.test(block)) {
      offenders.push(block.trim().split('\n').pop().trim().slice(0, 60));
    }
  }
  assert.deepEqual(offenders, [], '这些规则用了胶囊/正圆但没写 corner-shape:round：' + offenders.join(' | '));
});

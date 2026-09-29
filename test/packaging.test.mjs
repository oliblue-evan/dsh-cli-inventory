/**
 * 打包契约：插件页的「介绍/图标」与市场的收录判定都读 package.json，几处声明一旦缺失
 * **不会报错、只会静默退化**（在 `dsh-usage-pill` 上正是这样丢过整份元数据）。所以钉死。
 *
 * 依据：
 *   · `dsh-app-boot` 的 `readPluginMeta` —— `<包>/package.json` 与 `<包>/locale/en.json`
 *     必须能通过 **Node 的 ESM 解析器**解析到（`exports` 未声明的子路径会被拒）；
 *   · 同一文件的 `iconOf` —— 图标为包内相对路径、SVG/PNG/JPEG/WebP、≤ 256 KiB；
 *   · DSH 插件市场 STANDARD.md §2.1 / §9 —— main、repository、disclosure。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('exports 暴露元数据与入口子路径', () => {
  const exports = pkg.exports;
  assert.ok(exports !== null && typeof exports === 'object', 'exports 必须是对象');
  assert.equal(exports['.'], './index.js');
  assert.equal(exports['./client'], './client.js');
  assert.equal(exports['./package.json'], './package.json', 'readPluginMeta 要解析 <包>/package.json');
  assert.ok(exports['./locale/*.json'], 'readPluginMeta 要解析 <包>/locale/<语言>.json');
});

test('入口与仓库元数据齐备（市场安装管线依赖）', () => {
  assert.equal(typeof pkg.main, 'string');
  const main = resolvePath(ROOT, pkg.main);
  assert.ok(statSync(main).isFile(), 'main 必须指向真实存在的文件（产物型）');
  assert.ok(
    pkg.scripts === undefined || pkg.scripts.build === undefined,
    '不该有 scripts.build：本插件是产物型，市场会据此直接复制而无需构建',
  );
  assert.equal(typeof pkg.repository?.url, 'string', 'repository 影响"已安装识别"与市场卡片展示');
  assert.equal(pkg.license, 'MIT');
});

test('披露字段：无云端依赖时 network 必须为空且离线可用', () => {
  const d = pkg.disclosure;
  assert.ok(d !== null && typeof d === 'object', '需要 disclosure（STANDARD §9）');
  assert.equal(d.cloud, false, '本插件不联网');
  assert.deepEqual(d.network, [], 'cloud=false 时不得声明端点');
  assert.equal(d.offlineMode, true);
  assert.ok(Array.isArray(d.permissions) && d.permissions.length > 0, 'D4 权限声明必填');
  assert.ok(Array.isArray(d.apiKeys), 'apiKeys 必须是数组');
  if (d.cloud === true) assert.ok(d.apiKeys.length > 0, 'cloud=true 时必须披露凭据（D3）');
  assert.equal(d.retention, 'none');
});

test('介绍文案：en.json 必需，各语言文件字段非空', () => {
  const localeDir = join(ROOT, 'locale');
  const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.includes('en.json'), '没有 en.json 时整个字典不生效');
  for (const name of files) {
    assert.match(name.slice(0, -5), /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/, name + ' 的文件名必须是语言 id');
    const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'));
    assert.equal(typeof parsed.meta, 'object', name + ' 需要 { meta: { title, description } }');
    for (const field of ['title', 'description']) {
      const value = parsed.meta[field];
      assert.equal(typeof value, 'string', name + ' meta.' + field + ' 必须是字符串');
      assert.ok(value.trim() !== '', name + ' meta.' + field + ' 不能为空');
    }
  }
});

test('图标满足 iconOf 的全部规则', () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json 需要 icon 字段');
  assert.ok(!isAbsolute(pkg.icon), 'icon 必须是相对路径');
  assert.ok(!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(pkg.icon), 'icon 不能是绝对 URL');
  const media = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  assert.ok(media[extname(pkg.icon).toLowerCase()] !== undefined, 'icon 必须是 SVG/PNG/JPEG/WebP');
  const file = resolvePath(ROOT, pkg.icon);
  assert.ok(statSync(file).isFile(), 'icon 必须是常规文件');
  assert.ok(statSync(file).size <= 262144, 'icon 不能超过 256 KiB');
  const local = relative(realpathSync(ROOT), realpathSync(file));
  assert.ok(!local.startsWith('..') && !isAbsolute(local), 'icon 必须留在包目录内');
});

test('files 清单覆盖真正需要分发的目录', () => {
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'lib', 'locale', 'assets']) {
    assert.ok(pkg.files.includes(required), 'files 缺少 ' + required);
  }
});

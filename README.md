# dsh-cli-inventory 🧰

> **English quick start** — A DSH plugin that answers *"what command-line tools do I actually have?"*
> It adds one page to **Settings** listing the CLIs on your machine — name, version, and path —
> split into **bundled DSH runtimes**, **installed by you**, and **system**. Read-only: the host
> enumerates PATH directories and only ever executes a **built-in allowlist** to read versions;
> everything else is listed by name and path. No network, no credentials, no telemetry.
> Install: `plugin_manager(action: "install_bundle", target: "github:oliblue-evan/dsh-cli-inventory")`,
> then restart DSH and reload the page. MIT.

DSH 本身**不跟踪你装了哪些命令行工具**（设置里只有账户 / 通用 / 模型 / 插件 / 智能体预设五个页面）。
这个插件补上那一页：**设置 → 环境与 CLI**。

```
环境与 CLI                                          [重新扫描]
PATH 12 个目录 · 命令 1270 个 · 取到版本 15 个
你自己装的 7 · 系统自带 1263
[自己装的] 系统自带  全部
[ 过滤命令名或路径… ]

▾ DSH 自带运行时  2
    node      v24.21.0                  ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
    python3   Python 3.12.14            ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3

▾ 你自己安装的  7
    dsh       dsh 0.2.0-rc.2            ~/.local/bin/dsh
    gh        gh version 2.101.0        ~/.local/bin/gh
    uv        uv 0.9.4                  ~/.local/bin/uv
    …

▸ 系统自带  1263                     ← 默认折叠，点一下才展开
```

**默认视图只有十来行**。系统段是「上千项」的那一段，默认折叠；真的要看时点开它，或者用
上方的搜索框 —— 搜索会**跨全部范围**查找（此时会显示一行提示，免得你以为筛选失效了）。

## 为什么值得分段

一台机器上 `/usr/bin` 就有近千项，而你**真正装的**往往只有个位数。
如果不加区分地按总量截断，界面上先看到的一屏全是系统工具，等于答非所问。
所以宿主会按目录性质分类，客户端分成三段、**各自独立限流** —— 「你自己安装的」不会被系统目录挤掉。

## 界面上做的几件事（都是为了"别让几百行砸在你脸上"）

| 做法 | 为什么 |
|---|---|
| **系统段默认折叠** | 它是上千项的那一段；默认铺开正是页面显得乱七八糟的原因 |
| **范围胶囊**：自己装的 / 系统自带 / 全部 | 默认只显示你装的那些；想找系统工具再切过去（切过去会自动展开） |
| **搜索跨全部范围** | 搜 `git` 时它在系统段，若还守着当前筛选就会得到"没有匹配"，那是反直觉的 |
| **有版本的排前面** | 否则首屏全是 `AssetCacheLocatorUtil` 这类系统内部工具，而 `git` / `jq` / `make` 被压在几百行之后 |
| **每段独立限流** | 即使系统段展开，也不会挤掉「你自己安装的」 |
| **摘要给出分组构成** | `你自己装的 7 · 系统自带 1263` —— 折叠状态下也能一眼看出"多的是什么" |

分类规则（`lib/path-scan.js` 的 `classifyDir`）：

| 归类 | 目录 |
|---|---|
| **你自己安装的** | `~/**`（含 `~/.local/bin`、`~/.cargo/bin`）、`/usr/local/bin`、`/opt/**`（含 `/opt/homebrew/bin`） |
| **系统自带** | `/bin`、`/sbin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec`、`/System/**`、`/Library/Apple/**`、`/usr/lib/**` |

路径会**缩掉家目录前缀**（`/Users/you/.local/bin/gh` → `~/.local/bin/gh`）—— 界面更短，
你分享截图时也不会顺带暴露用户名。

## 安全边界（这一节最重要）

枚举 PATH 只是读目录，安全。**取版本需要执行二进制**，风险就在这里，所以：

- 只对 `lib/allowlist.js` 里**写死的清单**执行（约 40 个常见工具：git / gh / node / python3 /
  uv / jq / docker / …），参数固定、**不带任何用户输入**、单次超时 5 秒、并发上限 6、
  只取第一条输出行并去掉 ANSI 颜色；
- 白名单之外的命令**照常列出名称与路径，但绝不执行**；
- 宿主半边**不写文件、不联网、不读凭据**；
- 数据路由带来源守卫：非回环 Host、跨站（`Sec-Fetch-Site: cross-site`）一律 403，非 GET 405。

想加白名单条目？必须是"会打印版本后退出、无副作用"的命令，直接在 `lib/allowlist.js` 里加一行，
`npm test` 会检查清单结构（名称唯一、参数非空、白名单里不得出现 `rm` / `bash` 这类）。

## 数据从哪来

宿主半边注册一条**只读**路由 `/api/cli-inventory/list`，做三件事：

1. 按 PATH 顺序读各目录，`stat` 跟随符号链接（与 `which` 语义一致），**先出现的目录赢**；
2. 对白名单里存在的命令取版本；
3. 报出 DSH 自带的运行时，标为 `harness`。运行时取**两个来源**：当前宿主进程自己
   （`process.execPath`，桌面版就是 app 内自带的 node），以及
   `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/{node,python}/bin/*`（CLI 侧安装的运行时）。

> 早先只从 `process.execPath` 旁边推 python 路径（`../python/bin/python3`）。那在 CLI 启动时成立，
> 但在**桌面版下必然失败** —— app 自带的 node 旁边没有 python，界面上于是只有一个 node、
> python 凭空消失。改成扫运行时目录后两种启动方式都能列全。

一次全量扫描约 800 ms（1270 次 `stat` + 十几次探测），所以结果有 **15 秒短缓存**；
界面上的「重新扫描」按钮会带 `?fresh=1` 绕过缓存，保证按钮按下去一定是新的。

## 文件

```
index.js              宿主：扫描 + 白名单探测 + 只读路由（零第三方依赖）
client.js             客户端：设置页（单文件 bundle，含可测的纯逻辑区块）
lib/path-scan.js      PATH 解析 / 可执行判定 / 顺序合并 / 版本行清洗 / 目录分类（纯函数）
lib/allowlist.js      版本探测白名单（安全边界所在）
cordis.patch.yml      bundle 层：挂一行宿主条目
locale/{en,zh}.json   插件页标题与简介（官方 meta 约定）
assets/icon.svg       插件图标
test/                 31 项断言 + 宿主冒烟测试
```

## 安装 / 卸载

```bash
# 官方 CLI
dsh plugin --profile <profile> add github:oliblue-evan/dsh-cli-inventory
```

或在 DSH 里用 `plugin_manager`：

```text
plugin_manager(action: "install_bundle", target: "github:oliblue-evan/dsh-cli-inventory")
```

卸载：

```bash
dsh plugin --profile <profile> remove dsh-cli-inventory
```

> **装完必须重启 DSH**：宿主半边不会被热重载（Node 的 ESM 缓存），新路由要重启才注册。
> 重启后打开 **设置 → 环境与 CLI**。

本地开发用 `link:` 安装（改代码即时生效，宿主半边仍需重启）：

```text
plugin_manager(action: "install_bundle", target: "link:/path/to/dsh-cli-inventory")
```

## 隐私与数据披露

同样的内容以机器可读形式声明在 `package.json` 的 `disclosure` 字段（DSH 插件市场 §9 披露契约）。

| 项 | 声明 |
|---|---|
| 云端依赖 | **无** —— 插件不发起任何网络请求 |
| 完全离线 | **是** |
| 凭据 | **不读取任何凭据 / API Key** |
| 权限 | 只读 PATH 目录；对**白名单**执行 `--version` 取版本 |
| 数据留存 | **无** —— 不落盘、不外发；宿主的 15 秒缓存只在内存里 |
| 遥测 / 统计 | **无** |
| 返回内容 | 仅命令名、版本、缩略路径；**不含**绝对家目录路径 |

## 测试

```bash
npm test          # 31 项断言：PATH 解析 / 分类 / 白名单 / 客户端纯逻辑 / 打包契约 / 结构契约
node test/host-smoke.mjs   # 宿主冒烟：真的读 PATH、真的取版本、验证来源守卫、分组计数、运行时识别与缓存
```

`npm test` 是 hermetic 的（不碰文件系统、不拉进程）；冒烟测试单独跑，因为它确实会扫盘。

这些门禁都是**踩过坑之后固化下来的**：

- **打包契约** —— `exports` 必须暴露 `./package.json` 与 `./locale/*.json`。宿主读插件页标题/简介
  走 Node 的 ESM 解析器，`exports` 没声明就等于"资源不存在"，而且**不报错、静默退化**成没有标题和图标。
- **结构契约** —— 样式必须插件级注入（塞在组件树里的话，换个槽位渲染就一个样式都拿不到）；
  宿主半边不得出现裸模块名（`link:` 安装下解析失败会让整个宿主半边起不来）；
  用 `999px` / `50%` 做圆角的地方必须写 `corner-shape:round`（宿主把全局圆角改成超椭圆了，不写就变形）。
- **`slots.inject` 必须由 `ctx.effect` 管住** —— 否则插件被 dispose 后注册会泄漏，而 `<style>` 已被移除，
  页面变成「组件还在、样式没了」。（这条在 `dsh-usage-pill` 上真实爆过一次。）
- **词条与隐私** —— 中英词典必须键一致、且没有声明了却引用不到的词条（写成 `t('scope.' + key)`
  拼字符串会被它抓出来）；冒烟测试检查响应里**不得出现绝对家目录**，这条当场抓到过一个真 bug：
  响应里漏了未缩略的 `dir` 字段。

> 门禁本身也做了**变异测试**：把修复回退、看门禁会不会报错。第一版 `slots.inject` 门禁就是这么被
> 证明是假的（"往前 160 字符里出现过 `ctx.effect(` 就算过"，多处注入时抓不到漏包的那处）。

## 已知取舍

- **只扫 PATH**，不猜别处（`/Applications` 里的 GUI 程序不算 CLI）。要看某个不在 PATH 的工具，
  自己把它加进 PATH 即可。
- **版本只对白名单取**（约 40 个常见工具）。白名单之外一律显示"未取版本" —— 这是有意的安全取舍，
  不是功能缺失。
- 单次扫描约 800 ms，首屏会有一次这个开销；之后 15 秒内复用缓存，「重新扫描」会绕过缓存。
- **系统段默认折叠**，且展开后每段最多渲染 80 行；要找更靠后的命令用搜索。
- 数据是**全量**发给界面的（约 1270 条 / 118 KB），所以搜索是完整的 —— 换来的是首屏那一次 800 ms。
- 白名单是**代码里的静态清单**，新工具不会自动出现版本；提 issue 或自己加一行都行。

## 协作说明

本插件由 **李敖（oliblue）** 与 **DeepSeek（deepseek-flash）** 协作完成：需求、设计与逐轮验收由作者负责，
代码实现与测试由模型完成；**版权归人类作者所有**（见 [LICENSE](LICENSE)）。

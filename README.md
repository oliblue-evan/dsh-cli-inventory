# dsh-cli-inventory 🧰

> **English quick start** — A DSH plugin that answers *"what can this agent actually operate?"*
> It adds one page to **Settings**: the **tool registry** (the tools really handed to the model),
> the **skill registry**, **MCP** servers and their contributed tools, then the machine side
> (CLIs on PATH, bundled runtimes, system commands folded away). Everything is read-only and
> fault-tolerant; the command list only enumerates PATH directories and executes a **built-in
> allowlist** to read versions. No network, no credentials, no telemetry.
> Install: `plugin_manager(action: "install_bundle", target: "github:oliblue-evan/dsh-cli-inventory")`,
> then restart DSH and reload the page. MIT.

DSH 的设置里只有账户 / 通用 / 模型 / 插件 / 智能体预设五页 —— **它不会告诉你这个 Agent 手里有什么**。
这个插件补上那一页：**设置 → 环境与能力**。

> **这一页的定位改过一次，缘由值得写下来。** 第一版做的是"这台机器上装了哪些命令行工具"，
> 结果列出 1270 个命令、其中 1263 个是 macOS 内部工具（`AssetCacheLocatorUtil`、`BTLEServer`…），
> 既没用也没信息量。而**清单本来就不是能力边界** —— 有 `bash` 就能跑 PATH 里任何东西，
> 真正的边界是**权限策略**。所以改成先答"我能操作什么"（工具 / 技能 / MCP），
> 机器清单退到后面，**系统目录干脆不列**（占了实测里 96% 的条目，却毫无参考价值）。

```
环境与能力
工具 40 · 技能 0 · MCP 服务器 0
扫描了 PATH 中 7/12 个目录 · 命令行工具 7 个 · 取到版本 4 个
[ 搜索工具、技能、命令… ]

▾ 工具  40                        ← 真正发给模型的那一批
    bash                执行 bash 命令（bash -c）并返回 stdout/stderr…
    read                读取 UTF-8 文本文件，返回带行号的内容…
    grep                用 ripgrep 正则搜索文件内容…
    …

▾ 技能  0
    还没有技能。
    把技能放到 ~/.dsh/skills/<名字>/SKILL.md 就会出现；装了技能包插件也会汇总到这里。

▾ MCP  0
    还没有配置 MCP 服务器。
    配置后它们贡献的工具会出现在这里（命名形如 mcp__<服务器>__<工具>）。

▾ DSH 自带运行时  2
    node / python3 …
▾ 你自己安装的  7
    dsh / gh / uv / uvx / tailscale …
```

**整页只有几十行**，而且先看到的是"我现在能操作什么"。没有刷新按钮 —— 每次打开都会重新取数。

## 为什么不列系统目录

一开始我把整条 PATH 都列出来，结果是 **1270 个命令里 1263 个来自系统目录**
（`/usr/bin` 932 个、`/usr/sbin` 222 个…），全是 `AssetCacheLocatorUtil`、`BTLEServer`
这类 macOS 内部工具 —— 既没有实用价值，也把真正要看的那几个（`gh` / `uv` / `dsh`）淹掉了。

所以现在**宿主直接跳过系统目录**。这带来两个结果：

- 页面只剩"你自己装的"那几行，不再有上千行；
- **扫描从 ~800 ms 降到 ~40 ms**（少掉 96% 的 `stat`）—— 顺带把 15 秒缓存和
  「重新扫描」按钮都变成了多余机关，于是也一并删掉了。

需要看某个系统命令时用终端 `which` / `command -v` 即可，那不是这一页的职责。

## 界面上做的几件事

| 做法 | 为什么 |
|---|---|
| **能力段排在最前** | 工具 / 技能 / MCP 才是"我能操作什么"；机器清单退到后面 |
| **空段给出"怎么才会有"** | 技能与 MCP 现在多半是 0，直接写清放哪里、配了就会出现在这里 |
| **有版本的排前面** | 有版本信息的更能说明"它是什么"，没取到版本的一律注明「未取版本」 |
| **每段独立限流** | 某一段再长也不会挤掉别的段 |
| **摘要分两行** | 一行能力计数、一行机器计数，各自一眼可读 |

分类规则（`lib/path-scan.js` 的 `classifyDir`）：

| 归类 | 目录 | 处理 |
|---|---|---|
| **你自己安装的** | `~/**`（含 `~/.local/bin`、`~/.cargo/bin`）、`/usr/local/bin`、`/opt/**`（含 `/opt/homebrew/bin`） | 扫描并列出 |
| **系统自带** | `/bin`、`/sbin`、`/usr/bin`、`/usr/sbin`、`/usr/libexec`、`/System/**`、`/Library/Apple/**`、`/usr/lib/**` | **跳过，不列**（`classifyDir` 仍在，将来想列回随时可以） |

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

宿主半边注册一条**只读**路由 `/api/cli-inventory/list`，做四件事：

0. **读能力**：`ctx.tools.schemas()`（工具注册表）、`ctx.skills.list()`（技能注册表）、
   以及 MCP。MCP 不需要翻配置 —— `dsh-mcp-client` 把工具注册成
   `mcp__<服务器>__<工具>`，所以**服务器名直接从工具名反推**（按第一个 `__` 切，
   避免服务器名里的单个下划线把名字拆坏）。这三个服务全部**容错**：取不到或抛错
   只如实显示 0，绝不让整页失败。
1. 按 PATH 顺序读各目录 —— **只读"你自己装的"那些，系统目录直接跳过**；
   `stat` 跟随符号链接（与 `which` 语义一致），**先出现的目录赢**；
2. 对白名单里存在的命令取版本；
3. 报出 DSH 自带的运行时，标为 `harness`。运行时取**两个来源**：当前宿主进程自己
   （`process.execPath`，桌面版就是 app 内自带的 node），以及
   `$DSH_HOME/dsh-runtimes/<runtime>/dependencies/{node,python}/bin/*`（CLI 侧安装的运行时）。

> 早先只从 `process.execPath` 旁边推 python 路径（`../python/bin/python3`）。那在 CLI 启动时成立，
> 但在**桌面版下必然失败** —— app 自带的 node 旁边没有 python，界面上于是只有一个 node、
> python 凭空消失。改成扫运行时目录后两种启动方式都能列全。

一次扫描只走"你自己装的"那几个目录，实测**约 40 ms**（跳过系统目录省掉了 96% 的 `stat`）。
所以这一页**没有缓存、也没有刷新按钮**：每次打开就是最新的。

## 文件

```
index.js              宿主：扫描 + 白名单探测 + 只读路由（零第三方依赖）
client.js             客户端：设置页（单文件 bundle，含可测的纯逻辑区块）
lib/capabilities.js   工具 / 技能 / MCP 的识别与归一化（纯函数）
lib/path-scan.js      PATH 解析 / 可执行判定 / 顺序合并 / 版本行清洗 / 目录分类（纯函数）
lib/allowlist.js      版本探测白名单（安全边界所在）
cordis.patch.yml      bundle 层：挂一行宿主条目
locale/{en,zh}.json   插件页标题与简介（官方 meta 约定）
assets/icon.svg       插件图标
test/                 37 项断言 + 宿主冒烟测试
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
| 数据留存 | **无** —— 不落盘、不外发，也没有缓存（每次请求都是当场扫描） |
| 遥测 / 统计 | **无** |
| 返回内容 | 仅命令名、版本、缩略路径；**不含**绝对家目录路径 |

## 测试

```bash
npm test          # 37 项断言：能力识别 / PATH 解析 / 分类 / 白名单 / 客户端纯逻辑 / 打包契约 / 结构契约
node test/host-smoke.mjs   # 宿主冒烟：真的读 PATH、真的取版本、验证来源守卫、只扫用户目录、运行时识别、能力段容错
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

- **只扫"你自己装的"那部分 PATH**：`~/**`、`/usr/local/bin`、`/opt/**`。系统目录
  （`/usr/bin` 等上千项）**不列出** —— 那是实测里 96% 的噪音。要看某个系统命令用终端的
  `which` / `command -v`；`/Applications` 里的 GUI 程序也不算 CLI。
- **版本只对白名单取**（约 40 个常见工具）。白名单之外一律显示"未取版本" —— 这是有意的安全取舍，
  不是功能缺失。
- 单次扫描约 40 ms，每次打开这一页都会重新取数（没有缓存这层机关）。
- 每段最多渲染 80 行；现在条目只有十几条，这个上限几乎用不到。
- 白名单是**代码里的静态清单**，新工具不会自动出现版本；提 issue 或自己加一行都行。
- **技能与 MCP 现在多半是 0**（本机既没装技能、也没配 MCP 服务器）。这不是占位符：
  接口已经接好，`~/.dsh/skills/**/SKILL.md` 或一个 MCP 服务器一出现，它们就会自动列出来。
- **工具列表是"当前组合"的**：换 Agent 预设、加 MCP 服务器、装带工具的插件，这里都会跟着变。
- **没做「斜杠命令」**：`ctx.commands.list()` 的签名要求传入一个 `Agent`，插件侧没有稳定入口；
  而且那是**你输入的命令**，属于用户侧能力，不是 Agent 的。要做的话另开一段更合适。

## 协作说明

本插件由 **李敖（oliblue）** 与 **DeepSeek（deepseek-flash）** 协作完成：需求、设计与逐轮验收由作者负责，
代码实现与测试由模型完成；**版权归人类作者所有**（见 [LICENSE](LICENSE)）。

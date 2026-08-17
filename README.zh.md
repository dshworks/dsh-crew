<table>
<tr>
<td width="40%" valign="top">

# dsh-crew

[English](README.md) | 中文

### 把 Claude Code 和 Codex 作为实时终端开在 dsh 旁边。你看得见它们干活，也随时能接管键盘。

dsh 本来就能把活派给它们 —— `subagent-claude-code` 和 `subagent-codex`
会启动对应产品、交给它一个任务，然后把最后一句话带回来。它们刻意不做的，
是让你**看见过程**：没有进度流，没有人介入的通道，面向模型的终端工具
文档里明写着 "no TUI"。

`dsh-crew` 补上缺的那一半。每个成员都拿到一个真实 PTY，在本会话的工作区里
跑它自己的 CLI，并把字节流送到 Web UI 的一个面板里。中间那一栏的 agent
负责让它们入座、给它们派活；而这一切的每一次击键你都看得见，
任何时候都可以直接在面板里打字。

[![ci](https://github.com/dshworks/dsh-crew/actions/workflows/ci.yml/badge.svg)](https://github.com/dshworks/dsh-crew/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dshworks/dsh-crew?color=4D6BFE)](https://www.npmjs.com/package/@dshworks/dsh-crew)
[![powered by dsh](https://img.shields.io/badge/powered__by-dsh-4D6BFE?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</td>
<td width="60%" valign="top">

<img src="https://raw.githubusercontent.com/dshworks/dsh-crew/main/docs/crew-dark.png" alt="dsh Web UI 中 Chat 和 Trajectory 旁边打开的团队标签页：入座栏里列着 Claude Code、Codex 和 dsh，一个面板里跑着真实的 Claude Code 终端界面，工作目录就是本会话的工作区" width="100%">

</td>
</tr>
</table>

## 安装

```sh
dsh plugin --profile web add @dshworks/dsh-crew
dsh --profile web
```

`dsh plugin` 转发给 pnpm，所以 pnpm 需要在 PATH 上。下一个会话里，
**团队**标签页就会出现在 Chat 和 Trajectory 旁边。

不需要额外配置。入座栏会列出它能找到的所有成员，找不到的那些则被禁用 ——
原因直接写在按钮上，所以缺失的 `codex` 显示为
`codex is not on the host PATH`，而不是点下去一秒后才失败。

## 两半

**人的那一半**是分屏：一条入座栏，每个入座成员一个面板。面板是真终端 ——
有颜色、有光标定位、跑的是产品自己的 TUI —— 因为这个插件搬运的是 CLI 的
字节，而不是重新实现它的界面。你随时可以往里打字，用 Ctrl-C 中断它，
或者用群发输入框把同一句话同时送进所有存活面板，
让两个 agent 并排回答同一个问题。

**agent 的那一半**是五个工具，中间栏的模型用它们来带队：

```text
crew_list                              → 谁能入座，谁已经在场
crew_seat(agent: "claude")             → 开一个面板，返回它的 id 和第一屏
crew_send(pane: "…", message: "…")     → 打字、回车，然后等它安静下来
crew_peek(pane: "…")                   → 此刻的屏幕，和人看到的一模一样
crew_dismiss(pane: "…")                → 结束这个进程
```

共用同一个界面正是重点：派活和观察落在同一个终端上 —— agent 的
`crew_send` 和你的眼睛看的是同一块屏幕，而不是一个任务 API 加一份日志。

用 `tools: false` 关掉工具，分屏照常工作，只是团队变成纯人工驱动。

### 为什么 `crew_send` 要等

编程 agent 的回答要几十秒才出来。发完就返回会逼模型轮询，
每采样一次烧掉一个 turn。所以 `crew_send` 在面板**安静下来**时才返回 ——
即渲染出的屏幕在一段静默窗口内不再变化。超时了它会明说，
并让模型稍后 `crew_peek`；成员那边照样继续干。

但只看「安静」在两个方向上都不够，而这两处修正都来自真实 CLI，
不是来自测试用的那个 shell：

- **回车和消息分两次写。** 两个产品都会把「一串字节以回车结尾」当成
  **粘贴**，回车于是变成输入框里的换行 —— 所以 `message + "\r"` 一次写完
  只会把任务打进输入框，一个字都没发出去。此时面板反而静了下来，
  只按静默判定的话，模型拿回的就是自己那句还没发出去的问题。
- **没画出来的屏幕不算安静。** 还没渲染出第一帧的 CLI 安静得很，
  所以入座要同时等到「有内容」和「静下来」，才算这个成员就位。

### 为什么宿主还要再跑一个终端模拟器

原始终端字节适合发给浏览器，却完全不适合塞进上下文窗口：全屏 CLI
会绝对定位光标并重绘，所以字节流里大部分是转义序列，同一段文字还出现好几遍。
剥掉转义序列并不能解决问题 —— 那样得到的是按到达顺序叠在一起的碎片，
不是屏幕。

于是宿主用浏览器同款模拟器、以无头方式跑同一份字节。`crew_peek`
返回的就是人正在看的那张字符网格。这也是本插件唯一需要依赖终端模拟器的原因。

## 名册

| id | 名称 | 命令 |
|---|---|---|
| `claude` | Claude Code | `claude` |
| `codex` | Codex | `codex` |
| `dsh` | dsh | `dsh` |

每个都以**交互形态**启动 —— 不带 prompt 参数的裸命令，
这才会让 CLI 进入它自己的终端界面，而不是一次性模式。

名册条目是数据，不是代码。加第四个 agent 就是一行配置，
永远不需要新包：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-crew
  config:
    agents:
      - id: aider
        label: Aider
        command: aider
        accent: '#7c3aed'
```

`id` 与内置项相同的行会逐字段**覆盖**那个内置项，
所以把 `claude` 指向一个包装脚本只需一行。`enabled: false` 则移除一个。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `agents` | `[]` | 额外成员，或按 `id` 覆盖内置项 |
| `trustedHosts` | `[]` | 除环回外还允许访问这两个路由的 authority，与部署已有的 `--trusted-host` 保持一致 |
| `cols` / `rows` | `100` / `30` | 浏览器没量出尺寸时的面板几何 |
| `scrollbackBytes` | `262144` | 每个面板保留的原始输出，用于重新加载后重绘 |
| `maxPanesPerSession` | `6` | 单会话同时打开的面板上限 |
| `graceMs` | `3000` | 关闭面板时从 SIGTERM 到 SIGKILL 的宽限 |
| `tools` | `true` | 是否向 dsh agent 暴露这五个工具 |

## 安全

开一个面板就是在运维者的机器上起一个进程，
所以本插件挂的这两个路由，标准比只读路由更严。

- **工作目录绝不由浏览器决定。** 它来自请求指名的那个 dsh 会话，
  与 harness 自带的 subagent provider 取法完全一致。会话解析不出来时
  **直接拒绝**，而不是回退 —— 回退到服务端 cwd 意味着仅凭一个不认识的 id，
  就把 dsh 启动目录的写权限交给了一个编程 agent。
- **两个路由都有请求围栏**：`Host` authority（环回，或 `trustedHosts`
  中声明的项）加 `Sec-Fetch-Site`/`Origin`。格式不对的 `trustedHosts`
  条目会让**加载失败**，而不是留到请求时才报错。
- **控制路由要求 `application/json`。** 这是实打实的控制项：
  跨站"简单请求"正是浏览器不带 CORS 预检就发出的那种，而它设不了这个媒体类型，
  所以恶意页面无法盲打到一个有副作用的操作上。
- **WebSocket 需要一次性 token**，由通过围栏的控制路由签发，30 秒内有效 ——
  这才证明了是一个通过围栏的调用方要的这条流。
- **工具调用只能碰本会话自己的面板。**
- **这里不写会话日志。** 原始终端字节不是对话状态。

围栏回答的是"这个请求是不是来自本机的 dsh UI"。它不是认证，
网络可达性依旧由 webserver 的 bind 策略决定 ——
如果你把 dsh 暴露到 localhost 之外，那才是真正要紧的决定。
详见 [SECURITY.md](SECURITY.md)。

## 做的时候踩到的几件事

- **不带原生依赖。** PTY 来自 harness 的 subprocess 接缝
  （`ctx.subprocess.spawnTerminal`），因此本包继承了它的凭据擦除和进程树拆除，
  自己不带任何编译扩展。`node-pty` 只是 devDependency，用来对着真 PTY 跑测试。
- **`TERM` 由面板自己声明，不继承。** harness 服务通常从非交互 shell 启动，
  于是环境里的 `TERM` 是 `dumb`；而编程 CLI 读到 `dumb`
  会正确地判断自己不在终端上，从而关掉颜色和光标定位 ——
  那恰恰是面板存在的意义所在。面板声明 `xterm-256color` / `truecolor`，
  这也确实就是浏览器那一端的真实情况。
- **`dist/client.js` 是提交进仓库的。** 安装这个包不该需要构建步骤。
  `npm test` 会先跑 `build-client --check`，
  所以过期的 bundle 会在 CI 上失败，而不是发到 npm 上去。

## 开发

```sh
pnpm install
pnpm test      # 27 个测试，跑在真 PTY、真 socket 和真围栏上
```

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

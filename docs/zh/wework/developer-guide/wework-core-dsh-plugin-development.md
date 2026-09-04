---
sidebar_position: 8
---

# 在隔离 Wework 实例中开发 Core DSH 插件

Wework 内置的“Wework 插件开发”是一个 Wework 插件。它可以携带一个符合 Codex
官方格式的内嵌 Codex 插件，并使用两个完整的 Electron 进程完成 Core DSH 插件开发：

- 主实例在 Wework 插件页提供创建入口，并在插件项目右侧提供“插件调试”Tab。
- 开发实例加载正在开发的插件，拥有独立的应用标识、用户数据目录、账号状态、
  Executor home、Core DSH home、插件 profile、缓存和日志。

两个实例不复制账号、Cookie、Token 或本地业务数据。插件需要云端数据时，开发者在
开发实例中单独登录。主实例退出时会停止开发实例及其 Core DSH、Executor 和插件子
进程。

## 启动开发实例

1. 打开内置的“Wework 插件开发”。Wework 插件是外层交付单元；其内嵌 Codex
   插件提供开发 Skill，并随外层插件默认注册。
2. 在 **插件 → 管理 → Wework 插件** 点击 **创建新插件**，选择一个空目录。
3. Wework 写入最小预制文件并把目录注册为本地项目。
4. 打开该项目的右侧工作区，从新增菜单选择 **插件调试**。
5. 点击 **启动调试实例**。就绪后 Wework 自动切换到第二个实例。

同一时间只运行一个 Core DSH 插件开发实例。切换源码目录时，Wework 会先停止旧
实例，再为新目录创建稳定但隔离的数据目录。

## HMR 与重启边界

开发实例通过 `link:` 将插件源码加入自己的 `wework-core` profile。Wework 在该
profile 的最后一层重新启用 DeepSeek Harness 官方 HMR，并且只监听选中的源码目录；
浏览器端继续使用 DSH Web 自带的 client-HMR。

普通 Node/浏览器实现文件变更优先走 HMR。以下变更应点击 **重启 Core DSH**：

- `package.json` 中的依赖、exports 或 DSH 元数据；
- `cordis.patch.yml` 中改变插件组成或服务依赖的配置；
- HMR 判断为框架级依赖变更并要求宿主进程退出；
- 插件进入错误状态且无法通过后续源码修改恢复。

不要把“文件 watcher 收到变化”等同于功能已经热更新。应在开发实例中验证实际行为，
并检查 Core DSH 日志。

项目识别由 Electron 在项目切换时执行一次，并缓存结果。Wework 只监听
`.wework/plugin-development.json`、`package.json` 和 bundle patch 的变化；React
渲染、会话消息和 Tab 切换都不会扫描硬盘。

## 插件调试 Tab

- **打开实例**：聚焦已经运行的第二个 Wework。
- **开发者工具**：打开开发实例主 WebView 的 Electron DevTools，检查浏览器端插件。
- **日志**：打开该实例独立的日志目录，排查 Electron、Core DSH 和插件服务端启动。
- **停止**：结束开发实例，但保留其独立登录态和本地数据。
- **删除隔离数据**：停止实例并删除账号状态、缓存、profile、Executor 数据和日志；
  不删除插件源码。

## 使用 Wework CLI 操作实例

Wework 会把通用 `wework` CLI 加入自身 Agent 的运行环境。该 CLI 可以操作主实例和
所有隔离实例；插件开发没有单独的自动化入口。Agent 在插件项目目录中使用
`--project .` 时，Wework 会自动选择为该项目注册的调试实例：

```bash
wework desktop instances
wework desktop status --project .
wework desktop inspect --project . --interactive true
wework desktop click --project . --selector '[data-testid="example-action"]'
wework desktop fill --project . --selector '[data-testid="example-input"]' --value 'value'
wework desktop press --project . --selector '[data-testid="example-input"]' --key Enter
wework desktop wait --project . --selector '[data-testid="example-result"]' --text 'ready'
wework desktop screenshot --project . --output test-results/plugin-debug.png
```

先使用 `inspect` 获取当前界面结构，再使用稳定的 `data-testid` 定位操作目标。每次
`click`、`fill` 或 `press` 后都应通过 `wait` 或再次 `inspect` 验证结果。多个实例
匹配时，先运行 `wework desktop instances`，再通过 `--instance` 明确指定目标。

CLI 只暴露结构化检查和用户级交互，不提供任意 JavaScript 执行。实例发现、回环地址
和认证信息由 Wework 管理，Skill 和插件源码不需要包含机器路径、端口或令牌。

## 包含关系

Wework 插件是外层交付单元，可以通过自身 `package.json` 的
`wework.codexPlugin` 声明一个内嵌 Codex 插件目录。内嵌目录必须保持 Codex 官方插件
格式，只包含 `.codex-plugin/plugin.json`、`skills/`、MCP 等 Codex 官方支持的内容，
不得写入 Wework 或 DSH 私有清单字段。

“Wework 插件开发”的外层包位于 `wework/dsh/plugin-developer`，内嵌 Codex 插件位于
`wework/dsh/plugin-developer/codex-plugin`。构建桌面资源时，Wework 使用内置插件资产
而不是 `CODEX_HOME`，将其投影到 Wework 自有市场路径
`<resourcesRoot>/bundled-plugins/wework-personal` 并默认注册；投影目录不是源码。
运行时认证另行从原生 Codex home 准备：Windows 复制 `auth.json`，其他平台创建链接。
创建入口和调试 Tab 由外层 Wework 插件直接注册，不依赖 Codex 插件是否安装。

新建项目采用相同结构：

```text
plugin-root/
├── package.json
├── cordis.patch.yml
├── client.js
└── codex-plugin/
    ├── .codex-plugin/plugin.json
    └── skills/
```

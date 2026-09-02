---
sidebar_position: 8
---

# 在隔离 Wework 实例中开发 Core DSH 插件

安装官方市场中的“Wework 插件开发”后，Wework 使用两个完整的 Electron
进程完成 Core DSH 插件开发：

- 主实例在 Wework 插件页提供创建入口，并在插件项目右侧提供“插件调试”Tab。
- 开发实例加载正在开发的插件，拥有独立的应用标识、用户数据目录、账号状态、
  Executor home、Core DSH home、插件 profile、缓存和日志。

两个实例不复制账号、Cookie、Token 或本地业务数据。插件需要云端数据时，开发者在
开发实例中单独登录。主实例退出时会停止开发实例及其 Core DSH、Executor 和插件子
进程。

## 启动开发实例

1. 安装“Wework 插件开发”。这个复合插件同时包含 Core DSH UI 扩展和 Codex
   Skill。
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

## 复合插件

“Wework 插件开发”的 Codex 插件位于
`wework/resources/bundled-plugins/wework-personal/plugins/wework-plugin-developer`。
它的 `.codex-plugin/plugin.json` 和 `skills/` 指导 Codex 开发 Core DSH UI 与
Skill。配套的内置 DSH 插件位于 `wework/dsh/plugin-developer`，注册创建入口和条件
调试 Tab，并且只在 Codex 插件安装后开放这些入口。个人内置市场将 Codex 插件标记为
可安装，而不是默认安装。

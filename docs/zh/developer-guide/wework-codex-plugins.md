---
sidebar_position: 33
---

# Codex 插件运行时

Wework 的插件能力兼容 Codex plugin、skill 和 app 机制。插件页负责发现、安装、创建和管理插件；对话运行时负责把用户选中的 skill/app 以结构化 mention 传给 Codex app-server，而不是把展示用文本当成普通 prompt。

## 页面入口

桌面左侧菜单中，插件入口固定在第三位：新对话、搜索、插件、云端工作。进入插件页后：

- 顶部展示插件市场、已安装插件和搜索入口。
- 右上角刷新按钮重新读取当前市场。
- 右上角创建入口进入 Codex plugin creator 风格的创建页。
- 管理入口进入已安装插件、skill 和 app 的启停与卸载视图。

插件市场不是本地模式和云端模式的二选一能力。Wework 默认展示 Codex app-server 返回的 OpenAI 官方市场，并允许用户添加多个命名市场；自定义市场可以来自 GitHub 仓库、远程地址或本地 `marketplace.json`/目录。没有可用市场时展示欢迎页，引导用户添加自定义市场或进入管理页。

Codex 插件运行配置位于“设置 → 集成 → 插件”，当前提供远端 Apps / Connectors 开关。设置区不再提供独立的工作树管理页，也不再提供将 Claude 和 Codex 技能目录迁移为共享软链接的操作面板；工作树生命周期由会话流程管理，技能与插件内容由插件页和 Codex app-server 管理。

## 市场和安装

市场数据由 Wework 前端通过本机 executor 的 Codex app-server 请求读取。列表请求不限制 `marketplaceKinds`，因此 Codex 可以按照当前功能开关和登录态同时返回本地市场与 `openai-curated-remote` 官方市场。远程 GitHub 自定义市场会被 clone 到本地缓存目录，后续列表读取使用缓存中的 marketplace 数据和插件目录。安装、卸载、刷新和自定义市场删除都走 Codex app-server 方法，Wework 不维护一套独立的插件安装状态。

前端只保存当前选中的市场。市场列表、插件是否已安装、skill/app 是否可用，以及插件详情中的内容列表，都以 Codex app-server 返回结果为准。OpenAI 官方市场由 Codex 管理，不出现在自定义市场的编辑、排序和删除列表中。

## 独立 Codex Home

Wework 使用独立的 Codex home，避免直接污染用户命令行 Codex 的配置目录。默认路径来自 executor home 下的 `codex` 子目录，也可以通过 `WEGENT_CODEX_HOME` 显式覆盖。

为了复用用户已有登录态，Wework Codex home 会软链用户 `~/.codex/auth.json`。如果目标位置存在失效软链，会先移除再重新创建；如果不是 Unix 系统，则复制 auth 文件。插件、市场缓存和 Wework 运行时配置继续存放在 Wework 自己的 Codex home 中。

首次启动时，如果 Wework Codex home 还没有初始化，而本机存在原生 `~/.codex`，应用启动阶段会显示迁移选择。用户可以选择：

- 创建新的 Wework Codex home，只复用 auth 链接。
- 从原生 Codex home 迁移配置到 Wework Codex home。
- 是否启用 Codex 远端 apps 拉取。这个开关只控制远端 app 初始化，不代表特定内置能力。

迁移完成后状态写入 Wework Codex home，插件页面和对话运行时都继续从同一个 Codex app-server 读取插件状态。设置页也暴露远端 apps 开关，便于用户后续修改自己的 Wework Codex 配置。

### 运行配置规范化

executor 在启动 Codex app-server 前会解析并规范化 Wework Codex home 下的 `config.toml`：缺少配置文件时自动创建，缺少 personality 时默认写入 `pragmatic`，并把旧版 `instructions` 迁移为 `developer_instructions`。`instructions` 在新版 Codex 中是模型基础指令的完整覆盖项，保留它会移除模型自带的 personality、commentary 和过程更新规则，因此 Wework 不再使用该字段保存用户自定义指令。

用户在“设置 → 上下文”中维护的自定义指令通过 Codex app-server 的 `config/read` 和 `config/batchWrite` 读写。写入时会与 Wework 内置浏览器路由指令合并，并使用 `reloadUserConfig` 热加载已存在的线程。启动规范化是幂等的，使用 TOML 解析和原子文件替换，并保留已有配置文件权限；Unix 上新建配置文件的权限为 `0600`。

交互风格也以同一份 `config.toml` 为唯一来源。设置页修改 Friendly 或 Pragmatic 时通过 `config/batchWrite` 更新 personality，不再把 personality 保存在 localStorage，也不再在每个 thread/turn 请求中重复覆盖。

## 模型列表

Wework 通过本机 executor 请求 Codex app-server 的 `model/list` 获取模型目录，并将返回的 provider 和模型数组顺序原样用于模型选择器。前端不会重排官方模型、默认模型或自定义 provider，也不会补充未由 Codex 返回的模型。请求使用 `includeHidden: false`，因此 Codex 标记为隐藏的模型不会显示。

## 对话运行时

用户在输入框中选择 skill、app 或插件时，编辑器插入结构化 badge，并在提交时序列化为 Codex app-server 支持的 mention 输入：

- skill 使用 `[$name](skill://path)`。
- app 使用 `[$name](app://connector_id)`。
- plugin 使用 `[$name](plugin://plugin_name@marketplace_name)`。

executor 在发送 `turn/input` 前解析这些 markdown mention，并构造成 Responses API 风格的 `input` text element。这样 Codex 可以识别真实的 skill/app/plugin，而不是只看到展示文本。

未被用户选择的插件不会自动注入普通对话。已安装插件只是让 Codex app-server 能发现其 skill/app；是否启用仍由 Codex app-server 的插件状态和用户在对话中的选择共同决定。

从插件详情或市场列表点击“在对话中试用”时，Wework 会按 Codex 协议写入单条 plugin mention，而不是同时写入 plugin 和 skill 两条 mention。试用内容会进入新对话草稿，相关模板会显示在输入框上方；用户发送后，消息气泡继续把 `plugin://` mention 渲染成 badge，避免把协议字符串作为普通文本展示。

## Backend 上传

Backend 提供已安装插件包的解析和上传辅助能力，用于读取 Codex 插件包中的 manifest、skill 和 app 元数据。解析逻辑只负责服务端存储和展示，不替代 Wework 本地 Codex app-server 的安装状态。

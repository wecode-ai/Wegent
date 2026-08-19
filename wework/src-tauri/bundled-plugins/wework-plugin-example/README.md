# Wework 插件示例 / Wework Plugin Example

这是可直接导入 Wework 的标准插件包，目录格式与
`wework-plugins/plugins/<plugin-slug>/` 一致。导入并安装后，应用列表和设置页会出现
“插件示例”，用于验证工作台插件的动态加载；Skill 与 MCP 组件也会同时安装。

This is a directly importable Wework plugin package. Its layout matches
`wework-plugins/plugins/<plugin-slug>/`. After import and installation,
“插件示例” appears in the application list and Settings to verify dynamic
Workbench loading. The Skill and MCP components are installed at the same time.

## 必需结构 / Required layout

- `.codex-plugin/plugin.json`: 插件名称、版本、说明和组件入口。
- `.wework-plugin/plugin.json`: 工作台运行时入口及其完整性校验。
- `workbench/frontend.js`: 注册应用、路由和设置页的前端模块。
- `skills/<slug>/SKILL.md`: 可选 Skill；每个 Skill 必须包含 YAML frontmatter。
- `.mcp.json`: 可选 MCP 配置；使用 `mcpServers` 对象。
- `mcp/`, `scripts/`, `assets/`: 可选运行文件和资源。

工作台模块导出带有 `activate(api)` 的对象，通过宿主提供的
`api.react.createElement` 渲染 React 节点，并通过 `api.routes`、`api.apps`、
`api.settings` 或 `api.slots` 注册功能。修改模块后必须同步更新
`.wework-plugin/plugin.json` 中的 SHA-256。

打包时请压缩本目录中的内容，确保 `.codex-plugin/plugin.json` 和
`.wework-plugin/plugin.json` 位于 ZIP 根目录，不要把整个目录作为 ZIP 中额外的一层。

The Workbench module exports an object with `activate(api)`, renders React nodes
with the host-provided `api.react.createElement`, and registers features through
`api.routes`, `api.apps`, `api.settings`, or `api.slots`. Whenever the module
changes, update the SHA-256 in
`.wework-plugin/plugin.json`.

When packaging, zip the contents of this directory so both manifests are
located at the ZIP root. Do not add another wrapper directory.

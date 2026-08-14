# Wework 插件示例 / Wework Plugin Example

这是可直接导入 Wework 的标准插件包，目录格式与 `wework-plugins/plugins/<plugin-slug>/` 一致。

This is a directly importable Wework plugin package. Its layout matches
`wework-plugins/plugins/<plugin-slug>/`.

## 必需结构 / Required layout

- `.codex-plugin/plugin.json`: 插件名称、版本、说明和组件入口。
- `skills/<slug>/SKILL.md`: 可选 Skill；每个 Skill 必须包含 YAML frontmatter。
- `.mcp.json`: 可选 MCP 配置；使用 `mcpServers` 对象。
- `mcp/`, `scripts/`, `assets/`: 可选运行文件和资源。

打包时请压缩本目录中的内容，确保 `.codex-plugin/plugin.json` 位于 ZIP 根目录，
不要把整个目录作为 ZIP 中额外的一层。

When packaging, zip the contents of this directory so `.codex-plugin/plugin.json`
is located at the ZIP root. Do not add another wrapper directory.

---
sidebar_position: 8
---

# 插件与 Skills

Skill 为 AI 提供特定任务的操作说明和资源；插件可以组合 Skills、命令、工具和应用入口。

## 使用插件

在顶部或应用入口打开 **插件**，可以浏览已安装插件、查看能力并进入管理页面。启用插件后，新任务可以使用插件提供的能力。

安装插件前，建议查看它包含的工具和权限，确认来源可信并符合当前工作区的数据要求。

### 使用内置应用插件

Wegent 云端市场会预先提供 `wegent-sites` 和 `weibo-miniapp-h5-develop-agent`，但不会提前安装到每个用户。打开 **应用** 后，可以在 **站点** 和 **小程序** 两个标签页中查看对应应用；点击 **创建** 并选择应用类型时，Wework 会先检查选定在线设备是否已经安装对应插件，已安装时会直接将插件引用写入新任务输入框。未安装时，Wework 会为当前账号幂等安装并同步插件到该设备。

内置应用插件属于 `visibility=workspace`，站点使用 `plugin://wegent-sites@wegent`，小程序使用 `plugin://weibo-miniapp-h5-develop-agent@wegent`，后者还会带入插件提供的创建提示。安装和同步期间，应用页会显示正在安装插件的提示；重复点击会复用当前设备上已安装的插件，不会创建重复安装记录或重复发起安装。

Wegent 市场发布和上传同时接受包含 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的插件包。Backend 会在入库前补齐缺少的运行时清单，因此每个已安装插件都会同步到设备的 Codex 和 Claude Code 插件目录。

本地模式需要先连接 Wegent 云端。点击输入框中的插件标签会打开相应的 Wegent 云端市场详情页。

### 在本地运行工具中使用插件

实验性的 OpenCode、Claude Code 和 Kimi Code 运行工具会读取当前任务选择的 Wework 插件。
Wework 优先使用 [Agent Plugins](https://agent-plugins.org/) 标准的 `plugin.json`、`skills/`
和 `mcp.json`，并兼容现有的 Codex/Claude 插件清单。启动会话时，Wework 为所选运行工具生成
隔离的适配目录，把 Skill 和 MCP Server 转换为该工具的原生配置；插件自己的持久数据保存在
按插件隔离的数据目录中，不会按每个会话重复复制。

每个本地运行工具会话还会自动获得 `wework_browser` MCP Server 和对应 Skill。AI 必须通过这些
受控工具打开、检查和操作 Wework 内置浏览器，不会启动外部浏览器。会话重启或恢复时会继续使用
创建会话时记录的插件集合，因此重启 Wework 不会丢失插件能力。

## 在任务中使用 Skill

在输入框中输入 `/`，从列表中选择 Skill；也可以直接在任务说明中点名需要使用的 Skill。选择后，Wework 会把相应说明提供给 AI。

## 管理本地 Skills

在 **设置 → 编码 → 技能** 中可以查看本地 Skills。需要同时使用 Codex 和 Claude Code 时，可以启用统一管理，将两者的技能目录统一到 `~/.agents/skills`。

重名 Skill 会保留并使用来源后缀区分。迁移完成后，新任务的自动补全会显示统一目录中的 Skills。

## 开发与迁移

如果你需要开发插件、把开源插件迁入 Wework 市场，或理解云端市场与本机 Codex 安装的关系，请阅读 [插件市场开发指南](./developer-guide/wework-plugin-marketplace-dev.md)。

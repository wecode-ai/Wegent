---
sidebar_position: 8
---

# 插件与 Skills

Skill 为 AI 提供特定任务的操作说明和资源；插件可以组合 Skills、命令、工具和应用入口。

## 使用插件

在顶部或应用入口打开 **插件**，可以浏览已安装插件、查看能力并进入管理页面。启用插件后，新任务可以使用插件提供的能力。

安装插件前，建议查看它包含的工具和权限，确认来源可信并符合当前工作区的数据要求。

### 使用内置应用插件

Wegent 云端市场会预先提供 `wegent-sites` 和 `wegent-mini-program`，但不会提前安装到每个用户。打开 **应用** 后，可以在 **站点** 和 **小程序** 两个标签页中查看对应应用；点击 **创建** 并选择应用类型时，Wework 会为当前账号幂等安装对应插件，将插件引用写入新任务输入框，并同步到选定的在线设备。站点使用 `wegent-sites`，小程序使用 `wegent-mini-program`，后者还会带入对应的创建提示。重复点击不会创建重复安装记录。

Wegent 市场发布和上传同时接受包含 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的插件包。Backend 会在入库前补齐缺少的运行时清单，因此每个已安装插件都会同步到设备的 Codex 和 Claude Code 插件目录。

本地模式需要先连接 Wegent 云端。点击输入框中的插件标签会打开相应的 Wegent 云端市场详情页。

## 在任务中使用 Skill

在输入框中输入 `/`，从列表中选择 Skill；也可以直接在任务说明中点名需要使用的 Skill。选择后，Wework 会把相应说明提供给 AI。

## 管理本地 Skills

在 **设置 → 编码 → 技能** 中可以查看本地 Skills。需要同时使用 Codex 和 Claude Code 时，可以启用统一管理，将两者的技能目录统一到 `~/.agents/skills`。

重名 Skill 会保留并使用来源后缀区分。迁移完成后，新任务的自动补全会显示统一目录中的 Skills。

## 开发与迁移

如果你需要开发插件、把开源插件迁入 Wework 市场，或理解云端市场与本机 Codex 安装的关系，请阅读 [插件市场开发指南](./developer-guide/wework-plugin-marketplace-dev.md)。

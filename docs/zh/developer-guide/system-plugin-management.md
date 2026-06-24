---
sidebar_position: 33
---

# 系统插件管理

系统插件管理用于让管理员维护一组面向所有用户展示的插件。每个逻辑插件需要分别维护 ClaudeCode 和 Codex 两个运行时 ZIP 包；用户在 Wework 中只看到一个整合插件，安装或更新时两个运行时版本会一起下发。

## 数据模型

系统插件复用现有 CRD 存储方式：

- 管理员维护的插件使用 `Kind.kind = "Plugin"`，`user_id = 0`，作为系统目录项。
- 同一个逻辑插件通过 `spec.source.pluginKey` 分组，`spec.runtime = "claudecode"` 或 `"codex"` 标识运行时版本。
- 用户安装后的插件仍使用 `Kind.kind = "InstalledPlugin"`，归属当前用户。
- ZIP 包二进制复用 `SkillBinary`，`type = "plugin"`。

系统目录项和用户安装项通过 `spec.source.systemPluginId` 关联。用户安装时复制系统插件的 manifest、组件清单和包引用，不直接共享用户可修改的运行状态。目录接口只展示同时存在且启用的 ClaudeCode 和 Codex 成对版本。

## 管理员能力

管理员入口位于主前端：

```text
系统管理 -> 插件管理
```

支持的操作：

- 上传 ZIP 创建或替换系统插件目录项，并选择运行时版本。
- 修改展示名称和描述。
- 启用或停用目录项。任一运行时版本停用后，用户目录不再展示该整合插件。
- 重新上传 ZIP 替换插件包版本。
- 删除系统插件目录项。

替换 ZIP 时要求新包中的插件名称和原插件一致，避免把用户已安装插件错误更新到另一个插件。

## 用户安装和更新

Wework 的插件管理页只展示系统插件目录，不再提供用户自行上传插件 ZIP 的入口。用户可以：

- 安装系统插件。一次安装会生成 ClaudeCode 和 Codex 两个 `InstalledPlugin`。
- 启用或停用自己已安装的插件。
- 当系统插件包被管理员替换后，看到可更新状态。
- 手动点击更新，将自己的两个安装项同步到系统插件的新包版本。

更新采用用户手动确认策略。管理员替换系统包不会自动修改用户安装项，只会让目录接口返回 `installState = "update_available"`。安装和更新接口返回 `items` 数组，包含两个运行时版本的安装结果。

## API

管理员接口：

```text
GET    /api/admin/plugins
POST   /api/admin/plugins
PUT    /api/admin/plugins/{system_plugin_id}
PUT    /api/admin/plugins/{system_plugin_id}/package
DELETE /api/admin/plugins/{system_plugin_id}
```

用户接口：

```text
GET  /api/plugins/catalog
POST /api/plugins/catalog/{system_plugin_id}/install
POST /api/plugins/catalog/{system_plugin_id}/update
```

用户安装或更新后会触发全局能力同步，将插件变更同步到在线设备。

## 前端职责

主前端 `frontend/` 负责管理员插件目录维护，Wework 负责用户消费系统插件目录。Wework 仍保留技能上传和自定义 MCP 创建能力，但 Claude Code 插件 ZIP 的用户上传入口已移除。

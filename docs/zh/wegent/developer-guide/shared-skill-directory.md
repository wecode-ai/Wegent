---
sidebar_position: 31
---

# 共享技能目录

Wework 提供“技能”设置页，用于把本地 Claude 和 Codex 的个人技能目录统一到 `~/.agents/skills`。该能力面向在线 Claude Code 本地设备，通过本地设备命令 RPC 执行，不在浏览器端直接访问文件系统。

## 目录结构

启用后，本地设备会形成以下结构：

```text
~/.agents/skills          # 共享技能目录
~/.codex/skills -> ~/.agents/skills
~/.claude/skills -> ~/.agents/skills
```

`~/.codex/skills` 和 `~/.claude/skills` 中已有的条目会先移动到 `~/.agents/skills`，再把两个旧路径改成指向共享目录的软链接。重复执行该操作是幂等的；如果两个旧路径已经指向共享目录，命令只返回已配置状态。

## 冲突处理

迁移时不会覆盖已有技能目录。如果 `~/.codex/skills` 和 `~/.claude/skills` 中存在同名条目，后迁移的条目会自动追加来源后缀，例如 `browser-claude`。命令返回结果会包含 `moved_count`、`moved[].renamed` 和最终路径，Wework 设置页会提示迁移数量和重名改名数量。

如果旧路径已经是指向其他位置的软链接，或路径存在但不是目录，命令会失败并返回错误，避免破坏用户已有的目录布局。

## Skill 扫描

`ls_skills` 会优先扫描 `~/.agents/skills`，并把这些技能标记为 `source=agents`。Wework 的本地 skill 自动补全会把 `agents` 来源视为 Claude 和 Codex 都兼容，避免共享目录启用后被当前模型类型误禁用。

插件技能仍从 `~/.claude/plugins/cache` 和 `~/.codex/plugins/cache` 扫描，不会被共享目录迁移。

## 入口和命令

前端入口：

- 桌面端：设置 -> 编码 -> 技能
- 移动端：设置 -> 技能

Backend 内置命令 key：

```text
setup_shared_skills
```

该命令由 `backend/app/services/device/command_registry.py` 注册，返回 JSON 对象。前端通过 `createDeviceApi().setupSharedSkills(deviceId)` 调用 `/devices/{device_id}/commands`。

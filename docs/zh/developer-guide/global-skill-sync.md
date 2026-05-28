---
sidebar_position: 19
---

# 全局 Skill 同步

全局 Skill 同步允许 Backend 将用户选择的 Skill 安装到在线 local executor 设备的 Claude Code 全局 Skill 目录，让 Project task 默认复用这些本机能力。

当前版本只同步 Skill。MCP 同步暂时禁用：请求体中只要包含非空 `mcp_ids`，Backend 会返回 `422`，executor 也会拒绝包含 `mcps` 的 WebSocket payload。

## API

请求：

```http
POST /api/local-executor/devices/{device_id}/capabilities/sync
```

请求体：

```json
{
  "skill_ids": [1336],
  "mode": "merge"
}
```

`device_id` 必须属于当前用户且在线。`skill_ids` 使用 `Kind.id`，资源必须满足：

- `kind == "Skill"`
- `is_active == true`
- `user_id` 等于当前用户，或 `user_id == 0` 的公共 Skill

成功响应示例：

```json
{
  "success": true,
  "device_id": "c675be0c-560e-4432-9076-6731ddc6341b",
  "mode": "merge",
  "skills": [
    {
      "id": 1336,
      "name": "browser",
      "status": "synced"
    }
  ],
  "errors": []
}
```

MCP 禁用响应示例：

```json
{
  "detail": "MCP capability sync is temporarily disabled"
}
```

## Backend 行为

Backend 负责设备归属、在线状态和 Skill 权限校验。通过校验后，Backend 将 Skill 解析为 executor 可下载的引用：

```json
{
  "id": 1336,
  "name": "browser",
  "namespace": "default",
  "is_public": false,
  "download_path": "/api/v1/kinds/skills/1336/download?namespace=default"
}
```

Backend 不向 frontend 暴露本地路径，也不接受任意安装目录。同步动作通过 `/local-executor` Socket.IO namespace 的 `device:sync_capabilities` 事件下发给目标设备。

## Executor 行为

local executor 收到 `device:sync_capabilities` 后会：

1. 校验 `mode`，只接受 `merge` 和 `replace`。
2. 拒绝包含 `mcps` 的 payload。
3. 使用现有 `SkillDownloader` 按 Skill ID 下载并安装 Skill。
4. 将 Skill 安装到 `~/.claude/skills/{skill_name}`。
5. 在 `~/.wegent-executor/capabilities.json` 记录 Wegent 管理的 Skill manifest。
6. 触发下一次 heartbeat 上报完整能力列表。

manifest 只记录 Wegent 管理的 Skill，不记录 MCP：

```json
{
  "version": 1,
  "revision": 2,
  "skills": {
    "browser": {
      "skill_id": 1336,
      "namespace": "default",
      "updated_at": "2026-05-27T02:29:17+00:00"
    }
  },
  "last_sync_at": "2026-05-27T02:29:17+00:00"
}
```

如果旧 manifest 中存在 `mcps` 字段，新代码在读写 manifest 时会丢弃该字段。

## Heartbeat

executor heartbeat 会带上脱敏后的全局 Skill 状态：

```json
{
  "capabilities": {
    "revision": 2,
    "digest": "sha256:c193c44afdbf51c8a1772e62b98915c8b9ffa68b266a641bc505868370495edb",
    "full": true,
    "skills": [
      {
        "name": "browser",
        "skill_id": 1336,
        "namespace": "default",
        "source": "wegent"
      }
    ],
    "last_sync_at": "2026-05-27T02:29:17+00:00"
  }
}
```

Backend 将最新状态保存到 Redis。非 full heartbeat 只刷新 revision 和 digest，不覆盖已有完整列表。Heartbeat 不再上报 `mcps`。

## Project Task 运行时

Project task 会启用全局 Skill 目录：

```text
SKILLS_DIR=~/.claude/skills
```

local executor 仍会设置任务级 `CLAUDE_CONFIG_DIR` 来隔离 Claude Code 的非敏感配置。由于 Claude Code 会从当前 `CLAUDE_CONFIG_DIR/skills` 扫描 Skill，Project task 启动时会额外将任务目录下的 `.claude/skills` 链接到 `~/.claude/skills`：

```text
{task_config_dir}/skills -> ~/.claude/skills
```

这样 Claude Code 可以按自身发现规则看到全局 Skill，同时不会把敏感模型配置写入全局 Claude Code 配置。

非 Project task 继续使用任务级 `.claude/skills`，保持隔离。

当前版本不会从 Claude Code 全局配置读取 MCP，也不会把全局 MCP 合并到 Project task 的 `mcp_servers`。任务级 Bot、Ghost 或 Skill 动态提供的 MCP 仍按原有任务链路生效。

## 验证

MCP 禁用验证：

```bash
curl -i -X POST "http://localhost:8000/api/local-executor/devices/${DEVICE_ID}/capabilities/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_ids": [],
    "mcp_ids": ["dingtalk/docs"],
    "mode": "merge"
  }'
```

预期返回 `422`。

Skill 同步验证：

```bash
curl -i -X POST "http://localhost:8000/api/local-executor/devices/${DEVICE_ID}/capabilities/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_ids": [1336],
    "mode": "merge"
  }'
```

预期返回 `200`，并在设备内看到 `~/.claude/skills/browser/SKILL.md`。

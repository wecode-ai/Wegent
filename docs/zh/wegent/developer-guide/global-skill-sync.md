---
sidebar_position: 19
---

# 全局能力同步

全局能力同步允许 Backend 将用户启用的 Skill、Plugin 和 MCP 下发到在线 local executor 设备。Project task 可以复用这些本机能力，非 Project task 继续使用任务级 `.claude` 配置目录，保持隔离。

当前版本支持 InstalledSkill、InstalledPlugin 和 InstalledMCP。旧的 server-key `mcp_ids` 同步入口仍禁用，Backend 会返回 `422`；新调用应使用 InstalledMCP ID。

## API

请求：

```http
POST /api/local-executor/devices/{device_id}/capabilities/sync
```

请求体：

```json
{
  "installed_skill_ids": [1336],
  "installed_plugin_ids": [9],
  "installed_mcp_ids": [7],
  "mode": "merge"
}
```

`device_id` 必须属于当前用户且在线。ID 使用已安装资源的 `Kind.id`，资源必须满足：

- `kind` 为 `InstalledSkill`、`InstalledPlugin` 或 `InstalledMCP`
- `is_active == true`
- `user_id` 等于当前用户
- `spec.installState == "installed"`
- `spec.enabled != false`

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
  "plugins": [
    {
      "id": 9,
      "name": "context7",
      "status": "synced"
    }
  ],
  "mcps": [
    {
      "id": 7,
      "name": "docs",
      "status": "synced"
    }
  ],
  "errors": []
}
```

旧 `mcp_ids` 禁用响应示例：

```json
{
  "detail": "MCP capability sync is temporarily disabled for server-key IDs; use InstalledMCP IDs"
}
```

## Backend 行为

Backend 负责设备归属、在线状态和能力权限校验。通过校验后，Backend 将能力解析为 executor 可消费的 payload：

```json
{
  "mode": "replace",
  "skills": [
    {
      "installed_skill_id": 1336,
      "skill_id": 101,
      "name": "browser",
      "namespace": "default",
      "is_public": false,
      "download_path": "/api/v1/kinds/skills/101/download?namespace=default"
    }
  ],
  "plugins": [
    {
      "installed_plugin_id": 9,
      "name": "context7",
      "marketplace": "claude-plugins-official",
      "version": "1057d02c5307",
      "download_path": "/api/plugins/installed/9/download"
    }
  ],
  "mcps": [
    {
      "installed_mcp_id": 7,
      "name": "docs",
      "server": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/docs"
      }
    }
  ]
}
```

Backend 不向 frontend 暴露本地路径，也不接受任意安装目录。同步动作通过 `/local-executor` Socket.IO namespace 的 `device:sync_capabilities` 事件下发给目标设备。

## Executor 行为

local executor 收到 `device:sync_capabilities` 后会：

1. 校验 `mode`，只接受 `merge` 和 `replace`。
2. 将下载的 Skill 和 Plugin 包统一存入 `~/.wegent-executor/capabilities/store/`。
3. 在 `~/.claude` 和预留的 `~/.codex` 运行目录中，为每个 Skill 或 Plugin 创建单项软链。
4. 在 `~/.wegent-executor/capabilities/manifest.json` 记录 Wegent 管理的 Skill、Plugin 和 MCP manifest。
5. 触发下一次 heartbeat 上报完整能力列表。

中心 store 结构：

```text
~/.wegent-executor/
  capabilities/
    store/
      skills/
        {skill_id}-{namespace}-{name}/
      plugins/
        {installed_plugin_id}-{marketplace}-{name}-{version}/
    manifest.json
```

运行目录结构：

```text
~/.claude/
  skills/
    {skill_name} -> ~/.wegent-executor/capabilities/store/skills/{skill_id}-{namespace}-{name}
  plugins/
    installed_plugins.json
    cache/{marketplace}/{name}/{version} -> ~/.wegent-executor/capabilities/store/plugins/{installed_plugin_id}-{marketplace}-{name}-{version}

~/.codex/
  skills/
    {skill_name} -> ~/.wegent-executor/capabilities/store/skills/{skill_id}-{namespace}-{name}
  plugins/
    {plugin_key} -> ~/.wegent-executor/capabilities/store/plugins/{installed_plugin_id}-{marketplace}-{name}-{version}
```

运行目录中的名称必须保持原始 Skill name 或 Plugin key，不添加 `wegent-` 前缀。这样可以避免目录名与 `SKILL.md` 中的 `name` 不一致。

manifest 记录 Wegent 管理的能力：

```json
{
  "version": 1,
  "revision": 2,
  "skills": {
    "browser": {
      "skill_id": 1336,
      "namespace": "default",
      "managed": true,
      "store_path": "~/.wegent-executor/capabilities/store/skills/1336-default-browser",
      "runtime": {
        "claude_link": "~/.claude/skills/browser",
        "codex_link": "~/.codex/skills/browser"
      },
      "updated_at": "2026-05-27T02:29:17+00:00"
    }
  },
  "plugins": {
    "context7@claude-plugins-official": {
      "installed_plugin_id": 9,
      "name": "context7",
      "marketplace": "claude-plugins-official",
      "version": "1057d02c5307",
      "managed": true,
      "store_path": "~/.wegent-executor/capabilities/store/plugins/9-claude-plugins-official-context7-1057d02c5307",
      "runtime": {
        "claude_link": "~/.claude/plugins/cache/claude-plugins-official/context7/1057d02c5307",
        "codex_link": "~/.codex/plugins/context7-claude-plugins-official"
      }
    }
  },
  "mcps": {
    "docs": {
      "installed_mcp_id": 7,
      "server": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/docs"
      },
      "managed": true
    }
  },
  "last_sync_at": "2026-05-27T02:29:17+00:00"
}
```

`replace` 模式只会清理 manifest 中标记为 Wegent managed 的运行入口。本地用户自己放在 `~/.claude/skills` 或 plugin cache 中的条目会保留。如果同名本地 Skill 已占用运行路径，executor 会返回冲突错误而不会覆盖用户内容。

## Heartbeat

executor heartbeat 会带上脱敏后的全局能力状态：

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
    "plugins": [
      {
        "name": "context7",
        "marketplace": "claude-plugins-official",
        "version": "1057d02c5307",
        "source": "wegent"
      }
    ],
    "mcps": [
      {
        "name": "docs",
        "installed_mcp_id": 7,
        "server": {
          "type": "streamable-http",
          "url": "https://mcp.example.com/docs"
        },
        "source": "wegent"
      }
    ],
    "last_sync_at": "2026-05-27T02:29:17+00:00"
  }
}
```

Backend 将最新状态保存到 Redis。非 full heartbeat 只刷新 revision 和 digest，不覆盖已有完整列表。

## Project Task 运行时

Project task 会启用全局 Claude 配置目录和全局 Skill 目录：

```text
CLAUDE_CONFIG_DIR=~/.claude
SKILLS_DIR=~/.claude/skills
```

Project task 不再在项目或任务目录下创建 `.claude/skills`、`.claude/plugins` 的整目录软链。能力由全局 `.claude` 目录中的逐项软链暴露给 Claude Code。

非 Project task 继续使用任务级 `CLAUDE_CONFIG_DIR={workspace_root}/{task_id}/.claude` 和 `{config_dir}/skills`，保持隔离，不自动消费全局能力目录。

Project task 运行时会消费同步 manifest 中的全局 MCP：

- Claude Code：从 `~/.wegent-executor/capabilities/manifest.json` 读取 `mcps`，合并到本次 SDK options 的 `mcp_servers`。`streamable-http` 会在传给 Claude SDK 前转换为 `http`。
- Codex：从同一个 manifest 读取 `mcps`，转换为 Codex CLI 的 `-c mcp_servers.{name}.*=...` 动态配置覆盖项，注入本次 Codex app-server 启动参数。executor 不直接覆盖用户的 `~/.codex/config.toml`。

Codex 当前支持 URL 型 MCP（`url` 或 `base_url`）和 stdio 型 MCP（`command`、`args`、`env`）。如果记录中存在 `bearer_token_env_var`、`oauth_client_id` 或 `oauth_resource`，也会转换为对应的 Codex MCP 配置字段。

## 验证

旧 `mcp_ids` 禁用验证：

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

Installed capability 同步验证：

```bash
curl -i -X POST "http://localhost:8000/api/local-executor/devices/${DEVICE_ID}/capabilities/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "installed_skill_ids": [1336],
    "installed_plugin_ids": [9],
    "installed_mcp_ids": [7],
    "mode": "merge"
  }'
```

预期返回 `200`，并在设备内看到：

```text
~/.wegent-executor/capabilities/store/skills/...
~/.claude/skills/browser -> ~/.wegent-executor/capabilities/store/skills/...
~/.codex/skills/browser -> ~/.wegent-executor/capabilities/store/skills/...
```

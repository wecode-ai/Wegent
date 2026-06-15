---
sidebar_position: 19
---

# Global Capability Sync

Global capability sync lets Backend deliver user-enabled Skills, Plugins, and MCP servers to online local executor devices. Project tasks can reuse these local capabilities, while non-Project tasks continue to use task-scoped `.claude` config directories for isolation.

The current version supports InstalledSkill, InstalledPlugin, and InstalledMCP. The old server-key `mcp_ids` entrypoint remains disabled and Backend returns `422`; new callers should use InstalledMCP IDs.

## API

Request:

```http
POST /api/local-executor/devices/{device_id}/capabilities/sync
```

Body:

```json
{
  "installed_skill_ids": [1336],
  "installed_plugin_ids": [9],
  "installed_mcp_ids": [7],
  "mode": "merge"
}
```

`device_id` must belong to the current user and be online. IDs are `Kind.id` values for installed resources, and each resource must satisfy:

- `kind` is `InstalledSkill`, `InstalledPlugin`, or `InstalledMCP`
- `is_active == true`
- `user_id` equals the current user
- `spec.installState == "installed"`
- `spec.enabled != false`

Successful response example:

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

Old `mcp_ids` disabled response example:

```json
{
  "detail": "MCP capability sync is temporarily disabled for server-key IDs; use InstalledMCP IDs"
}
```

## Backend Behavior

Backend validates device ownership, online state, and capability authorization. After validation, Backend resolves capabilities into an executor payload:

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

Backend does not expose local paths to the frontend and does not accept arbitrary installation directories. The sync action is delivered to the target device through the `device:sync_capabilities` event in the `/local-executor` Socket.IO namespace.

## Executor Behavior

When the local executor receives `device:sync_capabilities`, it:

1. Validates `mode`; only `merge` and `replace` are accepted.
2. Stores downloaded Skill and Plugin packages under `~/.wegent-executor/capabilities/store/`.
3. Creates per-item symlinks in `~/.claude` and the reserved `~/.codex` runtime directories.
4. Records Wegent-managed Skills, Plugins, and MCP servers in `~/.wegent-executor/capabilities/manifest.json`.
5. Forces the next heartbeat to include the full capability list.

Central store layout:

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

Runtime directory layout:

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

Runtime names must keep the original Skill name or Plugin key. Do not add a `wegent-` prefix, because a runtime directory name that diverges from `SKILL.md` metadata can affect discovery.

The manifest records Wegent-managed capabilities:

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

`replace` mode only removes runtime entries marked as Wegent managed in the manifest. User-created local Skills or plugin cache entries under `~/.claude` are preserved. If a local Skill already occupies the same runtime path, the executor reports a conflict and does not overwrite user content.

## Heartbeat

Executor heartbeat reports sanitized global capability state:

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

Backend stores the latest state in Redis. Non-full heartbeats refresh only revision and digest and do not overwrite the previous full list.

## Project Task Runtime

Project tasks enable the global Claude config and Skill directories:

```text
CLAUDE_CONFIG_DIR=~/.claude
SKILLS_DIR=~/.claude/skills
```

Project tasks no longer create whole-directory `.claude/skills` or `.claude/plugins` symlinks under the project or task directory. Capabilities are exposed to Claude Code through per-item symlinks in the global `.claude` directory.

Non-Project tasks continue to use `CLAUDE_CONFIG_DIR={workspace_root}/{task_id}/.claude` and `{config_dir}/skills` to preserve isolation and do not automatically consume global capability directories.

Project task runtime consumes global MCP entries from the sync manifest:

- Claude Code reads `mcps` from `~/.wegent-executor/capabilities/manifest.json` and merges them into the current SDK options as `mcp_servers`. `streamable-http` is converted to `http` before being passed to the Claude SDK.
- Codex reads `mcps` from the same manifest and converts them to Codex CLI dynamic config overrides such as `-c mcp_servers.{name}.*=...` for the current Codex app-server launch. The executor does not overwrite the user's `~/.codex/config.toml`.

Codex currently supports URL-based MCP servers (`url` or `base_url`) and stdio MCP servers (`command`, `args`, `env`). If a record includes `bearer_token_env_var`, `oauth_client_id`, or `oauth_resource`, the executor converts it to the corresponding Codex MCP config field.

## Verification

Verify old `mcp_ids` are disabled:

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

Expected response: `422`.

Verify installed capability sync:

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

Expected response: `200`, and the device should contain:

```text
~/.wegent-executor/capabilities/store/skills/...
~/.claude/skills/browser -> ~/.wegent-executor/capabilities/store/skills/...
~/.codex/skills/browser -> ~/.wegent-executor/capabilities/store/skills/...
```

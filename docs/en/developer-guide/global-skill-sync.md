---
sidebar_position: 19
---

# Global Skill Sync

Global Skill sync lets Backend install user-selected Skills into an online local executor device's Claude Code global Skill directory, so Project tasks can reuse those local capabilities by default.

The current version syncs Skills only. MCP sync is temporarily disabled: Backend returns `422` when the request body contains non-empty `mcp_ids`, and the executor rejects WebSocket payloads that contain `mcps`.

## API

Request:

```http
POST /api/local-executor/devices/{device_id}/capabilities/sync
```

Body:

```json
{
  "skill_ids": [1336],
  "mode": "merge"
}
```

`device_id` must belong to the current user and be online. `skill_ids` are `Kind.id` values, and each resource must satisfy:

- `kind == "Skill"`
- `is_active == true`
- `user_id` equals the current user, or `user_id == 0` for public Skills

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
  "errors": []
}
```

MCP-disabled response example:

```json
{
  "detail": "MCP capability sync is temporarily disabled"
}
```

## Backend Behavior

Backend validates device ownership, online state, and Skill authorization. After validation, Backend resolves each Skill into an executor download reference:

```json
{
  "id": 1336,
  "name": "browser",
  "namespace": "default",
  "is_public": false,
  "download_path": "/api/v1/kinds/skills/1336/download?namespace=default"
}
```

Backend does not expose local paths to the frontend and does not accept arbitrary installation directories. The sync action is delivered to the target device through the `device:sync_capabilities` event in the `/local-executor` Socket.IO namespace.

## Executor Behavior

When the local executor receives `device:sync_capabilities`, it:

1. Validates `mode`; only `merge` and `replace` are accepted.
2. Rejects payloads containing `mcps`.
3. Uses the existing `SkillDownloader` to download and install Skills by Skill ID.
4. Installs Skills into `~/.claude/skills/{skill_name}`.
5. Records Wegent-managed Skills in `~/.wegent-executor/capabilities.json`.
6. Forces the next heartbeat to include the full capability list.

The manifest records only Wegent-managed Skills and does not record MCP entries:

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

If an older manifest contains an `mcps` field, the new code drops that field when reading or writing the manifest.

## Heartbeat

Executor heartbeat reports sanitized global Skill state:

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

Backend stores the latest state in Redis. Non-full heartbeats refresh only revision and digest and do not overwrite the previous full list. Heartbeats no longer report `mcps`.

## Project Task Runtime

Project tasks enable the global Skill directory:

```text
SKILLS_DIR=~/.claude/skills
```

The local executor still sets a task-scoped `CLAUDE_CONFIG_DIR` to isolate Claude Code's non-sensitive configuration. Because Claude Code scans Skills from the active `CLAUDE_CONFIG_DIR/skills`, Project task startup also links the task `.claude/skills` directory to `~/.claude/skills`:

```text
{task_config_dir}/skills -> ~/.claude/skills
```

This lets Claude Code discover global Skills through its native lookup path without writing sensitive model configuration into global Claude Code config.

Non-Project tasks continue to use task-scoped `.claude/skills` directories to preserve isolation.

The current version does not read Claude Code global MCP configuration and does not merge global MCP entries into Project task `mcp_servers`. Task-level MCP supplied by the current Bot, Ghost, or Skill still follows the existing task-level flow.

## Verification

Verify MCP is disabled:

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

Verify Skill sync:

```bash
curl -i -X POST "http://localhost:8000/api/local-executor/devices/${DEVICE_ID}/capabilities/sync" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "skill_ids": [1336],
    "mode": "merge"
  }'
```

Expected response: `200`, and `~/.claude/skills/browser/SKILL.md` should exist on the device.

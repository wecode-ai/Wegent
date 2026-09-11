---
sidebar_position: 14
---

# TaskToken for plugin remote MCP servers

Plugins can identify the current Wework user and task using the existing Wegent TaskToken. Declare `"Authorization": "Bearer ${{task_token}}"` in the remote server's `headers`, inside the plugin's `mcpServers` configuration or `.mcp.json`. Users do not copy their login credentials.

Local and remote executors request tokens over their authenticated, registered native device connection. User and device identity come from that connection and cannot be overridden by plugin request fields. Issuance reuses the existing TaskToken signing, verification and 24-hour expiry.

## Business authorization

Forward the received token only over HTTPS to the issuing backend's `GET /api/external/mcp-identity/userinfo` using the same Bearer header. Reject an HTTP issuing-backend URL before adding the credential. The existing `id`, `user_name` and `email` fields are preserved. The response additionally contains:

```json
{
  "task": {
    "kind": "runtime",
    "id": "runtime-example-task",
    "device_id": "app-record-123"
  }
}
```

Authorize using the full tuple `(id, task.kind, task.device_id, task.id)`. Never trust an unverified decoded JWT or a local task ID alone. Continuing a task, restarting its executor, or renewing its token preserves the identity on the same device. New and forked tasks have different identities. Moving to another device produces a different device-local task address.

Existing Wegent CRD tasks return `task.kind = "wegent"` with a string task ID. Legacy runtime tokens with no concrete task binding return `task = null`; services requiring task permissions must reject them. Business MCP servers own their resource authorization rules; identity verification does not grant access by itself.

## Runtime behavior

Only plugin remote MCP servers declaring the placeholder use this capability. Real tokens stay in executor memory and are added to outbound requests, with renewal before expiry. Native runtimes use a task-specific loopback route; Claude gets a temporary configuration and Codex refreshes the thread configuration on continuation. The route closes when execution finishes.

Materialized native plugin manifests and Claude's auto-loaded `.mcp.json` omit executor-managed servers to avoid duplicate loading. The cache retains the original placeholder declarations; source plugin packages stay unchanged. This requires copied native caches and does not modify symlinks to plugin sources. Other components continue loading normally. Tokens are not stored in plugin sources, shared capability manifests or logs. Missing authentication, rejected issuance and replaced connections fail explicitly without using login credentials. Credential-bearing MCP upstreams require HTTPS, except for loopback development endpoints. Credential-bearing redirects are not followed.

Deploy the backend before the executor/desktop. No database migration is required. The existing desktop runner's `plugin-task-token` checkpoint covers both runtimes, local and remote execution, stable continuation identity and task-specific business denial.

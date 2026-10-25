---
sidebar_position: 61
---

# Wework stand-in connection plugins

Connections are capabilities of outer Wework Core DSH plugins. The Codex plugin protocol remains unchanged. A connection plugin can depend on an existing Codex plugin or implement its own external access. Collection, pagination and normalization use deterministic code; models handle work interpretation, ownership and execution.

## Manifest and registration

Declare `wework.connections` in the outer `package.json`, with `apiVersion: 1`, `dependencies` and `providers`. Do not add Wework fields to `.codex-plugin/plugin.json`. Existing `wework.codexPlugin` declarations continue to identify nested Codex packages; reference their actual installed marketplace identity when declaring a connection dependency.

```json
{
  "name": "@example/wework-mail",
  "wework": {
    "connections": {
      "apiVersion": 1,
      "dependencies": {
        "mail": {
          "kind": "codexPlugin",
          "source": { "marketplaceId": "company", "pluginId": "mail@company" },
          "version": "^1.0.0"
        }
      },
      "providers": [
        {
          "id": "inbox",
          "displayName": "Email",
          "uses": ["mail"],
          "collectionModes": ["poll"],
          "resourceKinds": ["folder"],
          "resourceLabels": { "folder": "Mail folder" },
          "eventTypes": ["mail.received"]
        }
      ]
    }
  }
}
```

Inject `weworkConnections` in the DSH Node entry and register implementations:

```js
export const inject = ["weworkConnections"];
export async function apply(ctx) {
  await ctx.weworkConnections.register(
    ctx,
    new URL("./package.json", import.meta.url),
    { inbox: mailProvider },
  );
}
```

The manifest supplies metadata; implementations follow their Cordis owner's lifetime. Installed disabled plugins are discovered from manifests without executing their entrypoints. Full provider identity is `package-name/provider-id`. Invalid declarations, duplicate identities and unsupported protocol versions fail explicitly. This release supports polling and does not execute arbitrary commands from manifests.

## Provider contract

| Method                          | Behavior                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `check(context)`                | Returns `ready`, `auth_required` or `error` without starting login.                   |
| `listResources(context, query)` | Accepts `kind`, `query`, optional `cursor`; returns `items`, `hasMore`, `nextCursor`. |
| `validate(context, source)`     | Validates resource identity, kind and account availability before collection.         |
| `initialize(context, source)`   | Establishes the initial checkpoint without replaying all history.                     |
| `collect(context, input)`       | Accepts `source` and `checkpoint`; returns `events`, `nextCheckpoint`, `hasMore`.     |

Resources contain `providerId`, `id`, `profile`, `kind` and `name`. Executor owns handling policy and the `enabledAfter` cutoff. Checkpoints are opaque JSON objects, separate from host metadata. Events require stable `id`, `text` and `at`; use RFC 3339 timestamps. Event types must follow the provider declaration. Optional message fields include sender, quoted-message and topic identifiers.

Providers must handle pagination, duplicate events and invalid checkpoints explicitly. Context exposes resolved dependencies and a lifecycle abort signal. Implementations can capture their declared DSH services. Disabling the plugin rejects in-flight collection results.

## Dependencies and accounts

Match both marketplace identity and full Codex plugin ID. Never substitute a same-named package from another marketplace. Normal reads use `plugin/installed`; explicit dependency installation reads the full catalog and calls existing `plugin/install` APIs.

Dependency states are `ready`, `missing`, `disabled` and `incompatible`. `*` accepts any installed version, including missing version metadata; other ranges require a verifiable version. Providers still validate actual capabilities.

Installation is explicit through the connection UI. Shared dependencies are not automatically enabled, upgraded or removed. Unknown sources, incompatible available versions and administrator restrictions fail explicitly. Active dependency references are reported to Executor; normal Codex uninstall and local personal-plugin uninstall reject dependencies used by an active connection. Disable the Wework connection plugin first; references refresh on the heartbeat interval.

Accounts remain owned by existing authorization services. Optional `authTarget` references the original `pluginKey` and `connectorSlug`; subscription configuration never contains credentials.

## Reusing existing Codex plugin capabilities

Provider contexts expose `context.mcp.listTools(dependencyAlias)` and `context.mcp.callTool(dependencyAlias, { server, tool, arguments })`. The alias must belong to this provider's `uses`. SDK requests carry the dependency alias together with the exact plugin identity; Executor selects read declarations by provider, alias and source, so aliases of the same plugin cannot share the wrong grant. Tool names are raw MCP identities, with deterministic argument mapping, pagination and event normalization supplied by the Wework adapter. Existing Codex plugins do not need new manifests, interfaces or authentication implementations. Skills without MCP tools do not become callable tools automatically.

```js
const result = await context.mcp.callTool("mail", {
  server: "mail",
  tool: "search_messages",
  arguments: { folder: source.id, after: checkpoint.after },
});
// Interpret the existing plugin's result contract before advancing the checkpoint.
if (result.isError) throw new Error("Mail collection failed");
```

These names and arguments are illustrative; use the actual dependency's tool contract. Calls follow Provider → SDK → `runtime.connections.mcp` → Codex app-server → existing MCP server. The host checks `plugin/installed` and `plugin/read` for exact marketplace/plugin identity, enabled status and resolved version, then rechecks the dependency immediately before calling the tool. Each operation creates an isolated ephemeral technical thread in the device's managed Codex Home with a read-only sandbox and `approvalPolicy: never`. Only MCP discovery and direct tool calls run; no `turn/start`, model inference, model tokens, user Task or project-document loading is involved.

Ownership follows the server's Codex `pluginId`. For shared `codex_apps`, the tool's `_meta.connector_id` must match an app ID from the exact dependency's `plugin/read` response. Names alone never establish ownership. By default, background calls require `readOnlyHint: true` and no destructive annotation. A Wework provider can declare a precise read contract for existing tools that lack annotations:

```json
{
  "mcpReadTools": {
    "mail": [{ "server": "mail", "tool": "search_messages" }]
  }
}
```

This field belongs to the provider descriptor. It is implemented by the adapter author, with no original-plugin changes or AI/user configuration. Explicit `readOnlyHint: false` and `destructiveHint: true` still deny execution. Executor reads the declaration from the active host registration and overwrites caller-supplied `readTools`. Undeclared dependencies, foreign tools, ambiguous identities and unknown operations fail closed.

The original `content`, `structuredContent`, `isError` and `_meta` are preserved. Providers must interpret error results before advancing checkpoints. Structured local login failures retain their original identity; never guess accounts or convert remote authorization into local Connector login. Native MCP elicitations are cancelled in background threads and return `connection_interaction_required`; the user must finish authorization through the plugin's existing interactive entry. Network failures do not imply expired authentication.

After thread creation, discovery and invocation share a 45-second deadline. Success, failure and timeout all unsubscribe the thread so Codex can unload it. An IPC caller's cancellation does not abandon cleanup. Disposed providers cannot start new calls or accept in-flight results. The bridge never retries a tool call with an unknown outcome, starts interactive login, changes shared plugin configuration, or exports credentials. Existing checkpoint retention and scheduler backoff remain in force. DingTalk uses the generic CLI transport described below to invoke its existing declared DWS tool; it does not use an MCP technical thread.

### Existing CLI plugins without MCP servers

The current DingTalk plugin declares Skills and `connectors[].localAuth.tool`, without MCP tools. The shared bridge therefore also provides `context.cli.callTool(dependencyAlias, { tool, arguments })`. MCP and CLI share dependency identity, version checks and provider lifecycle boundaries. Neither transport invokes a model, interprets Skills as executable commands or pretends that the original plugin exposes nonexistent MCP tools.

A provider's `cliReadTools` maps dependency aliases to Connector slugs, fixed output arguments, and named read operations. Each operation declares a fixed `command` prefix and a `parameters` map from argument names to flags. For example, `searchGroups` uses command `["chat", "search"]`, parameters `{ "query": "--query", "profile": "--profile", "cursor": "--cursor" }`, and fixed output arguments `["--format", "json"]`. The adapter calls `context.cli.callTool('dingtalk', { tool: 'searchGroups', arguments: { query, profile } })`. These are deterministic Wework adapter declarations; the original Codex plugin requires no changes.

Executor obtains the read declaration from the active host rather than caller input. Unknown operations, extra arguments, option-like values and NUL values are rejected. The shared resolver selects the exact installed plugin version, rejects cross-market substitutions and path traversal, and executes only its existing `localAuth.tool` binary. It never starts a shell, executes Skill prose, or downloads a tool in the background. Existing account authorization and broker environment remain in charge of credentials. CLI processes have a 40-second deadline and an 8 MiB stdout limit. Oversized output fails immediately without waiting for process exit, and the child is cleaned up. Only explicit authentication error codes return `connector_auth_required` with the original plugin and Connector identity; network failures do not imply login failure.

DingTalk declares five reads: `listProfiles`, `searchGroups`, `searchUsers`, `listMentions`, and `searchMessages`. The app-specific `runtime.connections.command`, `context.readCommand`, DingTalk read-command allowlist and cache-root resolver have been removed, with no fallback. Replies retain their existing source-bound confirmation path.

## Collection and delivery

Executor owns the single background collection scheduler. Providers run in the Wework DSH host and are called over a fixed loopback route protected by a private random Bearer token. Endpoint registration rejects remote addresses and redirects, expires without heartbeats, and stays in memory.

Collection requires the connection runtime on the bound device. If it is unavailable, preserve progress and report the condition; do not fall back to the removed DingTalk collector or transfer collection silently.

Sources are shared by user, provider, account and resource. Settings versions are checked after collection. Events are persisted before advancing the page checkpoint; interrupted pages replay and deduplicate. External calls and database writes are not a distributed exactly-once transaction.

Existing ownership, organization, execution queues and approval flows remain authoritative. New work uses `connection_work`; historical `dingtalk_work` retains the same external-source restrictions and confirmation rules. Provider identity also separates deduplication and memory scopes. Temporary failures retain progress and retry with backoff without opening login automatically.

## DingTalk migration

`@wegent/dsh-connection-dingtalk` implements selected group mentions and contact messages. Search, time windows, pagination, normalization and automated-self-message filtering move into that plugin. Executor retains managed credentials and the existing source-bound reply path.

Legacy `dingtalk[]` settings migrate transactionally to `connections[]`, adding the provider identity while retaining versions, policies and enable times. Saves and configuration proposals normalize through the same path. Conflicting formats are rejected.

Historical work and message IDs are not rewritten. DingTalk retains its original deduplication namespace. Existing `after/until/cursor` state becomes the generic checkpoint on the first collection. Replies retain role, work, source-message and current-confirmation checks; other providers cannot invoke DingTalk replies.

The built-in manifest explicitly depends on `dingtalk@wegent`. Copies in other marketplaces are not silently treated as equivalent; provide a connection plugin declaring the exact dependency identity. Existing configuration and history remain intact. Webhooks, a cloud plugin host without the desktop service, and automatic device failover are outside this release.

## Verification

Node tests cover protocol and dependency resolution, DingTalk collection contracts and callback authentication. The existing Wework test discovery includes these files. Executor's `stand_in_identity_contract` covers settings/checkpoint migration, stable work identity and provider namespace isolation. Existing source-content and confirmation assertions remain in place. Desktop regression coverage uses the shared checkpoint runner; execute E2E and real-desktop verification only when explicitly requested.

Bridge coverage includes SDK dependency isolation and legacy read contracts, Executor discovery pagination and ownership, dependency changes, deadline/error cleanup and cleanup after caller cancellation. Tests live in `connection-runtime/mcp.test.mjs`, `runtime_work/connection_mcp_tests.rs` and `agents/codex/connection_mcp.rs`. The CI-registered `stand-in-mcp` desktop checkpoint uses the actual host and Executor to verify cross-dependency rejection and catalog recovery.

Generic CLI tests also cover operation/argument boundaries, exact installed roots, original login identity, network failures, group/direct filtering and checkpoint retention on failure. The CI-registered `stand-in-cli` desktop checkpoint verifies the real directory declaration, rejects writes/injection, and checks removal of the old dedicated endpoint. Desktop execution remains opt-in under repository policy.

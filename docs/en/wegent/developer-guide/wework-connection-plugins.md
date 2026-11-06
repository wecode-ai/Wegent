---
sidebar_position: 61
---

# Wework DSH connection extension point

Connections are capabilities of outer Wework Core DSH plugins. The Codex plugin protocol remains unchanged. A connection plugin can depend on an existing Codex plugin or implement its own external access. Collection, pagination and normalization use deterministic code; models organize and process work within each role.

Connections are a DSH extension point. `@wegent/dsh-connection-host` provides `ctx.weworkConnections`, owning the shared registry, authenticated host RPC and lifecycle. Each system declares `wework.connections` in its own DSH plugin and calls `ctx.weworkConnections.register(ctx, manifestUrl, providers)`. The email plugin retains its original package name, `@wegent/dsh-connection-runtime`, preserving saved source IDs, account settings and secure-storage ownership. Disabling one connection plugin revokes only its capabilities, leaving the host and other connections running.

A new system implements the same contract rather than adding a stand-in-specific poller:

- Declare `apiVersion`, resource kinds, event types and dependency sources; implement `check`, `listResources`, `validate`, `initialize` and `collect`. Initialization establishes the selected scope's intake boundary. Subsequent collection returns stable event IDs, timestamps, content, checkpoints and pagination state. Connecting is not itself a business event and does not replay history before that boundary.
- On actual new events, the framework persists and deduplicates them, then wakes the shared coordinator under the saved source policy. Default read-only assessment, important-fact alerts and decision requests do not require a conversation instruction first. Source content remains untrusted evidence, never execution permission. Saved timing, responsibilities and authorization still govern processing.
- Optional `readSource` provides bounded additional information without advancing collection checkpoints. Unsupported plugins fail explicitly; a ready catalog entry or saved subscription never proves content was read.
- Optional `actions` declare resource operations implemented by the plugin's `executeAction`. The host routes only declared actions for a concrete resource owned by that plugin; a manifest is not an execution grant. Native one-time confirmation or current continuous authorization remains required, and plugins retain recipient, idempotency and external-result validation. Unknown delivery results must not be retried automatically.

The built-in external event collectors are email, DingTalk, GitHub and GitLab, all using the same registration and collection contract. Internal calendar arrangements are not an external calendar connection; systems without a registered implementation do not provide new-event listening.

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
          "eventTypes": ["mail.received"],
          "versionedEventTypes": []
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

## Connection domain guidance

A provider may declare structured `assistance` to explain how the assistant should help after the connection becomes available. Each field contains 1–8 nonempty strings, at most 1000 characters each:

- `observe`: relevant incoming events and object changes.
- `prepare`: contextual reads and useful preparation within existing read permissions.
- `notifyWhen`: findings, risks and user decisions worth an interruption; keep routine or unchanged information quiet.
- `confirmBefore`: domain actions that require checking native single-use approval or a current continuing grant. This is a reminder, never a complete permission policy.

Built-in Email, DingTalk, GitHub and GitLab providers all declare guidance. Collection-only providers may omit it; the framework does not invent capabilities for them. Arbitrary system prompts, tool grants and executable commands are not supported fields.

The DSH host publishes guidance only for currently registered plugins. On every turn, Executor selects current saved connections for a manual identity conversation (pausing automatic processing does not revoke domain knowledge); delegated workers receive domain hints without account or source identities, never new read permissions; background assessment and source work receive only sources in their current batch or work that still belong to the current role and account. Stopping a plugin or revoking a connection removes the corresponding guidance from subsequent turns; pausing automatic processing removes background guidance without revoking manual domain hints. Plugin text is marked as untrusted context, with a separate host policy defining its bounds. User drafts remain business requests without injected rules.

Connecting only makes the guidance available; it does not create a business reminder. Subsequent mail, mentions, PR changes and pipeline failures trigger assessment through the existing event protocol. Read-only preparation and useful findings remain distinct from external actions and ongoing responsibilities. Plugin guidance never expands existing authorization.

## Capability declarations and read pagination

The connection protocol describes resources and capabilities, rather than individual example tasks. Event collection does not imply arbitrary resource access, and reading does not authorize external actions. Plugins declare only implemented capabilities. New systems use the same registry without adding system names or CLI flag branches to the framework.

A readable provider declares `read: { inputSchema, itemSchema, pagination }` and implements `readSource(context, { source, query, cursor })`. Pagination is `cursor` or `none`; the separate `readPagination` field is removed so discovery and implementation share one declaration. `query` is a provider-defined JSON object: message providers may accept a time window, repository providers a path and revision, and metric providers a metric name. The framework does not require every resource to have a timestamp, a seven-day window, a twenty-item page, or email fields.

Read input, item, and action input/result schemas use JSON Schema 2020-12. The standard validator does not coerce types, apply schema defaults, or load remote `$ref` values. Providers implement business defaults. Each read item additionally requires only a stable, nonempty string `id`; `itemSchema` defines its other fields. Static resources need not invent `at` or `text`. Validation errors are explicit, without silently removing fields or truncating pages.

For example, a non-message provider can accept `query: { metric: "build.duration" }` and return `{ id: "build-42", value: 18.5, unit: "s" }`. It shares authorization, validation, and lifecycle handling with mail, calendar, and repository providers without a new host branch.

Initial reads use `source` and optional `query`. Continuations use the same source and an opaque `cursor`, without repeating query parameters. Generic budgets are 1 MiB input, 8 MiB result, 1000 items, and 8192 UTF-8 bytes per cursor; the native model entry additionally limits the query object to 64 KiB. Provider schemas may impose smaller business limits. Every page revalidates the user, device, role, work, and exact current source. Source work can read only its host-bound source, rather than other connections belonging to the same role.

`hasMore: true` requires an advancing `nextCursor`. Providers bind cursors to the account, source, and original query snapshot. Reuse authoritative SDK pagination fields when available instead of implementing another pagination engine. Changed snapshots, tampering, and cross-source replay must be rejected. Cursors may expire or require a fresh read after plugin restart. Providers accurately advertise unsupported reads or pagination and reject unsupported calls explicitly.

Read cursors, collection checkpoints, and action receipts are separate state. Reads cannot advance collection boundaries, modify processing state, or create intake events. The model should retrieve the context necessary for the current judgment. Useful delivery consists of verified findings or actual action results; creating a task, unfinished retrieval, or implementation limitations cannot substitute for that outcome.

When an execution tool returns a running session, empty stdout or an elapsed `yield_time_ms` observation does not mean failure or expiry of the operation's total deadline. Within the operation's and current task's finite execution budgets, continue the same authorized session with empty-input polls, report progress and perform independent work between polls. Several empty polls or an elapsed communication interval alone do not justify termination. Actual deadlines, failures, user cancellation and native denials still stop the operation as appropriate; distinguish intentional cancellation from provider failure. Waiting must remain bounded and cannot expand authorization.

Completion feedback should briefly state the business outcome and mention only real failures, missing inputs, decisions or uncertainty that affect the user's next step. Keep technical receipts in execution records; do not routinely expose receipt IDs, tool states, "no blockers", or a channel's ordinary lack of delivery or read acknowledgements unless requested or useful to resolve a real problem. Completion wording must match the evidence: submission, acceptance and sending do not prove delivery or reading. A genuinely unknown operation outcome must still be disclosed and must not trigger repeated execution.

GitHub and GitLab repository sources implement this same read interface. Queries specify `entityKind` (`issue` or `change_request`), `number`, and `view`. Both provide details and comments; change requests additionally provide checks, commit statuses, and reviews. GitHub checks and legacy commit statuses are separate views. GitLab reviews return an approval-state object. No single view represents all merge requirements. Checks and statuses may select a commit SHA; the initially resolved commit remains fixed across continuation pages, while a new query resolves the current commit again. Every page verifies repository identity and preserves permission errors. Reading does not create a repository subscription.

When creating a read-only delegate, the primary stand-in can explicitly select concrete, currently connected sources through `create_task.readSources`. Omitting it inherits no sources. The host stores a read snapshot that cannot expand; `continue_task` preserves and revalidates it without adding later connections. The delegate receives only the selected source catalog and read capabilities. Every page rechecks parent and child ownership, device, primary identity, and current connections. Wildcards, other identities' connections, and revoked sources are rejected. Delegation grants neither configuration nor external actions.

## Provider contract

| Method                          | Behavior                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check(context)`                | Returns `ready`, `auth_required` or `error` without starting login.                                                                                                  |
| `listResources(context, query)` | Accepts `kind`, `query`, optional `cursor`; returns `items`, `hasMore`, `nextCursor`.                                                                                |
| `validate(context, source)`     | Validates resource identity, kind and account availability before collection.                                                                                        |
| `initialize(context, source)`   | Establishes the initial checkpoint without replaying all history.                                                                                                    |
| `collect(context, input)`       | Accepts `source` and `checkpoint`; returns `events`, `nextCheckpoint`, `hasMore`.                                                                                    |
| `readSource(context, input)`    | Declared `read` capability accepting `source`, `query`, and `cursor`; returns `items`, `hasMore`, and optional `nextCursor` without changing collection checkpoints. |
| `executeAction(context, input)` | Optional declared operation on a concrete resource, authorized by the original native host flow.                                                                     |

Resources contain `providerId`, `id`, `profile`, `kind` and `name`. Executor owns handling policy and the `enabledAfter` cutoff. Checkpoints are opaque JSON objects, separate from host metadata. Events require stable `id`, `text` and `at`; use RFC 3339 timestamps. Event types must follow the provider declaration. Optional message fields include sender, quoted-message and topic identifiers.

Providers needing non-secret discovery parameters such as an instance origin may declare `resourceQuerySchema`, an object JSON Schema. Their `listResources.query` encodes a JSON object string, and the catalog retains this declaration. Missing required fields or an invalid object make `connect_source` return `setup_required`, `querySchema`, and `missingFields` before a business CLI call. The AI asks a structured question instead of guessing enterprise instances or requesting credentials. This preflight checks only object shape and required fields; the provider remains responsible for validating values. Providers without a schema keep their existing plain-text search semantics.

`ConnectionResource` can carry public provider-defined opaque configuration. Optional `collectionKey` must be trimmed, nonempty and at most 256 UTF-8 bytes. Optional `configurationSummary` is nonempty plain text limited to 4096 UTF-8 bytes (Git itself limits it to 2048). The provider interprets/validates configuration and generates a stable key and reviewable summary. The framework uses the key only to partition cross-role collection grouping, persisted checkpoints and incoming routing, and the summary to show proposal before/after changes. Equal keys may share collection; different keys retain separate progress, with role-specific event deduplication. Neither field changes `readSource`, write-operation resource authority or native approval. Omitting them preserves the original subscription key and behavior. Native settings persistence does not interpret private provider fields: models must copy discovered resources, and providers reject inconsistent metadata before collection or reads.

Discovery may also return `availability`. Return `auth_required` only after a business operation explicitly reports missing authentication, with the exact native `authTarget`; dynamic targets retain their non-secret `instance`. `connect_source` uses the same authorization-state handling for this result. Network failures, HTTP 403, and empty resource lists never imply missing login. The GitHub plugin uses its declared target; the GitLab plugin requests the native target for the selected instance rather than constructing connector identities.

Providers must handle pagination, duplicate events and invalid checkpoints explicitly. Context exposes resolved dependencies and a lifecycle abort signal. Implementations can capture their declared DSH services. Disabling the plugin rejects in-flight collection results.

Declare each action with `id`, `resourceKinds`, `inputSchema`, and `resultSchema`, and implement `executeAction(context, { action, source, ...input })`. The framework validates the input excluding the host-owned `action` and `source` fields, then validates the actual result. Calls require a declared action and resource kind belonging to that Provider, and reject `scope: "all"` or wildcard operation targets. An action declaration neither exposes a model write tool automatically nor replaces native authorization; only an already authorized host tool may invoke the shared RPC. Plugins must still validate their business boundaries before delivery and must never treat event content or forged caller policies as authorization. Existing native send, merge, workspace, and delivery-uncertainty guards remain in force; schema validation does not replace them.

## Event identity, versions and processing progress

Every connection explicitly declares `versionedEventTypes` (an empty array for immutable events) and follows the same contract. Model memory, read flags and the last query time cannot replace durable processing records:

- `id` is a stable source event identifier. Pagination, replay and restarts must not generate a random new identity for the same event.
- Immutable messages (current email `mail.received` and received DingTalk messages) deduplicate by source and event ID. Email uses `UIDVALIDITY:UID`, scoped by account and mailbox; DingTalk uses platform message IDs, scoped by conversation or contact.
- Mutable objects require nonempty `objectId` and `version`, with their event types declared in the Provider's `versionedEventTypes`. Both fields must appear together. Missing version metadata for a declared type rejects the page without advancing its checkpoint. `objectId` is unique within the Provider account, including the necessary instance, repository, object kind and object identity, rather than a repository-local number alone. `version` is an opaque semantic revision, using a platform revision or a normalized business-state digest: repeated observations retain the same version, and new business changes produce a new one. Request counters, collection timestamps and webhook delivery IDs alone are not object revisions.
- Versioned events deduplicate by user, Provider, account, role, `objectId` and `version`. Personal and repository subscriptions observing the same revision create one processing event while retaining independently authorized source boundaries. A new check failure on the same PR must produce a new revision rather than being ignored because that PR was processed before. Accounts, users and roles never share processing or authorization records.
- `checkpoint` is the plugin's opaque collection position. `nextCheckpoint` records where collection reached, not whether AI handling finished. Plugins do not own the framework's collection progress, pending decisions or completion records; `readSource` cannot move the collection cursor.

The framework persists a page's events before saving its next checkpoint. Interrupted pages can replay and deduplicate by durable identity; collection or persistence failures retain the previous cursor. Internal queues assess and retry collected events without relying on the external service to return them again. Pending decisions retain their original work item; duplicate observations of completed, ignored or cancelled event revisions do not restart them. Native one-time confirmation, continuing grants, durable send idempotency and unknown-delivery handling remain authoritative. Event deduplication never grants execution permission.

For confirmed temporary network failures, timeouts or rate limits during read-only collection, a plugin can attach `retryAfterMs` (1 through 3,600,000 milliseconds) to its error, allowing the framework to retry after that delay. The host forwards this hint only for `collect` failures. The framework persists the failure count, original cursor and backoff deadline without interpreting plugin-specific error codes. Authentication, certificate, invalid-data and configuration errors omit this hint and pause for recovery; network failures do not become login requests. Unknown delivery results and write operations cannot use this collection hint to trigger automatic retries.

For host-declared CLI reads, a nonzero process exit without a structured outcome is `connection_cli_failed`; collection uses the same bounded backoff while retaining the original cursor. Empty stdout is not a malformed JSON response from a successful read. The framework reads stdout and stderr separately with size limits, recognizes structured errors, and records only structural diagnostics and bounded error codes. Structured rejections, native login requirements and malformed JSON after a successful exit receive no such retry hint; writes are never replayed automatically. The retry action beside a connection error clears the latch only for a source that is still connected, preserves progress and resumes through the next normal collection cycle without changing the configuration version.

GitHub and GitLab provide object revisions on personal activity, tracked-repository and inbox collection paths. Email and DingTalk retain immutable received-message semantics. Future edited-message or external-calendar adapters must declare and implement versioned events through the same contract, without system-specific framework branches.

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

After thread creation, discovery and invocation share a 45-second deadline. Success, failure and timeout all unsubscribe the thread so Codex can unload it. An IPC caller's cancellation does not abandon cleanup. Disposed providers cannot start new calls or accept in-flight results. The bridge never retries a tool call with an unknown outcome, starts interactive login, changes shared plugin configuration, or exports credentials. The scheduler retains checkpoints and source errors until the user retries or updates settings. DingTalk uses the generic CLI transport described below to invoke its existing declared DWS tool; it does not use an MCP technical thread.

### Existing CLI plugins without MCP servers

The current DingTalk plugin declares Skills and `connectors[].localAuth.tool`, without MCP tools. The shared bridge therefore also provides `context.cli.callTool(dependencyAlias, { tool, arguments })`. MCP and CLI share dependency identity, version checks and provider lifecycle boundaries. Neither transport invokes a model, interprets Skills as executable commands or pretends that the original plugin exposes nonexistent MCP tools.

A provider's `cliReadTools` maps dependency aliases to Connector slugs, fixed output arguments, and named read operations. Each operation declares a fixed `command` prefix and a `parameters` map from argument names to flags. For example, `searchGroups` uses command `["chat", "search"]`, parameters `{ "query": "--query", "profile": "--profile", "cursor": "--cursor" }`, and fixed output arguments `["--format", "json"]`. The adapter calls `context.cli.callTool('dingtalk', { tool: 'searchGroups', arguments: { query, profile } })`. These are deterministic Wework adapter declarations; the original Codex plugin requires no changes.

Executor obtains the read declaration from the active host rather than caller input. Unknown operations, extra arguments, option-like values and NUL values are rejected. The shared resolver selects the exact installed plugin version, rejects cross-market substitutions and path traversal, and executes only its existing `localAuth.tool` binary. It never starts a shell, executes Skill prose, or downloads a tool in the background. Existing account authorization and broker environment remain in charge of credentials. CLI processes have a 40-second deadline and an 8 MiB stdout limit. Oversized output fails immediately without waiting for process exit, and the child is cleaned up. Only explicit authentication error codes return `connector_auth_required` with the original plugin and Connector identity; network failures do not imply login failure.

Read operations come from each plugin's current `cliReadTools` declaration, rather than a second business-operation allowlist in the framework. Static argv has bounded, nonempty, NUL-free structural validation; the framework does not interpret a particular CLI's shortcut or flag syntax. Dependency, fixed-operation, and parameter mappings remain enforced on every call. The app-specific `runtime.connections.command`, `context.readCommand`, DingTalk read-command allowlist and cache-root resolver have been removed, with no fallback. Replies retain their existing source-bound confirmation path.

## Collection and delivery

Executor owns the single background collection scheduler. Providers run in the Wework DSH host and are called over a fixed loopback route protected by a private random Bearer token. Endpoint registration rejects remote addresses and redirects, expires without heartbeats, and stays in memory.

Collection requires the connection runtime on the bound device. If it is unavailable, preserve progress and report the condition; do not fall back to the removed DingTalk collector or transfer collection silently.

Sources are collected once per user, provider, account and resource. Each event reaches every connected role whose enable-time cutoff admits it. Deduplication, quoted-message threading and work grouping are role-local; no model selects recipient roles. Settings versions are checked after collection. Events are persisted before advancing the page checkpoint; interrupted pages replay and deduplicate. External calls and database writes are not a distributed exactly-once transaction.

Existing work organization, execution queues and approval flows remain authoritative. New work uses `connection_work`; historical `dingtalk_work` retains the same external-source restrictions and confirmation rules. Provider identity also separates deduplication and memory scopes. An unregistered or restarting host preserves the previous checkpoint and is retried on the next poll without latching a source error. Other collection failures retain progress and remain visible as source errors until the user retries or updates settings; login never opens automatically.

## DingTalk migration

`@wegent/dsh-connection-dingtalk` implements selected group mentions and contact messages. Search, time windows, pagination, normalization and automated-self-message filtering move into that plugin. Executor retains managed credentials and the existing source-bound reply path.

Legacy `dingtalk[]` settings migrate transactionally to `connections[]`, adding the provider identity while retaining versions, policies and enable times. Saves and configuration proposals normalize through the same path. Conflicting formats are rejected.

Historical work and message IDs are not rewritten. DingTalk retains its original deduplication namespace. Existing `after/until/cursor` state becomes the generic checkpoint on the first collection. Replies retain role, work, source-message and current-confirmation checks; other providers cannot invoke DingTalk replies.

The built-in manifest declares `dingtalk@wework` and the permitted alternate `dingtalk@wegent`, reusing installed sources in declaration order. Undeclared marketplaces are never treated as equivalent. Existing configuration and history remain intact. Webhooks, a cloud plugin host without the desktop service, and automatic device failover are outside this release.

## Verification

### Generic email

The built-in `@wegent/dsh-connection-runtime/email` source connects password or app-password IMAP/SMTP accounts. Configure the servers, ports and TLS or STARTTLS under **Connections → Email**, verify both protocols, then save stand-in settings. Connections require encryption and certificate verification. Credentials are encrypted through `weworkSecureStorage` on the execution device and never enter stand-in configuration, model context or the provider catalog. Configure remote-device credentials on that device.

Credential updates retain account IDs and role subscriptions. Deleting credentials requires confirmation of the impact on all subscribed roles. Deletion waits for an already started send to settle and blocks later operations. Disconnecting a role retains the shared account. Email connections default to per-send confirmation. Only an explicit native continuous-reply grant permits automatic replies to the original sender under the current source authorization. New recipients still require individual confirmation; revoking the grant or disabling the role blocks automatic sending.

Intake uses a server position rather than message dates or client timestamps. Ordinary settings saves, accepted proposals and project role reuse acquire `UIDVALIDITY` and `UIDNEXT - 1` inside the user configuration gate, outside the SQLite transaction. This snapshot is the activation linearization point. A successful save persists the `{ partition, sequence }` boundary with the role configuration. Client-supplied boundaries cannot replace trusted boundaries. New roles preserve other roles' boundaries and the shared collection checkpoint; re-enabling a role takes a new snapshot. Initialization failures reject the save.

Events carry server positions. Intake and execution use the same eligibility check: the partition must match and the sequence must exceed the role's boundary. This handles messages within the same second and messages arriving before the first poll. Collection pages contain at most 20 messages; body reads are bounded and truncated content is labeled. Collection does not mark mail read or download attachments. A UIDVALIDITY change fails explicitly; remove and save the connection, then reconnect and save to establish a fresh boundary.

Recognized IMAP transport interruptions preserve the collection checkpoint, show an automatic retry notice and resume on a later poll without saving settings again. Authentication, certificate and message parsing failures still pause the affected source to avoid repeatedly issuing invalid requests. Other sources remain independent.

The source-bound `wework_stand_in.send_email` tool uses native approval in the original work conversation, displaying sender, recipient, subject and the complete body. Cancellation never submits mail. Replies validate the original UID and Reply-To/From and preserve thread headers. Persistent write-ahead records prevent duplicate delivery. Definite failures before delivery can be repaired and submitted for a new approval; unknown or partial delivery must not be retried blindly.

Email previews use the tool identity, exact arguments and pending lifecycle from the same native approval. The built-in tool declares the stable top-level `title` `Wework: Send email`. Email confirmation requires the matching server, title and approval kind; it never infers approval identity from asynchronously settled tool display state.

Mail libraries ship with the selected Harness runtime. Core plugin code resolves them from that runtime's `package.json`, rather than from the copied user profile directory. The shared `stand-in-email` desktop checkpoint exercises these user stories with an isolated real GreenMail IMAP/SMTP service and a temporary trusted certificate, mocking only the model service. This does not establish compatibility with every external mail provider.

The mail fixture pins GreenMail 2.1.15 and requires Java 11 or newer locally (CI uses Java 21). Version 1.6.15 parses IMAP APPEND dates with a 12-hour clock, turning noon `12:30` into midnight `00:30`. The fixture retains exact assertions for the appended and fetched internal dates.

Node tests cover protocol and dependency resolution, DingTalk collection contracts and callback authentication. The existing Wework test discovery includes these files. Executor's `stand_in_identity_contract` covers settings/checkpoint migration, stable work identity and provider namespace isolation. Existing source-content and confirmation assertions remain in place. Desktop regression coverage uses the shared checkpoint runner; execute E2E and real-desktop verification only when explicitly requested.

Bridge coverage includes SDK dependency isolation and legacy read contracts, Executor discovery pagination and ownership, dependency changes, deadline/error cleanup and cleanup after caller cancellation. Tests live in `connection-host/mcp.test.mjs`, `runtime_work/connection_mcp_tests.rs` and `agents/codex/connection_mcp.rs`. The CI-registered `stand-in-mcp` desktop checkpoint uses the actual host and Executor to verify cross-dependency rejection and catalog recovery.

Generic CLI tests also cover operation/argument boundaries, exact installed roots, original login identity, network failures, group/direct filtering and checkpoint retention on failure. The CI-registered `stand-in-cli` desktop checkpoint verifies the real directory declaration, rejects writes/injection, and checks removal of the old dedicated endpoint. Desktop execution remains opt-in under repository policy.

The `stand-in-plugin-bridge` checkpoint uses a real local Codex plugin and MCP server to verify dependency installation, discovery and reads, write rejection, active-dependency uninstall protection and uninstall after disabling the adapter. It asserts zero model requests. The original Codex plugin needs no Wework interface.

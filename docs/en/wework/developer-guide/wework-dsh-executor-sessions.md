---
sidebar_position: 35
---

# DSH Session Extensions for Executor Tasks

Wework Core DSH projects Executor-managed running tasks into standard
`@deepseek-ai/dsh-session` Sessions. An ordinary DSH host plugin only needs to
inject `sessions` and subscribe to the official `session/event` stream. It does
not need a Wework-private event bus or a direct Executor connection.

## Event projection

`@wegent/dsh-executor-runtime` uses a dedicated Executor local-endpoint
connection and resumes the event stream from the last consumed `sequence`.
Each `(deviceId, taskId)` pair maps to a stable, independent Session, so
parallel tasks never merge into one event stream.

The Wework renderer uses the browser SSE stream exposed by the same DSH
runtime. An initial browser subscription explicitly disables history replay.
The Executor atomically captures the latest journal `sequence`, sends an
internal `executor.stream.cursor` baseline, and then forwards only new events.
The browser consumes that baseline without passing it to business listeners.
Reconnects after the connection is established explicitly enable replay and
resume from the last consumed `sequence`. A zero `after` cursor alone must not
identify a fresh connection because a reconnect that has not received an
ordinary business event can also carry zero. Conflating those cases either
floods the renderer with the full journal or drops events emitted while the
stream was disconnected.

The main mappings are:

| Executor event                             | DSH Session event                           |
| ------------------------------------------ | ------------------------------------------- |
| `response.created`, `response.in_progress` | `turn/start`, `step/start`                  |
| `runtimeGeneratedUserMessage`              | `user/message`                              |
| reasoning delta                            | `assistant/chunk` reasoning block           |
| output text delta                          | `assistant/chunk` text block                |
| `thread/tokenUsage/updated`                | `assistant/chunk` usage                     |
| completed, incomplete, failed, error       | `assistant/message`, `step/end`, `turn/end` |

The projection preserves raw user messages and model output. Installing and
trusting a plugin permits it to read that content through the standard DSH
Session contract; Wework does not maintain a second anonymized-summary
extension point for the same data.

Codex `tokenUsage.last` describes the most recent model call. One Executor turn
can contain multiple model calls, so this value resets between calls. The
projection derives adjacent deltas from thread-level `tokenUsage.total` and
accumulates those deltas into usage for the current DSH turn. Projected
`outputTokens` therefore increases monotonically within one turn, and
`assistant/message.usage` uses the same whole-turn cumulative value.

A plugin that needs live token throughput should subtract adjacent
`outputTokens` values for the same Session and turn, then divide by the sample
interval. It must not add multiple cumulative samples together, and it should
reset its own delta baseline when a new turn starts.

Accurate Codex usage is normally reported when a model call settles, not for
every generated token. Plugins that need lower-latency feedback can also
observe standard `text-delta` and `reasoning-delta` chunks, estimate live
generation throughput over a sliding window, and calibrate that estimate with
later usage samples. Executor streaming text and thinking blocks are projected
into those standard chunks; tool, plan, and other non-model blocks are excluded
from the model output stream.

```js
export const inject = ["sessions"];

export function apply(ctx) {
  ctx.on("session/event", (session, event) => {
    if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
      observeUsage(session.id, event.data.chunk.usage);
    }
  });
}
```

## Generic Backend plugin storage

A DSH plugin that needs cross-client persistence can use the authenticated
generic storage API. Data reuses the existing `Kind` table with this identity:

- `kind`: `DshPluginData`
- `namespace`: npm package name
- `name`: storage unit name
- `user_id`: current authenticated user

Every read and write includes a descriptor. The Backend validates its
`version`, table-name list, and global-value declaration so incompatible plugin
versions cannot silently reinterpret the same storage unit.

```json
{
  "version": 1,
  "tables": ["scores"],
  "has_global": false
}
```

The API prefix is `/api/v1/dsh-plugin-storage`:

| Method and path                                                       | Purpose                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `POST /units/{unit}/load?package={package}`                           | Load the current user's unit                      |
| `PUT /units/{unit}/tables/{table}/records/{key}?package={package}`    | Write a record                                    |
| `DELETE /units/{unit}/tables/{table}/records/{key}?package={package}` | Delete a record                                   |
| `PUT /units/{unit}/global?package={package}`                          | Write a declared global value                     |
| `GET /units/{unit}/tables/{table}/shared?package={package}`           | Scan explicitly shared records within the Backend |

A record write body adds `value` and `shared` to the descriptor. Only records
with `shared: true` appear in a shared scan, while a normal load always returns
only the current user's data. Plugins should use a stable key for a best record
instead of appending an unbounded record for every run.

In Wework local-first mode, a plugin client should use the active cloud
connection's `apiBaseUrl` and token. Local functionality can continue without
a Backend connection, but shared data is unavailable.

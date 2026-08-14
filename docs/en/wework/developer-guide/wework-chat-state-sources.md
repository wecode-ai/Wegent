---
sidebar_position: 18
---

# Wework Chat State Sources

This document records the state sources for the Wework chat path. The goal is to make UI code read one explicit derived status instead of letting the send button, message stream, queue, and runtime task list override each other.

## Core Principles

1. `RuntimeTaskMachine` is the aggregate root for one task's execution, turn, Goal, and unread lifecycle; its reducer is an internal transition implementation.
2. `RuntimeTaskLifecycleStore` owns all task machines, routes executor/UI/transcript events, and is the only frontend source for task lifecycle state.
3. `RuntimeTaskLifecycleProvider` only exposes Store subscriptions to React. It does not own, cache, or derive lifecycle state.
4. `useWorkbenchPaneSession` owns pane content such as messages and queued input, but reads all task and turn lifecycle facts from the Store.
5. `runtimePaneStatus.ts` is a read-only projection from a lifecycle snapshot to existing pane presentation fields. It must not infer execution or turn state independently.

## State Source Inventory

| State                                 | Single Source                                                                                                                                                                            | Derived Values / Consumers                                                                                         | Maintenance Rule                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message content and status            | `useWorkbenchPaneSession.messages`                                                                                                                                                       | `MessageList`, export, file changes, request user input                                                            | Update only through transcript reset or `reduceWorkbenchMessages`                                                                                                                                                                           |
| Whether the assistant turn is active  | `RuntimeTaskLifecycleStore` task snapshot `turn.phase`                                                                                                                                   | Streaming message presentation and debug state                                                                     | Live stream and transcript events are routed into the task machine; layouts and pane code must not independently infer turn activity from messages                                                                                          |
| Local send phase                      | `RuntimeTaskLifecycleStore` task snapshot `turn.phase`                                                                                                                                   | `status.isSubmitting`, `status.isWaitingForAssistantIndicator`, compatibility fields `sending/waitingForAssistant` | Optimistic send, acknowledgement, rejection, stream start, and settlement are events owned by the task machine                                                                                                                              |
| Current runtime running snapshot      | Executor `running` input routed through `RuntimeTaskLifecycleStore`                                                                                                                      | Lifecycle snapshot, sidebar, composer, message area, queue advancement                                             | The executor field is the authoritative external fact; the lifecycle Store is the only frontend access point and keeps optimistic transitions in the same machine                                                                           |
| Whether the pane is busy              | `paneSession.status.isBusy`                                                                                                                                                              | Whether the current pane queue may advance                                                                         | Composed from `isSubmitting`, `isAwaitingAssistant`, `isAssistantStreaming`, and `taskExecution.running`                                                                                                                                    |
| Queued messages                       | `queuedMessages`                                                                                                                                                                         | `ConversationQueuePanel`, automatic next follow-up send                                                            | Mutate only inside the pane session; advancement must use `status.canSendQueuedMessage`                                                                                                                                                     |
| Guidance messages                     | One source per lifecycle phase: `queuedMessages` while pending, the mounted or background live projection after application, and the Codex transcript once the Provider covers that turn | `ConversationQueuePanel`, `MessageList`                                                                            | Remove applied guidance from the queue; a background cache entry only bridges a running transcript gap, must never merge into Provider pages, and must yield the whole projection once the Provider covers the same turn                    |
| Transcript loading and pagination     | `transcriptLoading`, `transcriptHasMoreBefore`, `transcriptBeforeCursor`, `loadedTranscriptRanges`                                                                                       | Infinite scroll, turn navigation                                                                                   | Update only from transcript API responses                                                                                                                                                                                                   |
| Runtime goal                          | `threadGoal` + `pendingGoalState`                                                                                                                                                        | Goal bar, goal draft, first-message initial goal                                                                   | Persisted goals come from the runtime goal API; goals before task creation live in pending seeds                                                                                                                                            |
| Answered request user input ids       | `answeredRequestUserInputIds`                                                                                                                                                            | Hide already submitted or ignored request user input cards                                                         | Update only from submit or ignore actions                                                                                                                                                                                                   |
| Model context usage                   | Codex `thread/tokenUsage/updated` runtime stream events; `runtime.tasks.transcript.contextUsage`                                                                                         | Context-window usage ring and tooltip in the bottom-right composer controls                                        | The executor must forward Codex token usage notifications unchanged and read the latest token count from the same rollout for historical transcript responses; UI stores it only as `projectChat.contextUsage` for the current runtime task |
| Long response content and tool output | Preview windows from `reduceWorkbenchMessages`; truncation fields and full-load marker from `runtime.tasks.transcript`                                                                   | `MessageList`, processing blocks, Debug Panel memory summaries                                                     | Resident `messages` keep only a tail preview, original length, and load reference by default; only an explicit user-triggered full transcript load may upgrade the current pane and replace `messages` with complete content                |
| Attachment/model/skill selection      | `projectChat` context                                                                                                                                                                    | Send payload, composer controls                                                                                    | In-task option locking is derived from `projectChat.isOptionsLocked`                                                                                                                                                                        |
| Device availability                   | `state.devices` + current task/project device selection                                                                                                                                  | Composer disabled reason, device prompts                                                                           | Use only for send preconditions; never for assistant streaming status                                                                                                                                                                       |

## Runtime Event Flow

1. A new message submit sets `sendPhase` to `submitting`.
2. After runtime accepts the request, `sendPhase` becomes `awaiting_assistant`.
3. `chat:start` becomes `assistant_started`; the reducer creates or updates the assistant streaming message and `sendPhase` returns to `idle`.
4. `chat:chunk` and block events update only `messages`.
5. Codex `thread/tokenUsage/updated` events update only `projectChat.contextUsage`; they must not create empty messages or write transcript data.
6. When opening a historical task, `runtime.tasks.transcript.contextUsage` only restores the current task's `projectChat.contextUsage`; UI code must not add extra fallbacks that rescan messages or task lists.
7. `chat:done`, `chat:error`, and cancellation events settle the assistant message through the reducer and refresh the work list.
8. If runtime work and message state disagree, do not settle it with fallback logic; fix the missing stream event, transcript data, or reducer action.

During send startup, Wework may first receive an empty transcript with
`source: pending_local_task` and `running: false` before the real runtime task
appears in the task list. While the turn remains `submitting` or
`awaiting_assistant` and no assistant has settled, that transcript must not
settle the executor or turn. The later task-list `running: true` snapshot is
authoritative once the executor has started. An explicit `running: false`
received while an assistant is already streaming remains terminal and must
settle normally; false snapshots must not be ignored indiscriminately.

A Codex provider may send only an `item/completed` snapshot containing the
complete assistant text, without any `item/agentMessage/delta`. If the current
final response has not received a delta, the executor must convert that text
into one `response.output_text.delta`. If deltas were already received, it
must ignore the completed snapshot to avoid duplicate text. Temporary chats
use ephemeral threads and cannot depend on `thread/read(includeTurns)` to
recover live text that was dropped.

After a task settles in the background, reopening its pane may initially load
a stale transcript that contains only an older turn. `useWorkbenchPaneSession`
must compare the latest cached turn identity with settled assistant identities
from the transcript. A turn identity includes both `turnId` and normalized
`subtaskId`. The cache remains authoritative until the transcript settles the
same turn; only then does the transcript become authoritative. Content length,
block count, or any other content-weight heuristic must not determine recency.

A work-list refresh may also immediately reload the completed transcript. That
transcript owns the final text, message status, and file changes, but Codex
`thread/read` may temporarily omit tool items that already completed in the
live stream. The `assistant_done` ingress normalizes the live message's
`subtaskId` to its canonical `turnId`. After switching to the matching
transcript turn, `useWorkbenchPaneSession` keeps the transcript's authoritative
fields while restoring live tool blocks whose status is `done` or `error` and
whose block id is absent from the transcript. It must not restore `pending` or
`streaming` blocks, which would make a completed task appear active again.

A single Codex turn can be split into multiple assistant messages by tool
calls or mid-turn guidance. Each message must have a distinct message `id`
while retaining the same canonical `turnId`. Turn-level actions such as fork
and rollback must use the canonical turn ID persisted by Codex, never a
UI-only segmented message ID.

### Codex Turn Identity and Recovery

The Codex app-server `turn/start` response is the authoritative source for a
new turn identity. The executor must record its turn ID immediately after the
request succeeds. A later `turn/started` notification may confirm or correct
that identity, but it must not be required before the turn becomes active.
Guidance and interruption therefore still target the current turn when a live
notification is delayed or missing.

When the user sends guidance, Wework optimistically inserts the guidance
message into the current turn before calling `runtime.tasks.guidance`. If
Codex `turn/steer` explicitly reports that the expected turn ID differs from
the actual active turn ID, the executor updates its record with the returned
ID and retries exactly once. The successful response turn ID may rebind the
optimistic message to the correct turn. On failure, Wework removes the
optimistic message and keeps a retryable queue item so the transcript never
shows guidance that Codex did not accept.

**Interrupt and send now** optimistically marks the running turn as cancelled
and removes in-flight optimistic guidance before requesting interruption. The
interrupt operation treats an already absent active turn as idempotent
success, then starts the replacement turn. If the request fails, the frontend
restores the previous turn state and optimistic guidance instead of losing
the user's message.

Live events carry incremental updates only. After the WebView or runtime
transport is rebuilt, recovery for a persisted Codex thread must call
`thread/resume` and then read a complete snapshot with
`thread/read(includeTurns)`. The snapshot re-establishes turns, messages, and
running state; code must not continue inferring them from pre-disconnect
in-memory events.

When the first message carries a pending Goal seed, both the send entry point
and pane initialization must write the seed status into
`RuntimeTaskLifecycleStore` immediately. An asynchronous `runtime.goal.get`
may return no Goal before persistence completes; while the seed still belongs
to the current task, that empty result must not clear the lifecycle Goal
status. This lets an active Goal continue to constrain task lifecycle even
when stream settlement races ahead of Goal persistence.

### Claude Code Conversation Executor

Claude Code uses the same ordinary runtime-task conversation UI as Codex in
Wework. A terminal or TUI must not replace the message list. The executor
starts each turn in Claude Code print mode, consumes `stream-json` events, and
maps them into the shared `chat:start`, text delta, tool block, and terminal
events. The Claude session ID returned by the first turn is stored in the
LocalTask runtime handle. Follow-ups, Goals, and `/compact` resume that same
session with `--resume`.

The executor persists Claude Code Goal state in the LocalTask runtime handle.
A Goal message is sent as Claude's native `/goal <objective>` command, and only
the turn that actually executes that Goal may update it to `complete`. An
ordinary follow-up must not complete a Goal that has not run. After turn
settlement, Wework may synchronize the latest snapshot through
`runtime.tasks.goal.get`, but an empty response must not overwrite an existing
Goal. Explicit removal belongs only to the Goal clear API or a
`runtime.goal.cleared` event. When asynchronous snapshots race, the newer
`updatedAt` value wins; at the same timestamp, `complete` wins over a
non-terminal status.

Model and permission selections are per-turn execution parameters. Wework maps
Claude Code permission modes to `default`, `acceptEdits`, `plan`, `auto`, or
`bypassPermissions`, and maps the selected model to the Claude CLI `--model`
argument. An absent model selection must not be interpreted as an explicit
Claude runtime override. Claude Code `/compact` remains an ordinary native
command, while Codex continues to use its app-server compact RPC; the two
runtimes must not share the compaction implementation.

## Local Multi-Root Projects and Task Ownership

A local Codex project may contain an ordered list of workspace roots. The first
entry is the primary root used by the composer's default workspace and the
execution request `cwd`. The complete deduplicated root list is project-level
execution context and must not be reduced to the current workspace.

Multi-root context follows this primary path:

1. Wework reads the runtime project's `roots`. It derives roots from
   `deviceWorkspaces` only when that field is absent, then sends
   `runtimeProjectKey`, `runtimeProjectName`, and `runtimeWorkspaceRoots` when
   creating a task or sending a message.
2. Local services write those fields into execution request metadata.
3. The executor persists the project key and roots in `RuntimeTaskLink`, then
   passes `runtimeWorkspaceRoots` to Codex `thread/start`, `thread/fork`,
   `thread/resume`, and `turn/start`.
4. If a follow-up request omits project metadata, the executor restores it from
   the existing `RuntimeTaskLink`, so the same thread and a reopened
   conversation keep the same project scope.
5. Codex global thread assignment uses the explicit project key before path
   matching, preventing one multi-root project from splitting into several
   sidebar projects.

The latest local `runtimeWork` snapshot is authoritative for local task
presentation. An asynchronous cloud refresh must merge with the latest local
snapshot when the refresh completes; it must not overwrite a newly created
task with state captured before the request began. **New chat** clears only the
current chat pane. It does not archive or delete the previous task, which must
remain under its project and be reopenable. The environment popover must list
and copy every project root, not only the primary root.

These rules apply only to local Codex projects. Remote and cloud tasks retain
their existing single-workspace selection semantics; local multi-root support
must not implicitly broaden a remote execution scope.

### Web Search Tool Blocks

A Codex web search may not include its query action in `item/started`; the final `action` can arrive only in `item/completed`. The executor must update the same block id, settle its status as `done`, and write the final `action` into `tool_input`. Otherwise Wework keeps showing a running web search whose expanded details are empty. Live events and historical transcripts must produce the same `web_search` tool block shape.

The Wework presentation layer accepts both Responses API snake_case action names (`open_page`, `find_in_page`) and Codex app-server camelCase names (`openPage`, `findInPage`). Normalize this naming difference at the tool-detail parsing boundary; do not mask missing completion events with UI placeholder content or status fallbacks.

### Tool Call Duration

Tool start time, completion time, and duration come from the Codex item lifecycle forwarded by the executor. This lifecycle is the shared authoritative source for both the live stream and historical transcript. The executor must preserve millisecond-precision `createdAt`, `completedAt`, and `durationMs` fields in started/completed events and transcript projections, and merge the function call, command execution, and output for one invocation into a single block.

Pane caches and React components only restore and present those timing fields. A running local timer may temporarily anchor the start time from its first render to avoid jumps during incremental updates. Once the executor supplies a completion time or duration, the completed presentation must use the current block's authoritative fields. Switching panes, refreshing the transcript, or reusing a component must not retain a local completion time or start anchor from the previous pane state.

### Tool Activity Preview Scrolling

The collapsed tool activity preview shows at most three rows and follows the latest activity while no tool detail is expanded. Auto-scroll must react both to changes in the tool row count and to the bottom “Thinking” row appearing or disappearing. When a tool completes without changing the row count, the thinking row must remain inside the inner scroll area's visible range. Expanding a detail removes the preview height limit, so forced scrolling must not override the user's reading position in that state.

## Goal and Task Execution State

The goal bar's running presentation must be constrained by the current runtime task execution snapshot. When App Server explicitly reports `running: false` for the current task, an otherwise `active` goal must be derived as `paused` in the UI and its displayed elapsed time must stop. This prevents an interrupted task from showing an active, ticking goal when it is reopened.

- Task execution is known only when `running` is an explicit boolean. A missing field means the state is unknown and must not pause the goal.
- This derivation affects only Wework presentation and elapsed-time calculation; it does not automatically call the goal pause API. Persisting `paused` remains an explicit user action through **Pause goal**.
- When the task reports `running: true` again, the goal uses the original status returned by the runtime goal API.

Automatic continuation for an active goal is driven separately by root-turn lifecycle events. After
`runtime.goal.continuation: started`, the goal bar must keep showing “Goal continuing” while the
assistant is producing output, thinking, or invoking tools. Assistant output starting is not a turn
completion signal and must not clear continuation state. Clear that state only for the matching
`settled` event, a non-active goal update, a cleared goal, or a pane switch to another task.

When the user stops the current response for a task with an active goal, Wework must persist
`paused` through the runtime goal API before cancelling the current turn. This ordering disables
the automatic continuation source before the turn ends, so the goal cannot start another turn in
the window before its pause request arrives. If pausing the goal fails, Wework must not mark the
current response as stopped. While goal details are still loading, the stop flow must use the
`goalStatus` from the task-list snapshot to decide whether to pause; it must not skip persistence
merely because the goal bar has not rendered yet.

## Task Execution, Continuity, and Unread State

The sidebar running indicator, composer state, message state, and unread reminder represent different facts and must not share one ambiguous "active" boolean:

| State          | Definition                                                                        | UI contract                                                                                                  |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Running        | `task.running === true`                                                           | Show the sidebar spinner, pause in the current pane composer, and "Thinking" in the message area             |
| Turn streaming | `task.running === true` with a streaming assistant message                        | Use only for streaming-message lifecycle; it must not create a second running definition for other UI states |
| Settled unread | The task transitions from running to not running while it is not the current task | Show the blue unread dot in the sidebar and optionally send one completion notification                      |

`running` is the executor's authoritative task-lifecycle state, not the state of one individual turn. While an Active Goal continuation loop is alive, the executor must continue reporting `running: true` even when no assistant message is streaming between two automatic turns. The sidebar spinner, composer pause button, and message-area "Thinking" therefore remain visible without creating unread state. If the executor restarts without restoring that execution loop, it must report `running: false` even when the persisted `goalStatus` is still `active`; Wework must not infer execution from the Goal status. A stale streaming message from the previous turn must not be revived.

A terminal task event must immediately mark the local task as `running: false` and refresh the work list. If a concurrent refresh returns an older `running: true` snapshot, the reducer must preserve the locally settled state until the same task receives a new start event; a stale response must not relight the spinner, pause button, or "Thinking". Execution identity is `deviceId + taskId`. `workspacePath` is routing metadata that may change between creation, refresh, and transcript recovery, so it must not participate in execution-state identity.

Unread is created only when the current Wework renderer observes a `running: true -> false` edge. It must not infer execution history from free-form `status` text or persisted records; local persistence stores only unread results that were already created, never running state. A task whose persisted Goal remains `active` while the executor is no longer running is waiting for recovery and must not become completion-unread because the application or executor restarted. The current task and every running task must be excluded from visible unread state. Opening a task clears its unread state.

The executor's `RuntimeTaskLink.running` field exists only in current-process
memory and runtime API responses. `runtime-work/index.json` must not serialize
the field, and readers must ignore any legacy `running` value left in an older
index. Whether a task is executing is determined only by the current
executor's active-task set.

## Composer Mode Indicators

When the composer is in plan mode or goal-draft mode, its bottom mode pill must show a semantic icon to the left of its label: a checklist for plan mode and a target for goal draft. Desktop and compact layouts must reuse the same mode-pill implementation so the state is expressed consistently.

The mode pill's cancel button appears only on hover and is absolutely positioned over the left icon while that icon fades out. Do not expand the cancel button or add spacing that changes the pill width, because that causes the label to shift horizontally.

## Composer Draft Buffering

`BufferedChatInput` preserves a pane-level draft during editing and submission, while the external `value` remains the source of truth for the confirmed draft. After a non-empty draft is submitted, the local empty state must be associated with the expected empty external value instead of the text that was just submitted. Otherwise, returning the same text from a queue or guidance row for editing is mistaken for stale draft state and the composer remains empty. Changes to this path must cover the regression sequence “submit text → external value clears → edit the queued row to restore the same text.”

## Referenced Conversation Context

The composer's `@` menu supports explicit references to other Wework conversations. An empty query shows the five most recent conversations from the current `runtimeWork`; a typed query filters by title, project, and workspace path. The current conversation is always excluded so its in-progress context cannot be recursively injected into itself.

A reference is serialized in the draft as `[$title](wework-conversation://<encoded RuntimeTaskAddress>)`. This is an internal Wework URI. Both the composer and sent user messages must render it as a conversation-reference chip instead of exposing the raw URI. Before sending, `useWorkbenchPaneSession` parses and deduplicates every reference, loads each transcript with `includeFullContent: true` and `refresh: true`, and enforces these boundaries:

- Include only user messages and completed assistant text. Do not inject system, developer, tool, thinking, or streaming assistant content, and do not separately ingest attachment binaries.
- Send the extracted text as `referencedConversations` application context inside `additionalContext`, explicitly labeled as untrusted background context. Instructions, tool calls, or permission claims in a referenced conversation are data, not executable instructions for the current conversation.
- If any referenced transcript cannot be loaded, block the send and show a localized error. Never continue after silently dropping a reference.

This feature is a user-authorized pre-send snapshot injection, not a conversation MCP. The model cannot independently list, search, or read conversations that the user did not reference; menu search uses only metadata already loaded in `runtimeWork`. Changes to this path must keep the reference parsing and context construction unit tests, composer/message rendering tests, and the `conversation-mention.scenario.mjs` desktop E2E scenario aligned.

## Conversation Switching and Transcript Restoration

`loadedRuntimeTranscriptKeyRef` only proves that a task transcript finished loading at some point. It does not prove that the message area is still displaying that task. When the user rapidly switches from task A to a still-loading task B and back to A, B's cached messages may already have replaced the message area while A remains the last successfully loaded key.

The pane may therefore skip restoration only when both the loaded key and the displayed transcript identity match the target task. When the identities differ, it must reapply the target task's cached messages and start a transcript load. Effect cleanup must continue isolating late responses from other tasks so they cannot overwrite the current task.

Cover this path with both a component race test and a real desktop scenario: keep one task running, switch rapidly between it and a completed task, then verify that every historical turn in the completed task remains visible after switching back.

## Long Output Memory Boundary

The Wework chat UI must not keep complete long-running output in React state. `WorkbenchMessage.content`, thinking/text/plan block `content`, and tool block `toolOutput` must enter `messages` through the shared preview-window path:

- After runtime stream events reach `reduceWorkbenchMessages`, content above the threshold keeps only a tail preview and records `contentTruncated`, `contentOriginalChars`, or `toolOutputTruncated`, `toolOutputOriginalChars`.
- Stream offsets and historical metadata are only hints about the original length and cannot trigger a truncation notice by themselves. The reducer may set truncation state only when the original length actually exceeds the corresponding preview threshold; offset gaps on short content must preserve the visible text and clear invalid truncation metadata.
- Historical messages returned by `runtime.tasks.transcript` must apply the same truncation semantics by default so refreshes or task switches do not load complete large strings back into the WebView.
- When the user clicks "load full output", the frontend calls the same runtime transcript method with `includeFullContent: true`. The executor returns the complete transcript with `fullContent: true`; the current pane replaces its preview messages with full messages and clears pagination/gap state, so later expanded controls reuse the full state instead of taking another long path.
- `MessageList` and `ToolBlocksDisplay` may only render the current preview and truncation notice; hiding complete content with CSS does not count as releasing memory.
- Right-side temporary chats must reuse the same reducer and stream-action batching path instead of accumulating full output for temporary threads.

## Transcript Order

The server-provided `messageIndex` is the only ordering authority for the persisted Codex transcript. Loading an older page or filling a middle gap may combine only pages from that same Provider transcript by `messageIndex`; it must not merge background message caches, `runtimeHandle.messages`, or locally matched user content into Provider pages.

While the current pane has a live turn that the transcript has not covered yet, the UI may keep displaying that pane's stream projection as a whole. Once the Provider covers the same turn, the pane switches to the transcript as a whole instead of taking the union of both message sets. Transcript-page deduplication uses only stable Provider message ids and must not infer identity from content, role, or subtask.

Codex may filter the initial user input from the Provider transcript `items`,
while Wework still retains the visible text that the user submitted in
`RuntimeTaskLink.userMessagePresentations`. When the executor restores such a
message, it must bind it to the next Provider turn on the timeline and write
the canonical `turnId` and `subtaskId`. If the user input and the first
assistant message share a timestamp, the user input must remain first.
Canonical `turns` are the frontend transcript's only input, so restoring a
message only in the compatibility `messages` array is insufficient.

### Assistant In-Turn Display Order and Typography

Final text, process text, and tool blocks within one assistant turn must be
projected in runtime item arrival order. The UI must not group them by type and
then render them in a fixed layout. In particular, when final text arrives
before a later process update, that process update must appear below the final
text, and transcript restoration must preserve the same order.

The thinking indicator, process body text, and final answer body all use the
semantic `text-chat` size. Tool summaries, timestamps, and other metadata may
retain their compact roles, but a chat body must not change font size when it
moves between streaming and completed states because that causes a visible
flash.

## Guidance Message Order

Running Codex LocalTasks can send a queued message as native guidance. Guidance is user input inside the current turn, not a new follow-up turn, so the UI must insert the local user message inside the active assistant as soon as guidance sending starts:

1. Mark the matching `queuedMessages` item as `sending` and show the "正在引导当前对话" notice.
2. Create the user message with the same local message id and `createdAt`, then split the current streaming assistant into two messages.
3. Freeze the before-guidance assistant as done and remove its `subtaskId`, so later stream events cannot write into it.
4. Keep the original `subtaskId` on the after-guidance assistant, and insert a `conversation_guidance` tool block first to mark the guidance position.
5. Later `chat:chunk` and `chat:done` events may carry full text, so trim the assistant text prefix recorded at split time before sending them to the reducer.

Do not append the user message to the bottom after guidance succeeds, and do not wait for `runtime.tasks.guidance` to return before splitting the assistant. Assistant text generated while the guidance request is waiting would otherwise appear before the user guidance message, making live streaming order differ from refreshed transcript order.

If the source pane is unmounted when guidance is applied, the background subscriber must remove the matching item from `queuedMessages` and write the confirmed user message into the in-memory live projection in `runtimeConversationCache.messages`. The background path must reuse the foreground `AppliedRuntimeGuidanceMessage` constructor and assistant-splitting entry point; it must never append with `[...messages, guidance]`, which places the user message after the entire running assistant when the source conversation is reopened. Split-prefix boundaries must be shared by conversation key so a foreground `chat:done` can still trim the already rendered assistant prefix after a background split. Reopening the source conversation before the Codex transcript covers the running turn must still show that confirmed message. Once the Provider transcript covers the same turn, it takes over the content and ordering as a whole. The cache is neither persisted nor merged into Provider transcript pages, so it does not become a second persistent transcript source.

After inserting guidance, the message area must scroll to the bottom and briefly maintain stable bottom-following even if the user had previously scrolled upward, so the new user message and assistant continuation remain visible. This forced scroll applies only to newly applied guidance in the current conversation; loading a historical page that contains older guidance must preserve the user's current viewport anchor.

## Right-Side Temporary Chats

The right workspace **Temporary chat** feature starts a short side conversation next to the current local Codex thread. It is not a fork and it is not a normal runtime task shown in the left task list:

- Each temporary chat tab has an independent `chat:<id>` instance id, so the right workspace can hold multiple temporary chats at the same time.
- Before a runtime thread exists, `TemporaryChatPanel` uses the instance id as its `conversationKey`. After creation, pane workspace state retains the tab's runtime address and `runtimeConversationCache` restores its live message projection. Temporary threads do not support `thread/turns/list`, so a main-conversation switch that unmounts and remounts the panel cannot depend on transcript loading to recover content.
- Attachment selection, upload progress, and errors are also isolated per temporary-chat instance and must not reuse the main composer attachment state. The first message passes that instance's attachments explicitly to `createTemporaryRuntimeTask`.
- When a temporary chat is the only open right-workspace tab, the panel defaults to a compact `420px` width. Opening another workspace tab restores the general split default, while a user-resized width remains authoritative.
- The first message calls `createTemporaryRuntimeTask`, creating an `ephemeral` runtime task with the current main thread as `sideSource`. This task does not enter the left task list and does not navigate the main pane.
- Follow-up messages must continue the already loaded temporary thread. The Codex app-server path uses `direct_thread_id` and calls `turn/start` directly; it must not use the normal `resume_thread_id` / `thread/resume` path, because temporary threads do not have rollout mappings and would otherwise fail with `no rollout found`.
- A regular follow-up must write its user message into the conversation cache before awaiting `runtime.tasks.sendMessage`, keeping it ahead of the current turn's Thinking indicator. A failed send removes that same client message id from the cache.
- `TemporaryChatPanel` must preserve the running-send options supplied by `BufferedChatInput`. When the user selects **Guide current response** or sends a queued row as guidance, the temporary chat must call `runtime.tasks.guidance` and settle the matching queue item by `clientGuidanceId`; it must not downgrade guidance to a regular follow-up after the active turn.
- Temporary chats reuse only the current workspace and current thread context. If no main thread source is available, sending should be blocked and the user should be asked to open an existing conversation first.
- After a runtime-work refresh, the reducer must hydrate the current task address with the authoritative `threadId/runtimeHandle` from the same device and task. Keeping an optimistic address without its thread merely because the device is still online prevents the temporary chat from establishing `sideSource`.

Maintenance rule: do not add UI fallbacks that insert temporary chats into the left task list, and do not fabricate rollout records for temporary threads in the executor. The primary path is `ephemeral + sideSource + direct_thread_id`.

After changing this path, run `pnpm --filter wework e2e:desktop --segment temporary-chat`. The independent real-Tauri scenario holds an assistant response open, asserts that a regular follow-up stays above the Thinking indicator, switches the main conversation, and verifies that both temporary-chat user messages are restored after switching back. It writes screenshots for each critical stage to `wework/test-results/desktop-e2e/<run-id>/`.

## Top-Level Page Transitions

The workbench owns live state that cannot be serialized reliably, including composer drafts, Terminal sessions, and the in-app browser. When users move from the workbench to plugins, apps, or iframe apps, `AppRoutes` must keep `WorkbenchProvider` and `WorkbenchPage` mounted and only hide the workbench surface. Returning to the workbench then reuses the original component instances. A direct visit to an auxiliary page may defer the initial workbench mount to avoid creating unused background sessions.

Do not unmount the workbench during route transitions, and do not add incomplete restoration fallbacks for Terminal or browser state. New top-level pages should join the auxiliary-page rendering branch without changing the workbench lifecycle.

Multiple top-level document tabs use React `Activity` to retain independent
workbench instances. Updates inside a hidden `Activity` may be deferred while
portals that it created in global titlebar targets remain attached. Every
global titlebar portal must therefore identify its owning document tab, and
`AppRoutes` must control portal visibility from the active-tab state. Do not
rely only on conditional rendering inside the hidden workbench to withdraw a
portal. After a tab switch, only the active tab may expose its main header,
panel actions, right-workspace title, and feedback entry.

## Workbench Pane Cache

The desktop workbench caches up to 20 regular panes so messages, composer drafts, and local UI state survive switches between parallel tasks. Once the limit is exceeded, inactive panes are evicted in least-recently-used order. Panes for running tasks and panes with pinned terminals remain mounted outside the regular cache limit until the task finishes or the terminal is unpinned. Maintain this boundary through the existing `CachedWorkbenchPaneStack` LRU and pinning mechanisms; do not add a second pane cache in the layout.

The message area stores each task's reading position by `conversationKey`. During a task switch, restoration realigns the saved message anchor throughout the layout stabilization window; programmatic `scroll` events in that window must not overwrite the snapshot. An explicit wheel or touch gesture must cancel restoration immediately. Changes to this path must cover the real desktop flow “scroll to the middle of a long response → switch to another task → switch back” and retain screenshots from before the switch, after the switch, and after restoration.

## Audit Result

- Desktop and mobile layouts no longer scan `messages` directly to decide whether the assistant is streaming; they read `paneSession.status.isAssistantStreaming`.
- Composer disabled state no longer reads independent `paneSession.sending`; it reads `paneSession.status.isSubmitting`.
- Message waiting indicators no longer combine `sending || waitingForAssistant`; they read `paneSession.status.isWaitingForAssistantIndicator`.
- Queue advancement no longer uses scattered `currentRuntimeTask && !busy`; it reads `paneSession.status.canSendQueuedMessage`.
- Sidebar, composer, and message-area task status all subscribe to `RuntimeTaskLifecycleStore`; none reads `runtimeWork.running` directly.
- Optimistic send state and executor-confirmed state use the same task machine, so send acknowledgement and stream races cannot create separate frontend authorities.
- `runtimePaneStatus.ts` only projects the lifecycle snapshot into compatibility presentation fields; it does not maintain task or turn state.

## Maintenance Rules

- Add new task lifecycle state or transitions to `RuntimeTaskMachine` and its internal reducer first, then expose a Store event and derived snapshot field.
- Do not recompute task running, turn activity, busy, or unread state in layouts, pane hooks, or components.
- Do not add independent `isSending`, `isRunning`, or `isStreaming` React state. New external facts must enter through Store event routing.
- When runtime work and message state disagree, do not override display inside UI components and do not add fallback settlement; fix the primary path.

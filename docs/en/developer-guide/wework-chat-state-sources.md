---
sidebar_position: 18
---

# Wework Chat State Sources

This document records the state sources for the Wework chat path. The goal is to make UI code read one explicit derived status instead of letting the send button, message stream, queue, and runtime task list override each other.

## Core Principles

1. `useWorkbenchPaneSession` is the state boundary for a chat pane.
2. `paneSession.status` is the only chat runtime status entry point for layouts.
3. `runtimePaneMessages.ts` only converts runtime stream events into message actions.
4. `runtimePaneStatus.ts` derives runtime status from messages, the local send phase, and the runtime work execution snapshot.
5. Compatibility fields `paneSession.sending` and `paneSession.waitingForAssistant` must be derived from `paneSession.status`; they must not become independent state again.

## State Source Inventory

| State                              | Single Source                                                                                      | Derived Values / Consumers                                                                                         | Maintenance Rule                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message content and status         | `useWorkbenchPaneSession.messages`                                                                 | `MessageList`, export, file changes, request user input                                                            | Update only through transcript reset or `reduceWorkbenchMessages`                                                                                                                                        |
| Whether the assistant is streaming | `paneSession.status.isAssistantStreaming`                                                          | Desktop/mobile composer pause button, close-task guard                                                             | Derived from the latest `assistant + streaming` message; layouts must not scan messages directly                                                                                                         |
| Local send phase                   | `sendPhase: idle/submitting/awaiting_assistant`                                                    | `status.isSubmitting`, `status.isWaitingForAssistantIndicator`, compatibility fields `sending/waitingForAssistant` | Use `submitting` while the API call is in flight, `awaiting_assistant` after runtime accepts the request, and `idle` after start/done/error or a settled transcript                                      |
| Current runtime execution snapshot | `getRuntimePaneTaskExecution(state.runtimeWork, address)`                                          | `status.taskExecution`, queue advancement, `currentRuntimeTaskRunning`                                             | Read only from `RuntimeWorkListResponse.localTasks[].running/status`                                                                                                                                     |
| Whether the pane is busy           | `paneSession.status.isBusy`                                                                        | Whether the current pane queue may advance                                                                         | Composed from `isSubmitting`, `isAwaitingAssistant`, `isAssistantStreaming`, and `taskExecution.running`                                                                                                 |
| Queued messages                    | `queuedMessages`                                                                                   | `ConversationQueuePanel`, automatic next follow-up send                                                            | Mutate only inside the pane session; advancement must use `status.canSendQueuedMessage`                                                                                                                  |
| Guidance messages                  | `queuedMessages` + local user messages in `messages`                                               | `ConversationQueuePanel`, `MessageList`                                                                            | When guidance sending starts, mark the queued message as `sending` and immediately insert the local user message at the current streaming assistant position; do not wait for the guidance RPC to return |
| Transcript loading and pagination  | `transcriptLoading`, `transcriptHasMoreBefore`, `transcriptBeforeCursor`, `loadedTranscriptRanges` | Infinite scroll, turn navigation                                                                                   | Update only from transcript API responses                                                                                                                                                                |
| Runtime goal                       | `threadGoal` + `pendingGoalState`                                                                  | Goal bar, goal draft, first-message initial goal                                                                   | Persisted goals come from the runtime goal API; goals before task creation live in pending seeds                                                                                                         |
| Answered request user input ids    | `answeredRequestUserInputIds`                                                                      | Hide already submitted or ignored request user input cards                                                         | Update only from submit or ignore actions                                                                                                                                                                |
| Model context usage                | Codex `thread/tokenUsage/updated` runtime stream events                                             | Context-window usage ring and tooltip in the bottom-right composer controls                                        | The executor must forward Codex token usage notifications unchanged; UI stores them only as `projectChat.contextUsage` for the current runtime task                                                       |
| Attachment/model/skill selection   | `projectChat` context                                                                              | Send payload, composer controls                                                                                    | In-task option locking is derived from `projectChat.isOptionsLocked`                                                                                                                                     |
| Device availability                | `state.devices` + current task/project device selection                                            | Composer disabled reason, device prompts                                                                           | Use only for send preconditions; never for assistant streaming status                                                                                                                                    |

## Runtime Event Flow

1. A new message submit sets `sendPhase` to `submitting`.
2. After runtime accepts the request, `sendPhase` becomes `awaiting_assistant`.
3. `chat:start` becomes `assistant_started`; the reducer creates or updates the assistant streaming message and `sendPhase` returns to `idle`.
4. `chat:chunk` and block events update only `messages`.
5. Codex `thread/tokenUsage/updated` events update only `projectChat.contextUsage`; they must not create empty messages or write transcript data.
6. `chat:done`, `chat:error`, and cancellation events settle the assistant message through the reducer and refresh the work list.
7. If runtime work and message state disagree, do not settle it with fallback logic; fix the missing stream event, transcript data, or reducer action.

## Guidance Message Order

Running Codex LocalTasks can send a queued message as native guidance. Guidance is user input inside the current turn, not a new follow-up turn, so the UI must insert the local user message inside the active assistant as soon as guidance sending starts:

1. Mark the matching `queuedMessages` item as `sending` and show the "正在引导当前对话" notice.
2. Create the user message with the same local message id and `createdAt`, then split the current streaming assistant into two messages.
3. Freeze the before-guidance assistant as done and remove its `subtaskId`, so later stream events cannot write into it.
4. Keep the original `subtaskId` on the after-guidance assistant, and insert a `conversation_guidance` tool block first to mark the guidance position.
5. Later `chat:chunk` and `chat:done` events may carry full text, so trim the assistant text prefix recorded at split time before sending them to the reducer.

Do not append the user message to the bottom after guidance succeeds, and do not wait for `runtime.tasks.guidance` to return before splitting the assistant. Assistant text generated while the guidance request is waiting would otherwise appear before the user guidance message, making live streaming order differ from refreshed transcript order.

## Right-Side Temporary Chats

The right workspace **Temporary chat** feature starts a short side conversation next to the current local Codex thread. It is not a fork and it is not a normal runtime task shown in the left task list:

- Each temporary chat tab has an independent `chat:<id>` instance id, so the right workspace can hold multiple temporary chats at the same time.
- UI state lives inside `TemporaryChatPanel`, using the instance id as the `conversationKey` before a runtime thread exists. Hidden temporary chat tabs stay mounted so local messages and input state are not lost when switching tabs.
- The first message calls `createTemporaryRuntimeTask`, creating an `ephemeral` runtime task with the current main thread as `sideSource`. This task does not enter the left task list and does not navigate the main pane.
- Follow-up messages must continue the already loaded temporary thread. The Codex app-server path uses `direct_thread_id` and calls `turn/start` directly; it must not use the normal `resume_thread_id` / `thread/resume` path, because temporary threads do not have rollout mappings and would otherwise fail with `no rollout found`.
- Temporary chats reuse only the current workspace and current thread context. If no main thread source is available, sending should be blocked and the user should be asked to open an existing conversation first.

Maintenance rule: do not add UI fallbacks that insert temporary chats into the left task list, and do not fabricate rollout records for temporary threads in the executor. The primary path is `ephemeral + sideSource + direct_thread_id`.

## Audit Result

- Desktop and mobile layouts no longer scan `messages` directly to decide whether the assistant is streaming; they read `paneSession.status.isAssistantStreaming`.
- Composer disabled state no longer reads independent `paneSession.sending`; it reads `paneSession.status.isSubmitting`.
- Message waiting indicators no longer combine `sending || waitingForAssistant`; they read `paneSession.status.isWaitingForAssistantIndicator`.
- Queue advancement no longer uses scattered `currentRuntimeTask && !busy`; it reads `paneSession.status.canSendQueuedMessage`.
- `currentRuntimeTaskRunning` is derived through `getRuntimePaneTaskExecution`, avoiding another implementation of runtime running lookup.
- `runtimePaneMessages.ts` no longer owns active assistant lookup; status queries are centralized in `runtimePaneStatus.ts`.

## Maintenance Rules

- Add new chat runtime state by extending `RuntimePaneStatus` first, then read it from layouts or components.
- Do not recompute `assistant streaming`, `busy`, or `can send queued message` in layouts.
- Do not add independent `isSending`, `isRunning`, or `isStreaming` React state unless it represents a new external fact source and this document is updated.
- When runtime work and message state disagree, do not override display inside UI components and do not add fallback settlement; fix the primary path.

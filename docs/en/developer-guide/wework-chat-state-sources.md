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

| State | Single Source | Derived Values / Consumers | Maintenance Rule |
| --- | --- | --- | --- |
| Message content and status | `useWorkbenchPaneSession.messages` | `MessageList`, export, file changes, request user input | Update only through transcript reset or `reduceWorkbenchMessages` |
| Whether the assistant is streaming | `paneSession.status.isAssistantStreaming` | Desktop/mobile composer pause button, close-task guard | Derived from the latest `assistant + streaming` message; layouts must not scan messages directly |
| Local send phase | `sendPhase: idle/submitting/awaiting_assistant` | `status.isSubmitting`, `status.isWaitingForAssistantIndicator`, compatibility fields `sending/waitingForAssistant` | Use `submitting` while the API call is in flight, `awaiting_assistant` after runtime accepts the request, and `idle` after start/done/error or a settled transcript |
| Current runtime execution snapshot | `getRuntimePaneTaskExecution(state.runtimeWork, address)` | `status.taskExecution`, queue advancement, `currentRuntimeTaskRunning` | Read only from `RuntimeWorkListResponse.localTasks[].running/status` |
| Whether the pane is busy | `paneSession.status.isBusy` | Whether the current pane queue may advance | Composed from `isSubmitting`, `isAwaitingAssistant`, `isAssistantStreaming`, and `taskExecution.running` |
| Queued messages | `queuedMessages` | `ConversationQueuePanel`, automatic next follow-up send | Mutate only inside the pane session; advancement must use `status.canSendQueuedMessage` |
| Guidance messages | `guidanceMessages` | `ConversationQueuePanel` | Pane-local state; must not participate in composer runtime status |
| Transcript loading and pagination | `transcriptLoading`, `transcriptHasMoreBefore`, `transcriptBeforeCursor`, `loadedTranscriptRanges` | Infinite scroll, turn navigation | Update only from transcript API responses |
| Runtime goal | `threadGoal` + `pendingGoalState` | Goal bar, goal draft, first-message initial goal | Persisted goals come from the runtime goal API; goals before task creation live in pending seeds |
| Answered request user input ids | `answeredRequestUserInputIds` | Hide already submitted or ignored request user input cards | Update only from submit or ignore actions |
| Attachment/model/skill selection | `projectChat` context | Send payload, composer controls | In-task option locking is derived from `projectChat.isOptionsLocked` |
| Device availability | `state.devices` + current task/project device selection | Composer disabled reason, device prompts | Use only for send preconditions; never for assistant streaming status |

## Runtime Event Flow

1. A new message submit sets `sendPhase` to `submitting`.
2. After runtime accepts the request, `sendPhase` becomes `awaiting_assistant`.
3. `chat:start` becomes `assistant_started`; the reducer creates or updates the assistant streaming message and `sendPhase` returns to `idle`.
4. `chat:chunk` and block events update only `messages`.
5. `chat:done`, `chat:error`, and cancellation events settle the assistant message through the reducer and refresh the work list.
6. If runtime work and message state disagree, do not settle it with fallback logic; fix the missing stream event, transcript data, or reducer action.

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

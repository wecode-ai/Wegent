# Responses Session And Result Unification

## Goal

Unify the necessary pre-execution and post-execution infrastructure between:

- native Wegent chat
- `POST /api/v1/responses`

without forcing the two surfaces to share the same transport protocol or frontend rendering model.

This phase focuses on:

1. session/task initialization before dispatch
2. completed-result collection and persistence after dispatch

It does not attempt to unify:

- WebSocket/block streaming events used by native chat
- OpenAI-compatible SSE events used by `responses`
- frontend rendering models

## Current Problems

### Session Initialization Is Split

Native chat task creation goes through shared chat storage helpers such as:

- `create_new_task`
- `create_assistant_subtask`
- `build_initial_task_knowledge_base_refs`

`responses` currently uses `setup_chat_session()` and re-implements task/workspace/session creation logic locally.

Consequences:

- task-level `knowledgeBaseRefs` are not initialized consistently
- task metadata and labels can drift
- follow-up session semantics are harder to keep aligned

### Completed Result Persistence Is Split

Native chat completion is effectively handled through `StatusUpdatingEmitter`, which:

- preserves existing result fields
- adds `blocks`
- uses accumulated content as fallback

`responses` still has endpoint-local completion logic for non-streaming and background cases, and streaming completion only partially aligns with native chat richer results.

Consequences:

- `responses` completion can lose `blocks`, `messages_chain`, `reasoning_content`, and other richer fields
- `stream=false/background` remain text-only in persistence
- future fixes risk further divergence

## Design Principles

1. Unify infrastructure, not API shells.
2. Prefer reusing existing chat storage and completion logic over re-implementing it in `responses`.
3. Make richer result persistence the shared default.
4. Keep `stream=false/background` minimally compatible in this phase, but do not let them block shared result infrastructure.

## Target Architecture

### 1. Shared Session Initializer

Add a shared lifecycle service:

- `app/services/chat/trigger/lifecycle.py`

Primary entrypoint:

- `prepare_execution_session(...)`

Responsibilities:

- create or fetch task
- create workspace
- create user and assistant subtasks
- upgrade Placeholder tasks when needed
- write task metadata/labels consistently
- initialize task-level `knowledgeBaseRefs`
- return a single session setup result for downstream execution request building

The service should reuse existing lower-level helpers where possible:

- `create_new_task`
- `create_assistant_subtask`
- `build_initial_task_knowledge_base_refs`

### 2. Shared Completed Result Services

Add the completed-result helpers to the shared lifecycle service:

- `app/services/chat/trigger/lifecycle.py`

Primary entrypoints:

- `collect_completed_result(...)`
- `persist_completed_result(...)`

`collect_completed_result(...)` responsibilities:

- merge richer executor result with runtime fallbacks
- preserve existing result fields such as `silent_exit`
- add `value` when missing
- add `blocks` when missing via `session_manager.finalize_and_get_blocks(...)`

Target result shape for this phase:

- `value`
- `reasoning_content`
- `messages_chain`
- `loaded_skills`
- `blocks`

`persist_completed_result(...)` responsibilities:

- update subtask status/result
- update task status/result
- handle `COMPLETED`, `FAILED`, and `CANCELLED`

This shared writer should be used by both:

- native chat completion path
- `responses` completion path

### 3. Responses Integration

#### `stream=true`

`responses` streaming should continue to emit its own SSE protocol, but completion should no longer construct result persistence locally.

Instead it should:

- capture `event.result` on `DONE`
- pass richer result plus accumulated fallbacks into `collect_completed_result(...)`
- persist via `persist_completed_result(...)`

#### `stream=false/background`

This phase does not require full OpenAI-style output parity for non-streaming modes.

However they should:

- stop persisting text-only completion results through endpoint-local ad hoc logic
- use the same shared completed-result writer

This keeps persistence aligned even before final API output shapes are expanded.

### 4. Native Chat Integration

Native chat should keep its existing protocol behavior, but move its completed-result assembly and persistence to the same shared services.

`StatusUpdatingEmitter` should remain the execution wrapper, but delegate result collection/persistence to:

- `collect_completed_result(...)`
- `persist_completed_result(...)`

## Non-Goals

This phase does not include:

- full `response.output` parity for non-streaming `responses`
- unifying chat and responses transport protocols
- changing frontend rendering contracts
- forcing immediate `output_items` persistence

## Implementation Plan

### Step 1. Introduce Shared Session Initializer

- add `trigger/lifecycle.py`
- move or wrap common task/workspace/subtask creation behavior there
- migrate `responses setup_chat_session()` to use it

Priority behavior to align:

- task-level `knowledgeBaseRefs`
- task labels and metadata
- Placeholder upgrade path

### Step 2. Introduce Shared Completed Result Services

- add completed-result helpers into `trigger/lifecycle.py`
- extract result merging/preservation logic from `StatusUpdatingEmitter`
- expose collector and persistence helpers

### Step 3. Migrate Native Chat Completion

- update `StatusUpdatingEmitter` to delegate completed/failed/cancelled result handling

### Step 4. Migrate Responses Completion

- remove endpoint-local result assembly where possible
- delegate both streaming and non-streaming completion to shared services

## Testing

### Session Initialization

- `responses` task creation includes the same task-level `knowledgeBaseRefs` behavior as native chat
- Placeholder upgrade behavior remains intact

### Completed Result Persistence

- native chat completion still persists `blocks`
- `responses stream=true` persists richer result fields
- `responses stream=false/background` persist through the same writer
- existing fields such as `silent_exit` are preserved

### Regression Coverage

- no regression in native chat completion behavior
- no regression in `responses` streaming protocol
- no regression in background task final status updates

## Recommended Rollout Order

1. shared session initializer
2. shared completed result collector/writer
3. native chat completion migration
4. `responses stream=true` completion migration
5. `responses stream=false/background` completion migration

This order first closes the most visible product gap:

- inconsistent knowledge base/session initialization

then closes the most important data-model gap:

- divergent completed result persistence

# Fix Code Subtask ID Assignment Bug Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the bug where follow-up messages in coding scenarios (ClaudeCode/Agno) overwrite the previous bot message instead of creating a new one.

**Architecture:** The fix involves two coordinated changes: (1) Executor sends `response.created` instead of `response.in_progress` to signal start of new message, and (2) Backend converts `response.created` to START event instead of skipping it.

**Tech Stack:** Python, FastAPI, Socket.IO, WebSocket, OpenAI Responses API

---

## Task 1: Modify Executor to Send response.created Event

**Files:**
- Modify: `executor/modes/local/runner.py:420-421`

**Step 1: Update the emitter call**

Change from `in_progress()` to `start()`:

```python
# Report task started via emitter (response.created)
# This is crucial for follow-up messages in coding scenarios (ClaudeCode/Agno)
# where the executor stays running and handles multiple messages.
# The start() method sends response.created which triggers the frontend to create a new message.
await ws_emitter.start()
```

**Step 2: Verify the change**

Check that `start()` method exists on `ResponsesAPIEmitter`:
- File: `shared/models/responses_api_emitter.py:93`
- Method: `async def start(self, shell_type: Optional[str] = None)`
- Sends: `ResponsesAPIStreamEvents.RESPONSE_CREATED.value`

**Step 3: Commit**

```bash
git add executor/modes/local/runner.py
git commit -m "fix(executor): send response.created instead of response.in_progress

This fixes follow-up messages in coding scenarios where the executor
stays running. The response.created event is converted to START event
by the backend, triggering the frontend to create a new message."
```

---

## Task 2: Modify Backend to Handle response.created Event

**Files:**
- Modify: `backend/app/services/execution/dispatcher.py:212-221`

**Step 1: Extract RESPONSE_CREATED from skip list**

Current code (lines 212-221):
```python
elif event_type in (
    ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
    ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
    ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
    ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
    ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
    ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
):
    # These are lifecycle events, skip them
    return None
```

**Step 2: Add separate handler for RESPONSE_CREATED**

Insert before the skip list (around line 212):

```python
elif event_type == ResponsesAPIStreamEvents.RESPONSE_CREATED.value:
    # response.created -> START
    # This is crucial for follow-up messages in coding scenarios (ClaudeCode/Agno)
    # where the executor stays running and handles multiple messages.
    # Without this, the frontend won't create a new message for subsequent responses.
    response_data = data.get("response", {})
    return ExecutionEvent(
        type=EventType.START,
        task_id=task_id,
        subtask_id=subtask_id,
        message_id=message_id,
        data={
            "shell_type": data.get("shell_type"),
            "model": response_data.get("model"),
        },
    )

elif event_type in (
    ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
    ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
    ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
    ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
    ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
):
    # These are lifecycle events, skip them
    return None
```

**Step 3: Verify imports**

Ensure `EventType` is imported:
- Check: `from shared.models import EventType, ExecutionEvent` (line ~30)

**Step 4: Commit**

```bash
git add backend/app/services/execution/dispatcher.py
git commit -m "fix(backend): convert response.created to START event

This ensures the frontend receives chat:start events for all messages,
including follow-ups in coding scenarios where the executor stays running.
Without this, follow-up messages would not create new message entries."
```

---

## Task 3: Run Tests

**Step 1: Run backend tests**

```bash
cd /Users/jiangyang7/Developer/github/Wegent/backend
uv run pytest tests/services/execution/ -v -k "dispatcher or emitter" --tb=short
```

Expected: All tests pass

**Step 2: Run shared tests**

```bash
cd /Users/jiangyang7/Developer/github/Wegent/shared
uv run pytest tests/ -v --tb=short
```

Expected: All tests pass

**Step 3: Run executor tests**

```bash
cd /Users/jiangyang7/Developer/github/Wegent/executor
uv run pytest tests/ -v --tb=short
```

Expected: All tests pass

**Step 4: Commit test results**

```bash
git add -A
git commit -m "test: verify all tests pass after subtask_id fix"
```

---

## Task 4: Manual Testing Guide

**Test Scenario: Coding scenario with multiple messages**

1. Create a coding task (ClaudeCode shell type)
2. Send first message: "Hello"
3. Wait for AI response to complete
4. Send second message: "Tell me more"
5. **Expected behavior:**
   - Second AI message appears as a new message (not overwriting first)
   - Both messages show correctly in the chat
   - No "generating" state stuck

**Verification points:**
- Check browser console for WebSocket events
- Look for `chat:start` event with correct `subtask_id`
- Verify frontend creates new message entry for second response

---

## Summary

The fix involves two coordinated changes:

1. **Executor** (`executor/modes/local/runner.py:421`): Change `ws_emitter.in_progress()` to `ws_emitter.start()` to send `response.created` event

2. **Backend** (`backend/app/services/execution/dispatcher.py:212-221`): Add handler to convert `response.created` to `START` event instead of skipping it

This ensures follow-up messages in coding scenarios properly trigger the frontend to create new message entries, preventing the "overwrite" bug.

---
sidebar_position: 16
---

# Session-level Working Directory (Local Executor)

This document turns the proposal “Local device executor (ClaudeCode) supports different working directories per session” into an implementable product + engineering design, including current behavior, goals, data contracts, security boundaries, and a phased delivery plan.

---

## Background

Wegent already supports running Claude Code as a Local Executor on the user’s computer. Today, code, attachments, Claude config, and some session state are stored under `LOCAL_WORKSPACE_ROOT/<task_id>/`, and the Claude SDK client is created with a `cwd`.

Need: users want different sessions to run in different directories, e.g.:

- Session A runs in directory A (e.g. `~/Projects/A`)
- Session B runs in directory B (e.g. `~/Projects/B`)

---

## Current State (Code Summary)

### Where `cwd` comes from

- Backend dispatch payload (`task_data`) does **not** include a working directory field today; it is built in `backend/app/services/adapters/executor_kinds.py` (`_format_subtasks_response()`).
- Local mode workspace root is defined in `executor/config/config.py`:
  - `LOCAL_WORKSPACE_ROOT` (default `~/.wegent-executor/workspace`)
  - `get_workspace_root()` returns `LOCAL_WORKSPACE_ROOT` when running in local mode
- ClaudeCode `cwd` is currently determined by:
  1) bot config: `executor/agents/claude_code/config_manager.py` (`extract_claude_options()`) can read `cwd` from bot_config and set `options["cwd"]`
  2) fallback: `executor/agents/claude_code/claude_code_agent.py` (`_create_and_connect_client()`) falls back to `WORKSPACE_ROOT/<task_id>/` when `options["cwd"]` is empty

### Components coupled to `WORKSPACE_ROOT/<task_id>/`

- Git clone: `executor/agents/base.py` (`download_code()`) clones into `WORKSPACE_ROOT/<task_id>/<repo_name>/`
- Attachments: `executor/agents/claude_code/attachment_handler.py` downloads into `WORKSPACE_ROOT/<task_id>/`
- Session file: `executor/agents/claude_code/session_manager.py` stores `.claude_session_id` in `WORKSPACE_ROOT/<task_id>/`
- Claude config directory (local strategy): `executor/agents/claude_code/local_mode_strategy.py` uses `WORKSPACE_ROOT/<task_id>/.claude/`

Conclusion: per-`task_id` isolation exists, but binding a session to an arbitrary local directory is not wired end-to-end yet, and multiple artifacts still default to `WORKSPACE_ROOT/<task_id>/`.

---

## Goals & Non-goals

### Goals

- Allow a **per-session (Task)** working directory (Workdir) and make the Local Executor use it as Claude’s `cwd`
- Bind workdir to the device (paths are local-device concepts)
- Enforce security: treat paths as untrusted input; implement allowlist + escape prevention
- Backward compatible: tasks without workdir keep current behavior

### Non-goals

- Phase 1 will not fully relocate all artifacts (clone/attachments/session files) into the user directory; it focuses on Claude `cwd` first
- No cross-device “local path sync” in the backend; local paths only make sense on the device that owns them

---

## Product Design (Proposed)

### Binding model

- Binding key: `(task_id, device_id)`
- Show workdir in task details and reuse it when continuing the same task on the same device

### Policies

Provide three policies (default to the first):

1) **Managed**: keep `LOCAL_WORKSPACE_ROOT/<task_id>/`
2) **Existing**: user selects an existing absolute local path (e.g. `~/Projects/foo`)
3) **Repo Bound** (later): bind `(git_url, branch)` to a local directory for quick reuse

### Switching behavior

When workdir changes for a running session:

- trigger `close-session` (end the old Claude session/process)
- create a new Claude client with the new workdir (avoid reusing the old session with mismatched paths)

---

## Security (Required)

### Device-side allowlist roots

Paths must be considered untrusted. The Local Executor should be configured with allowed roots:

- New env var: `LOCAL_WORKDIR_ALLOWED_ROOTS`
- Example: `LOCAL_WORKDIR_ALLOWED_ROOTS="~/.wegent-executor/workspace,~/Projects"`
- Default: only `LOCAL_WORKSPACE_ROOT`

### Path validation (recommended)

Before resolving into an effective cwd:

- normalize: expand `~`, convert to absolute, apply `realpath` (resolve symlinks)
- prevent escape: reject paths not under allowed roots (including symlink escape)
- optional: hard-deny sensitive system locations as an extra guardrail

Failure policy: fall back to `Managed` (`WORKSPACE_ROOT/<task_id>/`) and clearly report the reason via thinking/progress.

---

## Engineering Design (Proposed)

### Backend → Local Executor data contract

Phase 1 adds fields to `task_data` (example):

```json
{
  "task_id": 123,
  "device_id": "mac-mini-1",
  "workdir": "/Users/alice/Projects/foo",
  "workdir_policy": "existing"
}
```

The same values can be persisted in the Task CRD spec for reuse when continuing on the same device, but should not be treated as cross-device truth.

### Executor entry point

Introduce a single-responsibility module (suggested):

- `executor/utils/workdir_resolver.py`
  - inputs: `task_id`, `device_id`, `requested_workdir`, `policy`, `LOCAL_WORKDIR_ALLOWED_ROOTS`
  - output: `effective_cwd` (string) plus optional warnings/errors

Then inject `effective_cwd` into:

- Claude options `cwd`
- Phase 2 relocation targets (clone/attachments/session persistence)

---

## Phased Delivery Plan

### Phase 1 (MVP): session-level `cwd`

Goal: “Session A in dir A / Session B in dir B”, ensuring Claude `cwd` is correct.

- Backend
  - extend `TaskCreate` to accept `workdir/workdir_policy` (only for local device execution)
  - persist fields into Task CRD spec (together with `device_id`)
  - dispatch fields via `_format_subtasks_response()` into `task_data`
- Executor
  - implement allowlist + normalization + escape prevention
  - prefer `task_data.workdir` over bot default `cwd`
  - fallback to `Managed` on validation failure
- Frontend
  - add workdir selection for local device execution (Managed / Existing)
  - display current workdir (read-only)
- Tests
  - executor: path resolution + escape-prevention unit tests (critical)
  - backend: end-to-end field plumbing tests (create → spec → dispatch)

### Phase 2: align artifacts with workdir

Goal: remove the “cwd in user dir but artifacts elsewhere” split.

- clone: in `Existing/RepoBound`, clone/reuse into workdir (verify remote matches `git_url`)
- attachments: download into `workdir/.wegent/attachments/...`
- session files: move into `workdir/.wegent/session/...` with a one-time migration read from the old location
- Claude config: place `.claude/` under workdir (or redirect via `CLAUDE_CONFIG_DIR`)

### Phase 3: UX enhancements

- recent directories list (frontend local storage)
- repo → local directory bindings (device settings)
- “open directory” shortcut (optional, depending on product security stance)

---

## Phase 1 Acceptance Criteria

- On the same device, two tasks can run with different workdirs; Claude `cwd` is correct and sessions do not interfere
- If workdir is outside allowlist, no writes happen there and the user sees a clear fallback message
- Tasks without workdir remain unchanged (backward compatibility)


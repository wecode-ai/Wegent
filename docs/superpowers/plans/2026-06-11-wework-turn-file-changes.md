---
sidebar_position: 1
---

# Wework Per-Turn File Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Codex 和 Claude 的每轮代码执行生成独立文件变更集，并在 Wework 中提供摘要、在线 Diff 审核和冲突安全的单轮撤销。

**Architecture:** executor 使用临时 Git index 在 turn 前后生成 tree，并把 binary patch 压缩保存在设备 artifact 目录；统一 `ResponsesAPIEmitter.done()` completion provider 把轻量摘要送到 Backend。Backend 将摘要持久化到 `Subtask.result.file_changes`，通过受控设备命令读取或反向应用 artifact；Wework 从实时和历史消息的同一字段渲染文件卡片。

**Tech Stack:** Python 3.12、Git CLI、FastAPI、SQLAlchemy、Socket.IO、React 19、TypeScript、Vitest、pytest。

---

## File Structure

### Shared

- Modify: `shared/models/responses_api_emitter.py`
  - 为 `done()` 增加一次性异步 completion fields provider。
- Modify: `shared/tests/test_emitter_factory.py`
  - 验证 provider 的字段合并、空结果和异常隔离。

### Executor

- Create: `executor/services/turn_file_changes.py`
  - 负责临时 Git index、tree 快照、patch、统计、artifact metadata 和 workspace lock。
- Create: `executor/tests/services/test_turn_file_changes.py`
  - 覆盖已有脏状态、连续轮次、无 HEAD、新建/删除/重命名/二进制及反向 patch。
- Modify: `executor/agents/base.py`
  - 提供安装 tracker completion provider 的共享方法。
- Modify: `executor/agents/codex/codex_agent.py`
  - 在 Codex turn 启动前捕获快照。
- Modify: `executor/agents/claude_code/claude_code_agent.py`
  - 在 Claude query 前捕获快照。
- Modify: `executor/tests/agents/test_codex_event_mapper.py`
  - 验证 Codex 完成事件包含 provider 生成的字段。
- Modify: `executor/tests/agents/test_claude_response_processor.py`
  - 验证 Claude 成功完成包含相同字段，失败不 finalize。

### Backend

- Create: `backend/app/schemas/turn_file_changes.py`
  - 定义摘要、Diff 和撤销响应 schema。
- Create: `backend/app/services/turn_file_changes.py`
  - 负责鉴权、artifact 命令调用和 `Subtask.result` 状态更新。
- Create: `backend/tests/services/test_turn_file_changes_service.py`
  - 覆盖审核、撤销、冲突、离线、缺失 artifact 和幂等。
- Modify: `backend/app/services/device/command_registry.py`
  - 注册受控 artifact review/revert Python 命令。
- Modify: `backend/tests/services/test_local_device_command_service.py`
  - 验证命令参数和路径不能逃逸。
- Modify: `backend/app/api/endpoints/subtasks.py`
  - 增加 Diff 与撤销 API。
- Create: `backend/tests/api/endpoints/test_subtask_file_changes.py`
  - 覆盖 API 鉴权、错误码和响应。
- Modify: `backend/tests/services/chat/trigger/test_lifecycle_completed_result.py`
  - 验证 `file_changes` 与 `value`、`blocks` 一起持久化。

### Wework

- Modify: `wework/src/types/api.ts`
  - 增加 wire 类型。
- Modify: `wework/src/types/workbench.ts`
  - 增加 UI 状态类型和 `WorkbenchMessage.fileChanges`。
- Modify: `wework/src/api/tasks.ts`
  - 增加审核和撤销请求。
- Modify: `wework/src/features/workbench/messageReducer.ts`
  - 实时完成和撤销后更新消息文件状态。
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
  - 归一化历史/实时摘要并暴露审核、撤销方法。
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
  - 覆盖实时、刷新恢复和撤销状态更新。
- Create: `wework/src/components/chat/FileChangesCard.tsx`
  - 显示统计、前三项、展开、状态和操作。
- Create: `wework/src/components/chat/FileChangesReviewDialog.tsx`
  - 按文件展示 unified diff。
- Create: `wework/src/components/chat/FileChangesCard.test.tsx`
  - 覆盖卡片交互和设备离线行为。
- Modify: `wework/src/components/chat/MessageList.tsx`
  - 把文件卡片接到 assistant 消息底部。
- Modify: `wework/src/components/chat/MessageList.test.tsx`
  - 验证消息集成。
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`

### Documentation

- Create: `docs/zh/user-guide/coding/turn-file-changes.md`
- Create: `docs/en/user-guide/coding/turn-file-changes.md`

---

### Task 1: Add Completion Fields Provider to the Unified Emitter

**Files:**
- Modify: `shared/models/responses_api_emitter.py`
- Modify: `shared/tests/test_emitter_factory.py`

- [ ] **Step 1: Write failing emitter tests**

Add tests that configure an async provider and assert that its fields are included
in `response.completed`:

```python
@pytest.mark.asyncio
async def test_done_merges_completion_provider_fields():
    emitted = []
    emitter = ResponsesAPIEmitter(
        task_id=1,
        subtask_id=2,
        transport=RecordingTransport(emitted),
    )

    async def completion_fields():
        return {"file_changes": {"version": 1, "file_count": 2}}

    emitter.set_completion_fields_provider(completion_fields)
    await emitter.done(content="done")

    completed = emitted[-1][1]
    assert completed["response"]["file_changes"] == {
        "version": 1,
        "file_count": 2,
    }
```

Also add:

```python
@pytest.mark.asyncio
async def test_done_ignores_empty_completion_provider_fields():
    emitted = []
    emitter = ResponsesAPIEmitter(
        task_id=1,
        subtask_id=2,
        transport=RecordingTransport(emitted),
    )
    emitter.set_completion_fields_provider(lambda: {})

    await emitter.done(content="done")

    completed = emitted[-1][1]["response"]
    assert "file_changes" not in completed

@pytest.mark.asyncio
async def test_done_logs_provider_failure_and_still_emits_completion():
    emitted = []
    emitter = ResponsesAPIEmitter(
        task_id=1,
        subtask_id=2,
        transport=RecordingTransport(emitted),
    )

    async def fail():
        raise RuntimeError("snapshot failed")

    emitter.set_completion_fields_provider(fail)
    await emitter.done(content="done")

    assert emitted[-1][1]["response"]["output_text"] == "done"
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cd shared
uv run pytest tests/test_emitter_factory.py -k completion_provider -v
```

Expected: FAIL because `set_completion_fields_provider` does not exist.

- [ ] **Step 3: Implement the provider API**

In `ResponsesAPIEmitter`, define:

```python
CompletionFieldsProvider = Callable[
    [],
    Union[
        dict[str, Any],
        Awaitable[dict[str, Any]],
    ],
]
```

Initialize:

```python
self._completion_fields_provider: Optional[CompletionFieldsProvider] = None
```

Add:

```python
def set_completion_fields_provider(
    self,
    provider: Optional[CompletionFieldsProvider],
) -> None:
    self._completion_fields_provider = provider
```

Before calling `builder.response_completed`, call the provider once, await it when
necessary, and merge non-empty fields without overwriting explicit `done()`
arguments:

```python
provider_fields: dict[str, Any] = {}
provider = self._completion_fields_provider
self._completion_fields_provider = None
if provider is not None:
    try:
        candidate = provider()
        if inspect.isawaitable(candidate):
            candidate = await candidate
        if isinstance(candidate, dict):
            provider_fields = candidate
    except Exception:
        logger.exception("Failed to collect response completion fields")

for key, value in provider_fields.items():
    extra_fields.setdefault(key, value)
```

- [ ] **Step 4: Run shared tests**

Run:

```bash
cd shared
uv run pytest tests/test_emitter_factory.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/models/responses_api_emitter.py shared/tests/test_emitter_factory.py
git commit -m "feat(shared): support response completion field providers"
```

---

### Task 2: Build the Git Turn Snapshot and Artifact Service

**Files:**
- Create: `executor/services/turn_file_changes.py`
- Create: `executor/tests/services/test_turn_file_changes.py`

- [ ] **Step 1: Write snapshot behavior tests**

Create repositories in `tmp_path` with real Git commands. Start with:

```python
@pytest.mark.asyncio
async def test_tracker_excludes_changes_that_preexist_the_turn(tmp_path):
    repo = init_repo(tmp_path)
    write(repo / "existing.txt", "base\n")
    commit_all(repo, "initial")

    write(repo / "existing.txt", "user dirty\n")
    write(repo / "untracked.txt", "before\n")

    tracker = TurnFileChangeTracker(
        workspace=repo,
        task_id=10,
        subtask_id=20,
        executor_home=tmp_path / "executor-home",
    )
    await tracker.start()

    write(repo / "agent.txt", "created by agent\n")
    summary = await tracker.finalize()

    assert [item["path"] for item in summary["file_changes"]["files"]] == [
        "agent.txt"
    ]
```

Add focused tests for:

```python
test_tracker_counts_modified_created_deleted_and_renamed_files
test_tracker_supports_repository_without_head
test_tracker_marks_binary_files_without_line_counts
test_tracker_writes_gzip_patch_and_metadata_checksum
test_tracker_returns_empty_fields_when_workspace_is_not_git
test_tracker_reverse_patch_restores_only_the_turn
test_tracker_does_not_change_real_git_index
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd executor
uv run pytest tests/services/test_turn_file_changes.py -v
```

Expected: FAIL because `TurnFileChangeTracker` is missing.

- [ ] **Step 3: Implement focused data types and command runner**

In `turn_file_changes.py`, define:

```python
@dataclass(frozen=True)
class GitTreeSnapshot:
    tree_id: str


@dataclass(frozen=True)
class TurnFileArtifact:
    artifact_id: str
    patch_path: Path
    metadata_path: Path
    checksum: str
```

Use a private command helper that always passes argv and environment explicitly:

```python
def _run_git(
    workspace: Path,
    *args: str,
    env: Optional[dict[str, str]] = None,
    text: bool = True,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(workspace), *args],
        check=True,
        capture_output=True,
        env={**os.environ, **(env or {})},
        text=text,
    )
```

- [ ] **Step 4: Implement tree capture with a temporary index**

Implement `_capture_tree()`:

```python
with tempfile.TemporaryDirectory(prefix="wegent-turn-index-") as temp_dir:
    index_path = Path(temp_dir) / "index"
    env = {"GIT_INDEX_FILE": str(index_path)}
    if _has_head(workspace):
        _run_git(workspace, "read-tree", "HEAD", env=env)
    _run_git(workspace, "add", "--all", "--", ".", env=env)
    tree_id = _run_git(workspace, "write-tree", env=env).stdout.strip()
    return GitTreeSnapshot(tree_id=tree_id)
```

Use `git check-ignore` semantics supplied by `git add --all`; ignored files must
remain absent. Do not run `git reset`, `git stash`, or commands against the real
index.

- [ ] **Step 5: Implement patch and summary generation**

Generate:

```bash
git diff --binary --find-renames "$before_tree" "$after_tree"
git diff --numstat --find-renames "$before_tree" "$after_tree"
git diff --name-status --find-renames "$before_tree" "$after_tree"
```

Parse rename records and numstat into:

```python
{
    "old_path": "src/old.ts",
    "path": "src/new.ts",
    "change_type": "renamed",
    "additions": 3,
    "deletions": 1,
    "binary": False,
}
```

For numstat `-\t-\tpath`, set `binary=True`, additions and deletions to zero.

- [ ] **Step 6: Implement artifact persistence**

Resolve artifacts only beneath:

```python
executor_home / "artifacts" / "turn-file-changes" / str(task_id) / str(subtask_id)
```

Write `changes.patch.gz` and `metadata.json` atomically using temporary files and
`Path.replace()`. Metadata must include:

```python
{
    "version": 1,
    "task_id": task_id,
    "subtask_id": subtask_id,
    "workspace_path": str(workspace.resolve()),
    "checksum": sha256(patch_bytes).hexdigest(),
}
```

Return only:

```python
{
    "file_changes": {
        "version": 1,
        "status": "active",
        "artifact_id": f"turn-file-changes/{task_id}/{subtask_id}",
        "device_id": device_id,
        "workspace_path": str(workspace.resolve()),
        "file_count": len(files),
        "additions": total_additions,
        "deletions": total_deletions,
        "files": files,
        "reverted_at": None,
    }
}
```

If the patch is empty, return `{}` and do not create an artifact.

- [ ] **Step 7: Add workspace locking**

Use a lock file in the Git common directory:

```text
$(git rev-parse --git-common-dir)/wegent-turn-file-changes.lock
```

Implement cross-platform exclusive creation with:

```python
lock_fd = os.open(
    lock_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    0o600,
)
```

Store task/subtask metadata in the file. Remove the lock in `finalize()` and
`abort()`. If the lock already exists, fail before the agent turn with a clear
workspace-busy error instead of producing an untrustworthy diff.

Write `pid`, `hostname`, and `created_at` into the lock. When acquisition finds an
existing lock from the same host whose PID no longer exists, remove that stale
lock and retry once. Never steal a lock owned by a live process or another host.

- [ ] **Step 8: Run tracker tests**

Run:

```bash
cd executor
uv run pytest tests/services/test_turn_file_changes.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add executor/services/turn_file_changes.py executor/tests/services/test_turn_file_changes.py
git commit -m "feat(executor): capture per-turn git file changes"
```

---

### Task 3: Attach the Tracker to Codex and Claude Turns

**Files:**
- Modify: `executor/agents/base.py`
- Modify: `executor/agents/codex/codex_agent.py`
- Modify: `executor/agents/claude_code/claude_code_agent.py`
- Modify: `executor/tests/agents/test_codex_event_mapper.py`
- Modify: `executor/tests/agents/test_claude_response_processor.py`

- [ ] **Step 1: Write failing agent integration tests**

For Codex, inject a fake tracker and assert:

```python
tracker.start.assert_awaited_once()
tracker.finalize.assert_awaited_once()
completed_response["file_changes"]["file_count"] == 1
```

For Claude, cover successful and failed `ResultMessage`:

```python
@pytest.mark.asyncio
async def test_claude_success_finalizes_turn_file_changes():
    emitter = create_recording_emitter()
    tracker = AsyncMock()
    tracker.finalize.return_value = {
        "file_changes": {"version": 1, "file_count": 1}
    }
    emitter.set_completion_fields_provider(tracker.finalize)

    status = await process_success_result(emitter)

    assert status == TaskStatus.COMPLETED
    tracker.finalize.assert_awaited_once()
    assert completed_payload(emitter)["file_changes"]["file_count"] == 1


@pytest.mark.asyncio
async def test_claude_failure_aborts_turn_file_changes_without_summary():
    emitter = create_recording_emitter()
    tracker = AsyncMock()
    emitter.set_completion_fields_provider(tracker.finalize)

    status = await process_failed_result(emitter)

    assert status == TaskStatus.FAILED
    tracker.finalize.assert_not_awaited()
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd executor
uv run pytest \
  tests/agents/test_codex_event_mapper.py \
  tests/agents/test_claude_response_processor.py \
  -k "file_changes" -v
```

Expected: FAIL because agents do not install a tracker.

- [ ] **Step 3: Add shared tracker lifecycle to `Agent`**

Add fields:

```python
self.turn_file_change_tracker: Optional[TurnFileChangeTracker] = None
```

Add:

```python
async def start_turn_file_change_tracking(self) -> None:
    if not self.project_path:
        return
    tracker = TurnFileChangeTracker(
        workspace=Path(self.project_path),
        task_id=self.task_id,
        subtask_id=self.subtask_id,
        executor_home=Path(config.WEGENT_EXECUTOR_HOME),
        device_id=getattr(self.task_data, "device_id", None),
    )
    if await tracker.start():
        self.turn_file_change_tracker = tracker
        self.emitter.set_completion_fields_provider(tracker.finalize)

async def abort_turn_file_change_tracking(self) -> None:
    if self.turn_file_change_tracker:
        await self.turn_file_change_tracker.abort()
```

When `update_emitter()` creates a new emitter, clear the old tracker/provider.

- [ ] **Step 4: Start tracking immediately before each SDK turn**

In Codex `execute_async()`, call `start_turn_file_change_tracking()` after thread
creation and before `_thread.turn`.

In Claude `_async_execute()`, call it after project path preparation and before
`client.query`.

In both `except` and cancellation paths, call `abort_turn_file_change_tracking()`.
The completion provider is invoked only by successful `emitter.done()`.

- [ ] **Step 5: Keep native Codex diff as diagnostics only**

Update `CodeXEventMapper` to record the latest `turn/diff/updated` string for debug
comparison, but do not send it as the persisted result:

```python
if method == "turn/diff/updated":
    self.native_turn_diff = str(getattr(payload, "diff", "") or "")
    return None
```

Log only byte counts and mismatch status; never log full patch text.

- [ ] **Step 6: Run agent tests**

Run:

```bash
cd executor
uv run pytest \
  tests/agents/test_codex_event_mapper.py \
  tests/agents/test_claude_response_processor.py \
  tests/services/test_turn_file_changes.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add \
  executor/agents/base.py \
  executor/agents/codex/codex_agent.py \
  executor/agents/claude_code/claude_code_agent.py \
  executor/agents/codex/event_mapper.py \
  executor/tests/agents/test_codex_event_mapper.py \
  executor/tests/agents/test_claude_response_processor.py
git commit -m "feat(executor): attach file change tracking to coding turns"
```

---

### Task 4: Add Controlled Device Artifact Commands

**Files:**
- Modify: `backend/app/services/device/command_registry.py`
- Modify: `backend/tests/services/test_local_device_command_service.py`

- [ ] **Step 1: Write failing command registry tests**

Add tests that resolve:

```python
review = resolve_local_device_command("turn_file_changes_review", {})
revert = resolve_local_device_command("turn_file_changes_revert", {})
assert review.post_processor == "json"
assert revert.post_processor == "json"
```

Add execution tests that pass malicious IDs such as:

```text
../../etc/passwd
turn-file-changes/1/2/../../../secret
```

Expected command result: non-zero with `invalid artifact id`.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd backend
uv run pytest tests/services/test_local_device_command_service.py -k turn_file_changes -v
```

Expected: FAIL because command keys are unknown.

- [ ] **Step 3: Add one reusable artifact Python script**

Add a `TURN_FILE_CHANGES_SCRIPT` constant that:

1. Accepts mode `review` or `revert`.
2. Validates artifact ID using:

```python
re.fullmatch(r"turn-file-changes/([1-9][0-9]*)/([1-9][0-9]*)", artifact_id)
```

3. Resolves the path below:

```python
Path(os.environ.get("WEGENT_EXECUTOR_HOME", "~/.wegent-executor")).expanduser()
    / "artifacts"
    / artifact_id
```

4. Rejects any resolved path outside the artifact root.
5. Loads metadata and verifies task, subtask, workspace and SHA-256.
6. Caps decompressed patch size at 20 MiB.
7. In review mode returns:

```json
{"success": true, "diff": "diff --git a/src/a.ts b/src/a.ts\n"}
```

8. In revert mode runs, in the provided cwd:

```bash
git apply --reverse --check --binary /tmp/wegent-validated-turn.patch
git apply --reverse --binary /tmp/wegent-validated-turn.patch
```

and returns one of:

```json
{"success": true, "status": "reverted"}
{"success": false, "status": "conflicted", "error": "patch does not apply"}
```

- [ ] **Step 4: Register two command keys**

Register:

```python
"turn_file_changes_review": LocalDeviceCommandDefinition(
    command=f"python3 -c {shlex.quote(TURN_FILE_CHANGES_SCRIPT)} review",
    post_processor="json",
),
"turn_file_changes_revert": LocalDeviceCommandDefinition(
    command=f"python3 -c {shlex.quote(TURN_FILE_CHANGES_SCRIPT)} revert",
    post_processor="json",
),
```

The Backend supplies `artifact_id` as the only argument and sets `path` to the
stored workspace. Do not accept a workspace path from Wework.

- [ ] **Step 5: Run command tests**

Run:

```bash
cd backend
uv run pytest tests/services/test_local_device_command_service.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  backend/app/services/device/command_registry.py \
  backend/tests/services/test_local_device_command_service.py
git commit -m "feat(backend): add turn file artifact device commands"
```

---

### Task 5: Persist, Review, and Revert File Change Sets in Backend

**Files:**
- Create: `backend/app/schemas/turn_file_changes.py`
- Create: `backend/app/services/turn_file_changes.py`
- Create: `backend/tests/services/test_turn_file_changes_service.py`
- Modify: `backend/app/api/endpoints/subtasks.py`
- Create: `backend/tests/api/endpoints/test_subtask_file_changes.py`
- Modify: `backend/tests/services/chat/trigger/test_lifecycle_completed_result.py`

- [ ] **Step 1: Write result merge regression test**

Add:

```python
@pytest.mark.asyncio
async def test_collect_completed_result_preserves_file_changes_with_blocks(
    monkeypatch,
):
    result = await lifecycle.collect_completed_result(
        1234,
        status="COMPLETED",
        result={
            "value": "done",
            "file_changes": {
                "version": 1,
                "status": "active",
                "artifact_id": "turn-file-changes/7/1234",
                "file_count": 1,
                "additions": 4,
                "deletions": 2,
                "files": [],
            },
        },
    )
    assert result["value"] == "done"
    assert result["blocks"]
    assert result["file_changes"]["file_count"] == 1
```

- [ ] **Step 2: Write failing service tests**

Cover:

```python
test_get_diff_dispatches_recorded_device_and_workspace
test_get_diff_rejects_device_mismatch
test_get_diff_reports_offline_device
test_revert_updates_only_file_changes_status
test_revert_conflict_keeps_existing_message_result
test_revert_is_idempotent_after_success
test_missing_artifact_marks_artifact_missing
```

- [ ] **Step 3: Define strict schemas**

In `turn_file_changes.py`, define Pydantic models:

```python
class TurnFileChangeItem(BaseModel):
    old_path: str | None = None
    path: str
    change_type: Literal["created", "modified", "deleted", "renamed"]
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)
    binary: bool = False


class TurnFileChangesSummary(BaseModel):
    version: Literal[1]
    status: Literal["active", "reverted", "conflicted", "artifact_missing"]
    artifact_id: str
    device_id: str
    workspace_path: str
    file_count: int = Field(ge=0)
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)
    files: list[TurnFileChangeItem]
    reverted_at: datetime | None = None
```

Also define `TurnFileChangesDiffResponse` and `TurnFileChangesRevertResponse`.

- [ ] **Step 4: Implement ownership and summary loading**

Create one helper that joins `Subtask` and `TaskResource` and requires:

```python
TaskResource.id == Subtask.task_id
TaskResource.user_id == current_user.id
TaskResource.kind == "Task"
TaskResource.is_active.in_(TaskResource.is_active_query())
```

Require assistant role and validate `subtask.result["file_changes"]` with the
Pydantic schema. Return `404` for missing records and `409` for invalid state.

- [ ] **Step 5: Implement review service**

Call:

```python
execute_configured_device_command(
    db=db,
    user_id=user_id,
    device_id=summary.device_id,
    command_key="turn_file_changes_review",
    path=summary.workspace_path,
    args=[summary.artifact_id],
    timeout_seconds=30,
    max_output_bytes=5 * 1024 * 1024,
)
```

Map offline device to HTTP `409` with stable error code
`TURN_FILE_CHANGES_DEVICE_OFFLINE`, missing artifact to `410`, and malformed
artifact to `422`.

- [ ] **Step 6: Implement atomic revert service**

Call the controlled revert command once. On success, merge:

```python
updated_result = dict(subtask.result or {})
updated_file_changes = dict(updated_result["file_changes"])
updated_file_changes.update(
    status="reverted",
    reverted_at=datetime.now(timezone.utc).isoformat(),
)
updated_result["file_changes"] = updated_file_changes
subtask.result = updated_result
flag_modified(subtask, "result")
db.commit()
```

On conflict, update only `status="conflicted"` and return HTTP `409` with command
error details. If already `reverted`, return the current summary without calling
the device.

- [ ] **Step 7: Add endpoints**

In `subtasks.py` add:

```python
@router.get(
    "/{subtask_id}/file-changes/diff",
    response_model=TurnFileChangesDiffResponse,
)
async def get_turn_file_changes_diff(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> TurnFileChangesDiffResponse:
    return await turn_file_changes_service.get_diff(
        db=db,
        user_id=current_user.id,
        subtask_id=subtask_id,
    )


@router.post(
    "/{subtask_id}/file-changes/revert",
    response_model=TurnFileChangesRevertResponse,
)
async def revert_turn_file_changes(
    subtask_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> TurnFileChangesRevertResponse:
    return await turn_file_changes_service.revert(
        db=db,
        user_id=current_user.id,
        subtask_id=subtask_id,
    )
```

Use authenticated user and DB dependencies. Do not accept task, device, workspace,
or artifact values in the request body.

- [ ] **Step 8: Run Backend tests**

Run:

```bash
cd backend
uv run pytest \
  tests/services/chat/trigger/test_lifecycle_completed_result.py \
  tests/services/test_turn_file_changes_service.py \
  tests/api/endpoints/test_subtask_file_changes.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  backend/app/schemas/turn_file_changes.py \
  backend/app/services/turn_file_changes.py \
  backend/app/api/endpoints/subtasks.py \
  backend/tests/services/chat/trigger/test_lifecycle_completed_result.py \
  backend/tests/services/test_turn_file_changes_service.py \
  backend/tests/api/endpoints/test_subtask_file_changes.py
git commit -m "feat(backend): expose turn file review and revert APIs"
```

---

### Task 6: Carry File Change Summaries Through Wework Message State

**Files:**
- Modify: `wework/src/types/api.ts`
- Modify: `wework/src/types/workbench.ts`
- Modify: `wework/src/api/tasks.ts`
- Modify: `wework/src/features/workbench/messageReducer.ts`
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`

- [ ] **Step 1: Write failing provider tests**

Add a realtime test:

```typescript
chatHandlers.onChatDone({
  subtask_id: 101,
  offset: 4,
  result: {
    value: 'done',
    file_changes: fileChangesFixture,
  },
})

expect(currentMessages()[0].fileChanges).toEqual(fileChangesFixture)
```

Add a history restoration test where `TaskDetail.subtasks[].result.file_changes`
contains the same fixture. Add a revert test that mocks API response with
`status: 'reverted'` and asserts the corresponding message is updated.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd wework
npm test -- src/features/workbench/WorkbenchProvider.test.tsx
```

Expected: FAIL because `fileChanges` is not normalized.

- [ ] **Step 3: Add API and UI types**

In `types/api.ts`:

```typescript
export type TurnFileChangesStatus =
  | 'active'
  | 'reverted'
  | 'conflicted'
  | 'artifact_missing'

export interface TurnFileChangeItem {
  old_path?: string
  path: string
  change_type: 'created' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  binary: boolean
}

export interface TurnFileChangesSummary {
  version: 1
  status: TurnFileChangesStatus
  artifact_id: string
  device_id: string
  workspace_path: string
  file_count: number
  additions: number
  deletions: number
  files: TurnFileChangeItem[]
  reverted_at?: string | null
}

export interface TurnFileChangesDiffResponse {
  subtask_id: number
  diff: string
}
export interface TurnFileChangesRevertResponse {
  subtask_id: number
  file_changes: TurnFileChangesSummary
}
```

Add `file_changes?: TurnFileChangesSummary` to `ChatResultPayload`.

In `types/workbench.ts` add:

```typescript
fileChanges?: TurnFileChangesSummary
```

to `WorkbenchMessage`.

- [ ] **Step 4: Add task API methods**

```typescript
getTurnFileChangesDiff(
  subtaskId: number,
): Promise<TurnFileChangesDiffResponse> {
  return client.get(`/subtasks/${subtaskId}/file-changes/diff`)
},

revertTurnFileChanges(
  subtaskId: number,
): Promise<TurnFileChangesRevertResponse> {
  return client.post(`/subtasks/${subtaskId}/file-changes/revert`)
},
```

- [ ] **Step 5: Normalize untrusted result data**

Add `normalizeFileChanges(value: unknown)` that validates every primitive and
drops malformed entries. Extend `getSubtaskResult()` and `subtaskToMessage()`.

For `onChatDone`, dispatch:

```typescript
{
  type: 'assistant_done',
  subtaskId: payload.subtask_id,
  content:
    typeof payload.result.value === 'string'
      ? payload.result.value
      : undefined,
  blocks: getResultBlocks(payload.subtask_id, payload.result),
  fileChanges: normalizeFileChanges(payload.result.file_changes),
}
```

- [ ] **Step 6: Add reducer state updates**

Extend `assistant_done` with `fileChanges`. Add:

```typescript
| {
    type: 'file_changes_updated'
    subtaskId: number
    fileChanges: TurnFileChangesSummary
  }
```

Use this action after revert success or conflict response.

- [ ] **Step 7: Expose review and revert callbacks**

Add provider methods:

```typescript
loadTurnFileChangesDiff(subtaskId: number): Promise<string>
revertTurnFileChanges(subtaskId: number): Promise<TurnFileChangesSummary>
```

The revert method updates message state before returning. Errors remain typed
`ApiError` for UI copy selection.

- [ ] **Step 8: Run Wework state tests**

Run:

```bash
cd wework
npm test -- \
  src/features/workbench/messageReducer.test.ts \
  src/features/workbench/WorkbenchProvider.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add \
  wework/src/types/api.ts \
  wework/src/types/workbench.ts \
  wework/src/api/tasks.ts \
  wework/src/features/workbench/messageReducer.ts \
  wework/src/features/workbench/WorkbenchProvider.tsx \
  wework/src/features/workbench/WorkbenchProvider.test.tsx
git commit -m "feat(wework): persist turn file changes in message state"
```

---

### Task 7: Build the File Changes Card, Review Dialog, and Revert Flow

**Files:**
- Create: `wework/src/components/chat/FileChangesCard.tsx`
- Create: `wework/src/components/chat/FileChangesReviewDialog.tsx`
- Create: `wework/src/components/chat/FileChangesCard.test.tsx`
- Modify: `wework/src/components/chat/MessageList.tsx`
- Modify: `wework/src/components/chat/MessageList.test.tsx`
- Modify: `wework/src/pages/WorkbenchPage.tsx`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.tsx`
- Modify: `wework/src/components/layout/DesktopWorkbenchMain.tsx`
- Modify: `wework/src/components/layout/MobileWorkbenchLayout.tsx`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`

- [ ] **Step 1: Write failing card interaction tests**

Render six files and assert:

```typescript
expect(screen.getByText('已编辑 6 个文件')).toBeInTheDocument()
expect(screen.getByText('+107')).toBeInTheDocument()
expect(screen.getByText('-121')).toBeInTheDocument()
expect(screen.getAllByTestId('file-change-row')).toHaveLength(3)

await user.click(screen.getByTestId('toggle-file-changes-button'))
expect(screen.getAllByTestId('file-change-row')).toHaveLength(6)
```

Also test:

```typescript
test('disables review and revert when device is offline')
test('loads diff only when review is opened')
test('confirms before reverting')
test('shows reverted status and removes revert action')
test('shows conflict state without hiding review')
test('labels binary files without line counts')
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd wework
npm test -- src/components/chat/FileChangesCard.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the summary card**

Props:

```typescript
interface FileChangesCardProps {
  subtaskId: number
  summary: TurnFileChangesSummary
  deviceOnline: boolean
  onLoadDiff: (subtaskId: number) => Promise<string>
  onRevert: (subtaskId: number) => Promise<TurnFileChangesSummary>
}
```

Use three visible files by default. Required test IDs:

```text
file-changes-card
file-change-row
toggle-file-changes-button
review-file-changes-button
revert-file-changes-button
confirm-revert-file-changes-button
```

Primary confirm action must use `variant="primary"`.

- [ ] **Step 4: Implement the review dialog**

Parse unified diff into file sections with a focused parser in the same file:

```typescript
interface DiffFileSection {
  oldPath?: string
  path: string
  lines: string[]
}
```

Split on `diff --git` headers, preserve hunk lines, and style:

- `+` additions with low-saturation green.
- `-` deletions with low-saturation red.
- headers and hunks with surface background.
- horizontally scrollable monospace content.

The dialog loads on demand and shows loading, error, empty, and binary states.

- [ ] **Step 5: Wire message-level callbacks**

Extend `MessageListProps`:

```typescript
devices: DeviceInfo[]
onLoadFileChangesDiff: (subtaskId: number) => Promise<string>
onRevertFileChanges: (
  subtaskId: number,
) => Promise<TurnFileChangesSummary>
```

Resolve online status using `message.fileChanges.device_id`, not the current
project selection. Render the card after assistant Markdown and before hover
actions.

Thread these props through `WorkbenchPage`, desktop layout, desktop main, and
mobile layout. Do not duplicate API calls inside layout components.

- [ ] **Step 6: Add translations**

Add `chat.file_changes.*` keys to both locale files, including:

```json
{
  "edited_files": "已编辑 {{count}} 个文件",
  "show_more": "再显示 {{count}} 个文件",
  "show_less": "收起",
  "review": "审核",
  "revert": "撤销",
  "confirm_revert_title": "撤销本轮文件变更？",
  "confirm_revert_description": "仅当反向补丁可安全应用时才会修改工作区。",
  "device_offline": "设备离线，无法审核或撤销",
  "reverted": "已撤销",
  "conflicted": "存在后续冲突，未修改工作区",
  "binary_file": "二进制文件"
}
```

Provide equivalent English keys.

- [ ] **Step 7: Run component and layout tests**

Run:

```bash
cd wework
npm test -- \
  src/components/chat/FileChangesCard.test.tsx \
  src/components/chat/MessageList.test.tsx \
  src/components/layout/DesktopWorkbenchLayout.test.tsx \
  src/components/layout/MobileWorkbenchLayout.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Run browser verification**

Start the current Wework dev command used by the repository, open:

```text
http://127.0.0.1:9123/projects/11/tasks/6268
```

Verify with the in-app Browser:

1. A completed assistant message displays the summary card.
2. Three files are visible before expansion.
3. Review opens the file-grouped diff.
4. Revert requires confirmation.
5. Mobile viewport keeps 44px minimum interactive targets.
6. Offline device keeps summary visible and disables both operations.

- [ ] **Step 9: Commit**

```bash
git add \
  wework/src/components/chat/FileChangesCard.tsx \
  wework/src/components/chat/FileChangesReviewDialog.tsx \
  wework/src/components/chat/FileChangesCard.test.tsx \
  wework/src/components/chat/MessageList.tsx \
  wework/src/components/chat/MessageList.test.tsx \
  wework/src/pages/WorkbenchPage.tsx \
  wework/src/components/layout/DesktopWorkbenchLayout.tsx \
  wework/src/components/layout/DesktopWorkbenchMain.tsx \
  wework/src/components/layout/MobileWorkbenchLayout.tsx \
  wework/src/i18n/locales/zh-CN/common.json \
  wework/src/i18n/locales/en/common.json
git commit -m "feat(wework): add per-turn file review and revert UI"
```

---

### Task 8: Add Chinese and English User Documentation

**Files:**
- Create: `docs/zh/user-guide/coding/turn-file-changes.md`
- Create: `docs/en/user-guide/coding/turn-file-changes.md`

- [ ] **Step 1: Write Chinese documentation first**

Use frontmatter:

```markdown
---
sidebar_position: 3
---
```

Document:

1. The card represents one user/assistant turn, not the entire conversation.
2. Review and revert require the original device to be online.
3. Revert refuses conflicts and never force-overwrites later changes.
4. Only Git project workspaces are supported.
5. Binary files show file status without text line counts.

- [ ] **Step 2: Write the equivalent English documentation**

Keep the same headings and limitation statements.

- [ ] **Step 3: Check documentation format**

Run:

```bash
rg -n "^---$|^sidebar_position:|^# |^## " \
  docs/zh/user-guide/coding/turn-file-changes.md \
  docs/en/user-guide/coding/turn-file-changes.md
```

Expected: both files have frontmatter and matching heading hierarchy.

- [ ] **Step 4: Commit**

```bash
git add \
  docs/zh/user-guide/coding/turn-file-changes.md \
  docs/en/user-guide/coding/turn-file-changes.md
git commit -m "docs(wework): document per-turn file changes"
```

---

### Task 9: Run Full Verification and Fix Cross-Layer Regressions

**Files:**
- Modify only files required by failing checks.

- [ ] **Step 1: Format Python changes**

Run:

```bash
cd executor
uv run black services/turn_file_changes.py agents/base.py agents/codex agents/claude_code
uv run isort services/turn_file_changes.py agents/base.py agents/codex agents/claude_code

cd ../backend
uv run black app/schemas/turn_file_changes.py app/services/turn_file_changes.py app/api/endpoints/subtasks.py
uv run isort app/schemas/turn_file_changes.py app/services/turn_file_changes.py app/api/endpoints/subtasks.py
```

Expected: formatting succeeds.

- [ ] **Step 2: Run executor tests**

Run:

```bash
cd executor
uv run pytest \
  tests/services/test_turn_file_changes.py \
  tests/agents/test_codex_event_mapper.py \
  tests/agents/test_claude_response_processor.py
```

Expected: PASS.

- [ ] **Step 3: Run Backend tests**

Run:

```bash
cd backend
uv run pytest \
  tests/services/chat/trigger/test_lifecycle_completed_result.py \
  tests/services/test_turn_file_changes_service.py \
  tests/api/endpoints/test_subtask_file_changes.py \
  tests/services/test_local_device_command_service.py
```

Expected: PASS.

- [ ] **Step 4: Run Wework tests**

Run:

```bash
cd wework
npm test
```

Expected: all tests PASS; no test is skipped to hide failure.

- [ ] **Step 5: Run Wework format, lint, and build**

Run:

```bash
cd wework
npx prettier --write src
npm run lint
npm run build
```

Expected: all commands PASS.

- [ ] **Step 6: Perform real Codex and Claude smoke tests**

For each runtime on an online device:

1. Create a Git project with a clean committed file and a pre-existing dirty file.
2. Ask the runtime to modify a different file using normal file tools.
3. Ask it to make another change through Bash or a formatter.
4. Verify only changes from that turn appear in the card.
5. Open Review and compare the displayed patch with the actual turn changes.
6. Revert the latest turn and verify the pre-existing dirty file remains unchanged.
7. Create a later conflicting edit and verify reverting the older turn reports a
   conflict without modifying files.

- [ ] **Step 7: Verify repository state**

Run:

```bash
git status --short
git diff --check
git log --oneline -10
```

Expected: only intentional changes remain, no whitespace errors, and every task
has its scoped conventional commit.

- [ ] **Step 8: Commit verification fixes when needed**

If verification required code fixes:

```bash
git add -u
git commit -m "fix(wework): address turn file change verification"
```

If no files changed, do not create an empty commit.

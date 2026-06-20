---
sidebar_position: 1
---

# Local Codex Direct Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local Codex "import" flow with a direct-open takeover flow that hides subagent/running threads and keeps one local Codex thread bound to one Wework Task alias.

**Architecture:** Backend filters local Codex discovery at both the local command and API-normalization layers. Wework renders visible local Codex threads as an open/connect entry in the left conversation area, then calls the existing bind endpoint to create or reuse the one-to-one Task alias and navigate to it.

**Tech Stack:** FastAPI, local device command registry, Pydantic schemas, pytest, Vite React TypeScript, Vitest, Testing Library, lucide-react.

**Design Source:** `docs/superpowers/specs/2026-06-20-local-codex-direct-open-design.md`

---

## File Structure

Modify:

- `backend/app/services/device/command_registry.py` owns the local `codex_threads_list` script and should filter subagent, archived, and running threads before output.
- `backend/app/api/endpoints/local_codex.py` normalizes command output, applies the same final visibility filter, and rejects binding invisible threads.
- `backend/tests/services/test_local_device_command_service.py` covers command-script filtering behavior.
- `backend/tests/api/endpoints/test_local_codex_threads_api.py` covers API-side filtering and bind rejection for invisible threads.
- `wework/src/components/layout/LocalCodexThreadImportDialog.tsx` should become the direct-open UI. Rename is optional, but the visible copy and test ids must stop saying import.
- `wework/src/components/layout/LocalCodexThreadImportDialog.test.tsx` should test filtered direct-open behavior.
- `wework/src/components/layout/DesktopSidebar.tsx` replaces the import icon/copy with an open local Codex entry point.
- `wework/src/i18n/locales/en/common.json` updates local Codex copy.
- `wework/src/i18n/locales/zh-CN/common.json` updates local Codex copy.
- `wework/src/features/workbench/WorkbenchProvider.test.tsx` updates "import" naming in tests while keeping provider bind behavior.

Do not change:

- `backend/app/services/local_codex_thread_service.py` one-to-one binding behavior, except tests may assert it remains one-to-one.
- `executor/agents/codex/codex_agent.py`; current resume behavior is the intended takeover behavior.

## Task 1: Filter Local Codex Discovery At The Command Source

**Files:**

- Modify: `backend/app/services/device/command_registry.py`
- Test: `backend/tests/services/test_local_device_command_service.py`

- [ ] **Step 1: Write failing command-filter tests**

Add tests after `test_codex_threads_list_command_reads_cwd_from_session_metadata`.

```python
def test_codex_threads_list_command_filters_subagent_from_session_metadata(tmp_path):
    """codex_threads_list should not expose Codex subagent threads."""
    from app.services.device.command_registry import CODEX_THREADS_LIST_SCRIPT

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    user_thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ae"
    subagent_thread_id = "018f2d6b-8c7a-7abc-9def-0123456789af"
    (codex_home / "session_index.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": user_thread_id,
                        "thread_name": "User thread",
                        "updated_at": "2026-06-20T05:52:31Z",
                    }
                ),
                json.dumps(
                    {
                        "id": subagent_thread_id,
                        "thread_name": "Subagent thread",
                        "updated_at": "2026-06-20T06:52:31Z",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    session_dir = codex_home / "sessions" / "2026" / "06" / "20"
    session_dir.mkdir(parents=True)
    (session_dir / f"rollout-2026-06-20T13-52-19-{user_thread_id}.jsonl").write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {
                    "id": user_thread_id,
                    "cwd": "/tmp/user-project",
                    "thread_source": "user",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (session_dir / f"rollout-2026-06-20T13-53-19-{subagent_thread_id}.jsonl").write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {
                    "id": subagent_thread_id,
                    "cwd": "/tmp/subagent-project",
                    "thread_source": "subagent",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["python3", "-c", CODEX_THREADS_LIST_SCRIPT],
        env={
            **os.environ,
            "CODEX_HOME": str(codex_home),
            "WEGENT_CODEX_THREADS_LIMIT": "100",
        },
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert [thread["threadId"] for thread in payload["threads"]] == [user_thread_id]
    assert payload["threads"][0]["threadSource"] == "user"


def test_codex_threads_list_command_filters_running_and_archived_records(tmp_path):
    """codex_threads_list should hide unavailable local Codex threads."""
    from app.services.device.command_registry import CODEX_THREADS_LIST_SCRIPT

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    visible_thread_id = "018f2d6b-8c7a-7abc-9def-0123456789b0"
    (codex_home / "session_index.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": visible_thread_id,
                        "title": "Visible",
                        "updatedAt": "2026-06-20T00:01:00Z",
                    }
                ),
                json.dumps(
                    {
                        "id": "018f2d6b-8c7a-7abc-9def-0123456789b1",
                        "title": "Running",
                        "updatedAt": "2026-06-20T00:02:00Z",
                        "running": True,
                    }
                ),
                json.dumps(
                    {
                        "id": "018f2d6b-8c7a-7abc-9def-0123456789b2",
                        "title": "Archived",
                        "updatedAt": "2026-06-20T00:03:00Z",
                        "archived": True,
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        ["python3", "-c", CODEX_THREADS_LIST_SCRIPT],
        env={
            **os.environ,
            "CODEX_HOME": str(codex_home),
            "WEGENT_CODEX_THREADS_LIMIT": "100",
        },
        check=True,
        capture_output=True,
        text=True,
    )

    payload = json.loads(result.stdout)
    assert [thread["threadId"] for thread in payload["threads"]] == [visible_thread_id]
```

- [ ] **Step 2: Run command-filter tests and verify they fail**

Run:

```bash
cd backend
uv run pytest tests/services/test_local_device_command_service.py::test_codex_threads_list_command_filters_subagent_from_session_metadata tests/services/test_local_device_command_service.py::test_codex_threads_list_command_filters_running_and_archived_records -q --tb=short
```

Expected: FAIL because the script does not yet return `threadSource` and still exposes running/subagent/archived records.

- [ ] **Step 3: Implement command-source filtering**

Inside `CODEX_THREADS_LIST_SCRIPT`, add helpers near `read_session_cwd`.

```python
def read_session_metadata(path):
    try:
        with path.open("rb") as handle:
            for line_number, raw_line in enumerate(handle):
                if line_number >= 80:
                    break
                record = parse_json_line(raw_line)
                if record is None:
                    continue
                payload = record.get("payload") if isinstance(record.get("payload"), dict) else record
                thread_source = first_nested_text(payload, "thread_source", "threadSource")
                cwd = first_nested_text(
                    payload,
                    "cwd",
                    "workdir",
                    "workingDirectory",
                    "working_directory",
                    "currentWorkingDirectory",
                    "current_working_directory",
                )
                if cwd or thread_source:
                    return {"cwd": cwd, "threadSource": thread_source}
    except OSError:
        return {}
    return {}


def find_session_metadata(codex_home, thread_id, updated_at):
    for path in iter_session_files(codex_home, thread_id, updated_at):
        metadata = read_session_metadata(path)
        if metadata:
            return metadata
    return {}


def is_visible_thread(record):
    if record.get("archived") or record.get("running"):
        return False
    thread_source = record.get("threadSource")
    return thread_source in (None, "", "user")
```

Replace the old `read_session_cwd` / `find_session_cwd` usage with metadata enrichment in `normalize_record`.

```python
def normalize_record(record, codex_home):
    thread_id = first_text(record, "id", "thread_id", "threadId", "conversation_id")
    if not thread_id:
        return None
    title = first_text(record, "title", "thread_name", "summary", "name") or thread_id
    updated_at = first_text(record, "updatedAt", "updated_at", "mtime")
    metadata = find_session_metadata(codex_home, thread_id, updated_at)
    cwd = first_text(
        record,
        "cwd",
        "workdir",
        "workingDirectory",
        "working_directory",
    ) or metadata.get("cwd")
    thread_source = first_text(record, "threadSource", "thread_source") or metadata.get(
        "threadSource"
    )
    normalized = {
        "threadId": thread_id,
        "title": title,
        "cwd": cwd,
        "updatedAt": updated_at,
        "archived": bool(record.get("archived", False)),
        "running": bool(record.get("running", False)),
        "threadSource": thread_source,
    }
    return normalized if is_visible_thread(normalized) else None
```

Keep `read_session_cwd` only if it still has callers; otherwise delete it.

- [ ] **Step 4: Run command tests and verify they pass**

Run:

```bash
cd backend
uv run pytest tests/services/test_local_device_command_service.py -q --tb=short
```

Expected: PASS.

- [ ] **Step 5: Commit command filtering**

```bash
git add backend/app/services/device/command_registry.py backend/tests/services/test_local_device_command_service.py
git commit -m "fix(backend): filter local Codex discovery"
```

## Task 2: Apply API-Side Visibility Filtering

**Files:**

- Modify: `backend/app/schemas/local_codex.py`
- Modify: `backend/app/api/endpoints/local_codex.py`
- Test: `backend/tests/api/endpoints/test_local_codex_threads_api.py`

- [ ] **Step 1: Write failing API tests**

Add two tests to `backend/tests/api/endpoints/test_local_codex_threads_api.py`.

```python
@pytest.mark.asyncio
async def test_list_local_codex_threads_filters_unavailable_and_subagent_records(
    monkeypatch,
) -> None:
    from app.api.endpoints import local_codex

    visible_thread_id = "018f2d6b-8c7a-7abc-9def-0123456789b3"
    service_mock = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "threads": [
                    {
                        "threadId": visible_thread_id,
                        "title": "Visible",
                        "threadSource": "user",
                    },
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789b4",
                        "title": "Subagent",
                        "threadSource": "subagent",
                    },
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789b5",
                        "title": "Running",
                        "running": True,
                    },
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789b6",
                        "title": "Archived",
                        "archived": True,
                    },
                ]
            },
        }
    )
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)

    response = await local_codex.list_device_codex_threads(
        device_id="device-abc",
        limit=100,
        db=object(),
        current_user=SimpleNamespace(id=7),
    )

    assert [thread.thread_id for thread in response.threads] == [visible_thread_id]


@pytest.mark.asyncio
async def test_bind_local_codex_thread_rejects_filtered_thread(monkeypatch) -> None:
    from app.api.endpoints import local_codex
    from app.schemas.local_codex import LocalCodexBindRequest

    service_mock = AsyncMock(
        return_value={
            "success": True,
            "stdout": {
                "threads": [
                    {
                        "threadId": "018f2d6b-8c7a-7abc-9def-0123456789b7",
                        "title": "Running",
                        "running": True,
                    }
                ]
            },
        }
    )
    monkeypatch.setattr(local_codex, "execute_configured_device_command", service_mock)

    with pytest.raises(HTTPException) as exc_info:
        await local_codex.bind_local_codex_thread_endpoint(
            request=LocalCodexBindRequest(
                deviceId="device-abc",
                threadId="018f2d6b-8c7a-7abc-9def-0123456789b7",
            ),
            db=object(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 404
    assert "not found" in exc_info.value.detail
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
cd backend
uv run pytest tests/api/endpoints/test_local_codex_threads_api.py::test_list_local_codex_threads_filters_unavailable_and_subagent_records tests/api/endpoints/test_local_codex_threads_api.py::test_bind_local_codex_thread_rejects_filtered_thread -q --tb=short
```

Expected: FAIL because API normalization currently passes through running/subagent/archived records.

- [ ] **Step 3: Add schema field and visibility helper**

In `backend/app/schemas/local_codex.py`, add:

```python
thread_source: Optional[str] = Field(default=None, alias="threadSource")
```

In `backend/app/api/endpoints/local_codex.py`, add:

```python
def _is_visible_thread_summary(item: LocalCodexThreadSummary) -> bool:
    if item.archived or item.running:
        return False
    return item.thread_source in (None, "", "user")
```

Update `_discover_device_codex_threads` to normalize, validate, and filter.

```python
threads: list[LocalCodexThreadSummary] = []
for item in raw_threads[:capped_limit]:
    if not isinstance(item, dict):
        continue
    summary = LocalCodexThreadSummary.model_validate(_normalize_thread_summary(item))
    if _is_visible_thread_summary(summary):
        threads.append(summary)
return threads
```

Update `_normalize_thread_summary` to preserve thread source.

```python
"threadSource": item.get("threadSource") or item.get("thread_source"),
```

- [ ] **Step 4: Run API tests and verify they pass**

Run:

```bash
cd backend
uv run pytest tests/api/endpoints/test_local_codex_threads_api.py -q --tb=short
```

Expected: PASS.

- [ ] **Step 5: Commit API filtering**

```bash
git add backend/app/schemas/local_codex.py backend/app/api/endpoints/local_codex.py backend/tests/api/endpoints/test_local_codex_threads_api.py
git commit -m "fix(backend): guard local Codex thread visibility"
```

## Task 3: Replace Import Dialog Copy With Direct Open Behavior

**Files:**

- Modify: `wework/src/components/layout/LocalCodexThreadImportDialog.tsx`
- Modify: `wework/src/components/layout/LocalCodexThreadImportDialog.test.tsx`
- Modify: `wework/src/i18n/locales/en/common.json`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`

- [ ] **Step 1: Write failing UI tests for direct-open behavior**

Update `LocalCodexThreadImportDialog.test.tsx`.

Rename the describe block text to `LocalCodexThreadOpenDialog`.

Replace the disabled-row test with a filtering expectation.

```tsx
test('hides archived and running threads from the open list', async () => {
  renderDialog({
    threads: [
      {
        threadId: 'visible-thread',
        title: 'Visible thread',
      },
      {
        threadId: 'archived-thread',
        title: 'Archived thread',
        archived: true,
      },
      {
        threadId: 'running-thread',
        title: 'Running thread',
        running: true,
      },
    ],
  })

  expect(await screen.findByText('Visible thread')).toBeInTheDocument()
  expect(screen.queryByText('Archived thread')).not.toBeInTheDocument()
  expect(screen.queryByText('Running thread')).not.toBeInTheDocument()
  expect(screen.getByTestId('local-codex-open-button')).toHaveTextContent('打开')
})
```

Update the bind test to click `local-codex-open-button` instead of `local-codex-bind-button`.

```tsx
await userEvent.click(await screen.findByTestId('local-codex-open-button'))
```

- [ ] **Step 2: Run UI component tests and verify they fail**

Run:

```bash
pnpm --dir wework test src/components/layout/LocalCodexThreadImportDialog.test.tsx --run
```

Expected: FAIL because the component still renders disabled unavailable rows and uses import/bind copy/test ids.

- [ ] **Step 3: Implement visible-thread filtering and open copy**

Inside `LocalCodexThreadImportDialog.tsx`, add:

```tsx
function getVisibleThreads(threads: LocalCodexThreadSummary[]) {
  return threads.filter(thread => !thread.archived && !thread.running)
}
```

Use it after `threads` state:

```tsx
const visibleThreads = useMemo(() => getVisibleThreads(threads), [threads])
```

Render `visibleThreads` instead of `threads`.

```tsx
visibleThreads.length === 0
```

Use open naming for the row action.

```tsx
const openLabel = t('localCodex.open')
```

Change the button test id and title.

```tsx
data-testid="local-codex-open-button"
title={openLabel}
```

Keep `bindThread` as the internal callback name if minimizing changes, but visible copy must read as open/connect.

- [ ] **Step 4: Update i18n copy**

In `wework/src/i18n/locales/en/common.json` localCodex block:

```json
"openAction": "Open local Codex task",
"dialogTitle": "Local Codex tasks",
"bind": "Open",
"open": "Open",
"threadUnavailable": "Running or archived Codex tasks are hidden"
```

In `wework/src/i18n/locales/zh-CN/common.json` localCodex block:

```json
"openAction": "打开本地 Codex 任务",
"dialogTitle": "本地 Codex 任务",
"bind": "打开",
"open": "打开",
"threadUnavailable": "运行中或已归档的 Codex 任务已隐藏"
```

Keep `importAction` temporarily only if other code still references it during this task. Remove it in Task 4 when the sidebar changes.

- [ ] **Step 5: Run UI component tests and verify they pass**

Run:

```bash
pnpm --dir wework test src/components/layout/LocalCodexThreadImportDialog.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit direct-open component copy**

```bash
git add wework/src/components/layout/LocalCodexThreadImportDialog.tsx wework/src/components/layout/LocalCodexThreadImportDialog.test.tsx wework/src/i18n/locales/en/common.json wework/src/i18n/locales/zh-CN/common.json
git commit -m "fix(wework): present local Codex threads as openable"
```

## Task 4: Integrate Direct Open In The Left Sidebar

**Files:**

- Modify: `wework/src/components/layout/DesktopSidebar.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
- Modify: `wework/src/i18n/locales/en/common.json`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`

- [ ] **Step 1: Write failing sidebar naming test**

If `DesktopSidebar` already has a focused test file, add the test there. If not, add a focused assertion to the existing layout test that renders the sidebar with `onListLocalCodexThreads` and `onBindLocalCodexThread`.

Expected assertions:

```tsx
expect(screen.getByTestId('local-codex-open-menu-button')).toHaveAttribute(
  'aria-label',
  '打开本地 Codex 任务',
)
expect(screen.queryByTestId('local-codex-import-button')).not.toBeInTheDocument()
```

Update `WorkbenchProvider.test.tsx` helper names from import to open without changing provider behavior.

```tsx
await userEvent.click(screen.getByText('open codex'))
```

- [ ] **Step 2: Run affected Wework tests and verify they fail**

Run:

```bash
pnpm --dir wework test src/components/layout/LocalCodexThreadImportDialog.test.tsx src/features/workbench/WorkbenchProvider.test.tsx --run
```

Expected: FAIL on stale import test ids or stale visible text.

- [ ] **Step 3: Change sidebar icon and copy**

In `DesktopSidebar.tsx`, remove `Import` from lucide imports and add `FolderOpen` if not already imported.

Replace:

```tsx
const canImportLocalCodex = Boolean(onListLocalCodexThreads && onBindLocalCodexThread)
```

with:

```tsx
const canOpenLocalCodex = Boolean(onListLocalCodexThreads && onBindLocalCodexThread)
```

Replace the history header button:

```tsx
{canOpenLocalCodex && (
  <button
    type="button"
    data-testid="local-codex-open-menu-button"
    onClick={() => setLocalCodexDialogOpen(true)}
    className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
    title={t('localCodex.openAction')}
    aria-label={t('localCodex.openAction')}
  >
    <FolderOpen className="h-4 w-4" />
  </button>
)}
```

Keep the dialog component name for this task to avoid a broad rename. The user-facing behavior is open/connect.

- [ ] **Step 4: Remove stale import copy**

In both locale files, replace `importAction` usage with `openAction`. If no code references `localCodex.importAction`, remove that key.

Run:

```bash
rg -n "localCodex\\.importAction|local-codex-import-button|\\bImport\\b" wework/src/components/layout wework/src/i18n/locales
```

Expected: no local Codex import references. Runtime auth import text may remain outside local Codex.

- [ ] **Step 5: Run affected Wework tests and verify they pass**

Run:

```bash
pnpm --dir wework test src/components/layout/LocalCodexThreadImportDialog.test.tsx src/features/workbench/WorkbenchProvider.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit sidebar direct-open integration**

```bash
git add wework/src/components/layout/DesktopSidebar.tsx wework/src/features/workbench/WorkbenchProvider.test.tsx wework/src/i18n/locales/en/common.json wework/src/i18n/locales/zh-CN/common.json
git commit -m "fix(wework): open local Codex threads from sidebar"
```

## Task 5: Final Verification

**Files:**

- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Run backend focused tests**

```bash
cd backend
uv run pytest tests/services/test_local_device_command_service.py tests/api/endpoints/test_local_codex_threads_api.py tests/services/test_local_codex_thread_service.py -q --tb=short
```

Expected: PASS.

- [ ] **Step 2: Run Wework focused tests**

```bash
pnpm --dir wework test src/components/layout/LocalCodexThreadImportDialog.test.tsx src/features/workbench/WorkbenchProvider.test.tsx src/api/localCodex.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Inspect status and final diff**

```bash
git status --short
git log --oneline -5
```

Expected: clean worktree after commits and recent commits matching the task commits above.

## Self-Review

- Spec coverage: Tasks 1 and 2 implement subagent/running/archived filtering. Tasks 3 and 4 replace import copy with direct-open behavior. Existing binding service preserves one-to-one Task alias semantics, and Task 2/5 keep backend tests around that path.
- Placeholder scan: no placeholders or deferred implementation notes are used.
- Type consistency: `threadSource` is the wire field, `thread_source` is the Pydantic/Python field, and `LocalCodexThreadSummary` remains the shared response shape.

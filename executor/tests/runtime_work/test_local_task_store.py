# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
import sys
from datetime import datetime, timezone
from types import ModuleType, SimpleNamespace

import pytest


class EmptyDiscovery:
    def discover(self):
        return []


class SequenceDiscovery:
    def __init__(self, batches):
        self.batches = list(batches)
        self.calls = 0

    def discover(self):
        index = min(self.calls, len(self.batches) - 1)
        self.calls += 1
        return list(self.batches[index])


class FakeCodexThreadListClient:
    def __init__(self, threads):
        self.threads = threads
        self.calls = []
        self.archived_thread_ids = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return None

    def thread_list(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(data=self.threads)

    def thread_archive(self, thread_id):
        self.archived_thread_ids.append(thread_id)
        return SimpleNamespace(id=thread_id)


def _codex_discovery_for_threads(codex_home, *threads):
    from executor.runtime_work.codex_discovery import CodexSessionDiscovery

    fake_codex = FakeCodexThreadListClient(list(threads))
    discovery = CodexSessionDiscovery(
        codex_home=codex_home,
        codex_client_factory=lambda: fake_codex,
    )
    return discovery, fake_codex


async def _drain_runtime_adapter(adapter):
    while adapter._running_tasks:
        await asyncio.gather(*adapter._running_tasks)


def test_local_task_store_persists_tasks_and_validates_workspace(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore

    index_path = tmp_path / "index.json"
    store = LocalTaskStore(index_path)
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="codex-1",
            workspace_path="/repo/Wegent",
            title="Fix reconnect",
            runtime="codex",
            runtime_handle={"threadId": "codex-1"},
            created_at="2026-06-20T01:00:00Z",
            updated_at="2026-06-20T02:00:00Z",
            running=False,
            status="active",
        )
    )

    stored = json.loads(index_path.read_text(encoding="utf-8"))
    assert stored["tasks"]["codex-1"]["runtime_handle"] == {"threadId": "codex-1"}

    reopened = LocalTaskStore(index_path)
    tasks = reopened.list_tasks(workspace_path="/repo/Wegent")

    assert [task.local_task_id for task in tasks] == ["codex-1"]
    assert tasks[0].runtime_handle == {"threadId": "codex-1"}
    assert (
        reopened.get_task("codex-1", workspace_path="/repo/Wegent").title
        == "Fix reconnect"
    )

    with pytest.raises(KeyError):
        reopened.get_task("codex-1", workspace_path="/other")


def test_local_task_store_update_keeps_original_primary_key(tmp_path):
    from dataclasses import replace

    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="runtime-1",
            workspace_path="/repo/Wegent",
            title="Original",
            runtime="claude_code",
            runtime_handle={},
        )
    )

    updated = store.update_task(
        "runtime-1",
        lambda task: replace(task, local_task_id="runtime-2", title="Updated"),
    )

    assert updated.local_task_id == "runtime-1"
    assert store.get_task("runtime-1").title == "Updated"
    with pytest.raises(KeyError):
        store.get_task("runtime-2")


def test_local_task_store_orders_tasks_by_parsed_updated_time(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="local-offset",
            workspace_path="/repo/Wegent",
            title="offset",
            runtime="codex",
            updated_at="2026-06-20T10:00:00+08:00",
        )
    )
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="utc-later",
            workspace_path="/repo/Wegent",
            title="utc",
            runtime="codex",
            updated_at="2026-06-20T03:00:00Z",
        )
    )

    assert [task.local_task_id for task in store.list_tasks()] == [
        "utc-later",
        "local-offset",
    ]


@pytest.mark.asyncio
async def test_runtime_work_handler_lists_tasks_by_workspace(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="claude-repo-1",
            workspace_path="/repo/Wegent",
            title="Fix reconnect",
            runtime="claude_code",
            runtime_handle={"sessionId": "claude-repo-1"},
            created_at="2026-06-20T01:00:00Z",
            updated_at="2026-06-20T02:00:00Z",
            running=False,
        )
    )
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="claude-1",
            workspace_path="/repo/Other",
            title="Refactor",
            runtime="claude_code",
            runtime_handle={"sessionId": "claude-1"},
            created_at="2026-06-20T03:00:00Z",
            updated_at="2026-06-20T04:00:00Z",
            running=True,
        )
    )

    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=EmptyDiscovery(),
    ).handle_runtime_rpc({"method": "runtime.tasks.list", "payload": {}})

    assert result["success"] is True
    workspaces = {item["workspacePath"]: item for item in result["workspaces"]}
    assert workspaces["/repo/Wegent"]["localTasks"][0]["localTaskId"] == "claude-repo-1"
    assert workspaces["/repo/Other"]["localTasks"][0]["runtime"] == "claude_code"


@pytest.mark.asyncio
async def test_runtime_work_handler_lists_codex_tasks_from_sdk_only(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    discovery, _fake_codex = _codex_discovery_for_threads(
        codex_home,
        SimpleNamespace(
            id=thread_id,
            cwd="/repo/Wegent",
            name=None,
            preview="hi",
            path=str(tmp_path / "thread.jsonl"),
            created_at="2026-06-21T02:15:37Z",
            updated_at="2026-06-21T02:15:58Z",
        ),
    )
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="stale duplicate",
            runtime="codex",
            runtime_handle={"messages": []},
            created_at="2026-06-21T02:15:36+00:00",
            updated_at="2026-06-21T02:15:59+00:00",
            running=False,
        )
    )

    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=discovery,
    ).handle_runtime_rpc({"method": "runtime.tasks.list", "payload": {}})

    assert result["success"] is True
    workspaces = {item["workspacePath"]: item for item in result["workspaces"]}
    tasks = workspaces["/repo/Wegent"]["localTasks"]
    assert [task["localTaskId"] for task in tasks] == [thread_id]
    assert tasks[0]["runtime"] == "codex"


@pytest.mark.asyncio
async def test_runtime_work_handler_keeps_adapter_codex_and_archived_store_tasks(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    sdk_thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    discovery, _fake_codex = _codex_discovery_for_threads(
        tmp_path / "codex-home",
        SimpleNamespace(
            id=sdk_thread_id,
            cwd="/repo/Wegent",
            preview="sdk",
            path=str(tmp_path / "sdk.jsonl"),
            created_at="2026-06-21T02:15:37Z",
            updated_at="2026-06-21T02:15:58Z",
        ),
    )
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="adapter-codex-1",
            workspace_path="/repo/Wegent",
            title="adapter",
            runtime="codex",
            runtime_handle={"executionRequest": {"message": "hi"}},
            created_at="2026-06-21T02:10:00Z",
            updated_at="2026-06-21T02:20:00Z",
            running=False,
        )
    )
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="archived-codex-1",
            workspace_path="/repo/Wegent",
            title="archived",
            runtime="codex",
            runtime_handle={"threadId": "archived-codex-1"},
            created_at="2026-06-21T02:00:00Z",
            updated_at="2026-06-21T02:00:00Z",
            running=False,
            status="archived",
        )
    )

    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=discovery,
    ).handle_runtime_rpc(
        {"method": "runtime.tasks.list", "payload": {"includeArchived": True}}
    )

    tasks = {item["localTaskId"] for item in result["workspaces"][0]["localTasks"]}
    assert tasks == {sdk_thread_id, "adapter-codex-1", "archived-codex-1"}


@pytest.mark.asyncio
async def test_runtime_work_handler_archives_codex_thread_through_sdk(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    discovery, fake_codex = _codex_discovery_for_threads(
        codex_home,
        SimpleNamespace(
            id=thread_id,
            cwd="/repo/Wegent",
            name=None,
            preview="hi",
            path=str(tmp_path / "thread.jsonl"),
            created_at="2026-06-21T02:15:37Z",
            updated_at="2026-06-21T02:15:58Z",
        ),
    )
    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=discovery,
    )

    listed = await handler.handle_runtime_rpc(
        {"method": "runtime.tasks.list", "payload": {}}
    )
    assert listed["success"] is True

    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.archive",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
            },
        }
    )

    assert result == {
        "success": True,
        "accepted": True,
        "localTaskId": thread_id,
        "workspacePath": "/repo/Wegent",
    }
    assert fake_codex.archived_thread_ids == [thread_id]
    assert (
        handler.store.get_task(thread_id, workspace_path="/repo/Wegent").status
        == "archived"
    )


@pytest.mark.asyncio
async def test_runtime_work_handler_continues_discovered_codex_thread_through_sdk(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class FakeCodexStreamDiscovery:
        def __init__(self, started, release, finished):
            self.streamed_messages = []
            self.started = started
            self.release = release
            self.finished = finished

        def discover(self):
            return []

        async def stream_message(self, thread_id, message, *, cwd=None, emitter):
            self.streamed_messages.append((thread_id, message, cwd))
            self.started.set()
            await self.release.wait()
            await emitter.start(shell_type="Codex")
            await emitter.text_delta("done")
            await emitter.done("done")
            self.finished.set()

    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()
    discovery = FakeCodexStreamDiscovery(started, release, finished)
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
            created_at="2026-06-21T02:15:37Z",
            updated_at="2026-06-21T02:15:58Z",
            running=False,
            status="active",
        )
    )

    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=discovery,
        responses_event_emitter=lambda _event, _payload: None,
    )
    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "continue from Telegram",
            },
        }
    )

    assert result["success"] is True
    assert result["accepted"] is True
    await asyncio.wait_for(started.wait(), timeout=1)
    assert discovery.streamed_messages == [
        (thread_id, "continue from Telegram", "/repo/Wegent")
    ]
    assert store.get_task(thread_id, workspace_path="/repo/Wegent").running is True
    second_result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "second send",
            },
        }
    )
    assert second_result == {
        "success": False,
        "error": "runtime task is already running",
        "code": "bad_request",
    }
    release.set()
    await asyncio.wait_for(finished.wait(), timeout=1)
    await asyncio.gather(*handler._running_sdk_tasks)
    assert store.get_task(thread_id, workspace_path="/repo/Wegent").running is False


@pytest.mark.asyncio
async def test_runtime_work_handler_rejects_concurrent_sdk_codex_send_atomically(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class SlowCodexStreamDiscovery:
        def __init__(self):
            self.calls = 0
            self.release = asyncio.Event()

        def discover(self):
            return []

        async def stream_message(self, _thread_id, _message, *, cwd=None, emitter):
            self.calls += 1
            await self.release.wait()
            await emitter.done("done")

    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    discovery = SlowCodexStreamDiscovery()
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
        )
    )
    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=discovery,
        responses_event_emitter=lambda _event, _payload: None,
    )
    payload = {
        "method": "runtime.tasks.send",
        "payload": {
            "workspacePath": "/repo/Wegent",
            "localTaskId": thread_id,
            "message": "continue",
        },
    }

    first, second = await asyncio.gather(
        handler.handle_runtime_rpc(payload),
        handler.handle_runtime_rpc(payload),
    )

    assert sorted(result["success"] for result in [first, second]) == [False, True]
    assert discovery.calls == 1
    discovery.release.set()
    await asyncio.gather(*handler._running_sdk_tasks)


@pytest.mark.asyncio
async def test_runtime_work_handler_streams_discovered_codex_thread_over_responses_events(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class FakeCodexStreamDiscovery:
        def discover(self):
            return []

        async def stream_message(self, thread_id, message, *, cwd=None, emitter):
            await emitter.start(shell_type="Codex")
            await emitter.text_delta("Hello")
            await emitter.done("Hello")

    events = []
    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
            running=False,
            status="active",
        )
    )

    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=FakeCodexStreamDiscovery(),
        responses_event_emitter=lambda event, payload: events.append((event, payload)),
    )
    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "continue",
            },
        }
    )

    assert result["success"] is True
    assert result["accepted"] is True
    await asyncio.gather(*handler._running_sdk_tasks)
    assert [event for event, _payload in events] == [
        "response.created",
        "response.output_text.delta",
        "response.completed",
    ]
    assert all(payload["local_task_id"] == thread_id for _event, payload in events)
    assert all("workspace_path" not in payload for _event, payload in events)
    assert all("workspacePath" not in payload for _event, payload in events)
    assert events[1][1]["data"]["delta"] == "Hello"


@pytest.mark.asyncio
async def test_runtime_work_handler_emits_error_when_sdk_stream_fails(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class FailingCodexStreamDiscovery:
        def discover(self):
            return []

        async def stream_message(self, thread_id, message, *, cwd=None, emitter):
            await emitter.start(shell_type="Codex")
            raise RuntimeError("stream failed")

    events = []
    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
            running=False,
            status="active",
        )
    )

    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=FailingCodexStreamDiscovery(),
        responses_event_emitter=lambda event, payload: events.append((event, payload)),
    )

    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "continue",
            },
        }
    )

    assert result["accepted"] is True
    await asyncio.gather(*handler._running_sdk_tasks)
    assert [event for event, _payload in events] == ["response.created", "error"]
    assert events[-1][1]["data"]["message"] == "stream failed"
    assert events[-1][1]["data"]["code"] == "execution_error"
    assert store.get_task(thread_id, workspace_path="/repo/Wegent").running is False


@pytest.mark.asyncio
async def test_runtime_work_handler_includes_im_source_on_sdk_stream_events(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class FakeCodexStreamDiscovery:
        def discover(self):
            return []

        async def stream_message(self, thread_id, message, *, cwd=None, emitter):
            await emitter.start(shell_type="Codex")
            await emitter.text_delta("Hello")

    events = []
    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    source = {
        "source": "im",
        "external_id": "session-1",
        "channel_type": "telegram",
        "channel_id": 10,
        "conversation_id": "12345",
        "sender_id": "sender-1",
    }
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
            running=False,
            status="active",
        )
    )

    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=FakeCodexStreamDiscovery(),
        responses_event_emitter=lambda event, payload: events.append((event, payload)),
    )
    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "continue",
                "source": source,
            },
        }
    )

    assert result["accepted"] is True
    await asyncio.gather(*handler._running_sdk_tasks)
    assert events
    assert all(payload["source"] == source for _event, payload in events)


@pytest.mark.asyncio
async def test_runtime_work_handler_rejects_sdk_codex_send_without_event_emitter(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class FakeCodexStreamDiscovery:
        def __init__(self):
            self.streamed = False

        def discover(self):
            return []

        async def stream_message(self, thread_id, message, *, cwd=None, emitter):
            self.streamed = True

    thread_id = "019ee7f6-456a-78a1-96b1-66451afc310e"
    discovery = FakeCodexStreamDiscovery()
    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={"threadId": thread_id},
            running=False,
            status="active",
        )
    )

    result = await RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": SimpleNamespace()},
        codex_discovery=discovery,
    ).handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
                "message": "continue",
            },
        }
    )

    assert result == {
        "success": False,
        "error": "Responses API event emitter is not available",
        "code": "unsupported_runtime",
    }
    assert discovery.streamed is False
    assert store.get_task(thread_id, workspace_path="/repo/Wegent").running is False


@pytest.mark.asyncio
async def test_runtime_work_handler_normalizes_content_payload_before_send(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class EmptyDiscovery:
        def discover(self):
            return []

    class SendAdapter:
        def __init__(self):
            self.payload = None

        async def send(self, task, payload):
            self.payload = payload
            return {"accepted": True, "localTaskId": task.local_task_id}

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="runtime-1",
            workspace_path="/repo/Wegent",
            title="Continue",
            runtime="claude_code",
            runtime_handle={},
        )
    )
    adapter = SendAdapter()

    result = await RuntimeWorkRpcHandler(
        store=store,
        adapters={"claude_code": adapter},
        codex_discovery=EmptyDiscovery(),
    ).handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": "runtime-1",
                "content": "continue from content",
            },
        }
    )

    assert result["success"] is True
    assert adapter.payload["message"] == "continue from content"


@pytest.mark.asyncio
async def test_runtime_agent_adapter_rejects_blank_workspace_before_store_write(
    tmp_path,
):
    from executor.runtime_work.agent_adapter import RuntimeAgentAdapter
    from executor.runtime_work.local_task_store import LocalTaskStore

    async def execute_agent(_request, _emitter):
        raise AssertionError("agent execution should not start")

    store = LocalTaskStore(tmp_path / "index.json")
    adapter = RuntimeAgentAdapter(
        runtime="claude_code",
        store=store,
        execute_agent=execute_agent,
        run_background=False,
    )

    with pytest.raises(ValueError, match="workspacePath is required"):
        await adapter.create({"workspacePath": " ", "message": "hello"})

    assert store.list_tasks(include_archived=True) == []


def test_codex_discovery_reads_threads_from_codex_sdk_thread_list(tmp_path):
    discovery, fake_codex = _codex_discovery_for_threads(
        tmp_path / "codex-home",
        SimpleNamespace(
            id="019ee7f6-456a-78a1-96b1-66451afc310e",
            cwd="/repo/Wegent",
            name=None,
            preview="hi",
            path=str(tmp_path / "newer.jsonl"),
            git_info=SimpleNamespace(
                branch="main",
                origin_url="https://github.com/wecode-ai/Wegent.git",
                sha="abc123",
            ),
            created_at=1782008137,
            updated_at=1782008158,
        ),
        SimpleNamespace(
            id="019ee63d-8a0a-7170-a072-28f06a26e165",
            cwd="/repo/Wegent",
            name=None,
            preview="hi",
            path=str(tmp_path / "older.jsonl"),
            created_at=1781979253,
            updated_at=1781979275,
        ),
    )

    records = discovery.discover()

    assert fake_codex.calls[0]["use_state_db_only"] is True
    assert [record.local_task_id for record in records] == [
        "019ee7f6-456a-78a1-96b1-66451afc310e",
        "019ee63d-8a0a-7170-a072-28f06a26e165",
    ]
    assert [record.title for record in records] == ["hi", "hi"]
    assert {record.workspace_path for record in records} == {"/repo/Wegent"}
    assert (
        records[0].created_at
        == datetime.fromtimestamp(
            1782008137,
            timezone.utc,
        ).isoformat()
    )
    assert (
        records[0].updated_at
        == datetime.fromtimestamp(
            1782008158,
            timezone.utc,
        ).isoformat()
    )
    assert records[0].runtime_handle == {
        "threadId": "019ee7f6-456a-78a1-96b1-66451afc310e",
        "sessionPath": str(tmp_path / "newer.jsonl"),
        "gitInfo": {
            "branch": "main",
            "originUrl": "https://github.com/wecode-ai/Wegent.git",
            "sha": "abc123",
        },
    }


def test_codex_discovery_passes_resolved_codex_binary_to_sdk(tmp_path, monkeypatch):
    from executor.runtime_work import codex_discovery

    class FakeCodexConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeCodex:
        def __init__(self, config):
            self.config = config

    openai_codex_stub = ModuleType("openai_codex")
    openai_codex_stub.Codex = FakeCodex
    openai_codex_stub.CodexConfig = FakeCodexConfig
    monkeypatch.setitem(sys.modules, "openai_codex", openai_codex_stub)
    monkeypatch.setattr(
        codex_discovery,
        "_resolve_codex_binary",
        lambda value: "/Applications/Codex.app/Contents/Resources/codex",
    )
    monkeypatch.setattr(codex_discovery.config, "CODEX_BINARY_PATH", "codex")

    client = codex_discovery.CodexSessionDiscovery(
        codex_home=tmp_path / "codex-home"
    )._create_codex_client()

    assert (
        client.config.kwargs["codex_bin"]
        == "/Applications/Codex.app/Contents/Resources/codex"
    )
    assert client.config.kwargs["env"]["CODEX_HOME"] == str(tmp_path / "codex-home")


def test_codex_discovery_reads_user_visible_transcript(tmp_path):
    from executor.runtime_work.codex_discovery import CodexSessionDiscovery

    codex_home = tmp_path / "codex-home"
    session_dir = codex_home / "sessions" / "2026" / "06" / "20"
    session_dir.mkdir(parents=True)
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ad"
    session_path = session_dir / f"rollout-2026-06-20T13-52-19-{thread_id}.jsonl"
    session_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "timestamp": "2026-06-20T05:52:19Z",
                        "type": "session_meta",
                        "payload": {
                            "id": thread_id,
                            "cwd": "/repo/Wegent",
                            "thread_source": "user",
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T05:52:20Z",
                        "type": "response_item",
                        "payload": {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "hidden context, not a visible reply",
                                }
                            ],
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T05:52:21Z",
                        "type": "event_msg",
                        "payload": {
                            "type": "user_message",
                            "message": "Implement runtime sidebar",
                            "images": [],
                            "local_images": [],
                            "text_elements": [],
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T05:52:22Z",
                        "type": "event_msg",
                        "payload": {
                            "type": "agent_message",
                            "message": "Working",
                            "phase": "in_progress",
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T05:52:23Z",
                        "type": "event_msg",
                        "payload": {
                            "type": "task_complete",
                            "turn_id": "turn-1",
                            "last_agent_message": "Implemented",
                            "completed_at": 1781963543,
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    transcript = CodexSessionDiscovery(codex_home=codex_home).read_transcript(
        thread_id,
        str(session_path),
    )

    assert [message["role"] for message in transcript] == ["user", "assistant"]
    assert [message["content"] for message in transcript] == [
        "Implement runtime sidebar",
        "Implemented",
    ]
    assert transcript[1]["status"] == "done"


@pytest.mark.asyncio
async def test_runtime_work_handler_refreshes_codex_sessions_before_listing(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ac"
    discovery, _fake_codex = _codex_discovery_for_threads(
        codex_home,
        SimpleNamespace(
            id=thread_id,
            cwd="/repo/Wegent",
            name="Codex task from device",
            path=None,
            created_at="2026-06-20T05:00:00Z",
            updated_at="2026-06-20T06:00:00Z",
            status=SimpleNamespace(type="running"),
        ),
    )

    store = LocalTaskStore(tmp_path / "index.json")
    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=discovery,
    ).handle_runtime_rpc({"method": "runtime.tasks.list", "payload": {}})

    assert result["success"] is True
    workspaces = {item["workspacePath"]: item for item in result["workspaces"]}
    task = workspaces["/repo/Wegent"]["localTasks"][0]
    assert task["localTaskId"] == thread_id
    assert task["runtime"] == "codex"
    assert task["running"] is True


@pytest.mark.asyncio
async def test_runtime_work_handler_emits_codex_native_update_after_seen_timestamp_changes(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    initial = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={"threadId": "codex-thread-1"},
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:05:00Z",
    )
    updated = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={
            "threadId": "codex-thread-1",
            "messages": [
                {
                    "id": "codex-thread-1:user:1",
                    "role": "user",
                    "content": "Implement this",
                    "status": "done",
                },
                {
                    "id": "codex-thread-1:assistant:1",
                    "role": "assistant",
                    "content": "Implemented from native Codex",
                    "status": "done",
                },
            ],
        },
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:06:00Z",
    )
    emitted = []

    async def emit_event(event_type, payload):
        emitted.append((event_type, payload))

    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=SequenceDiscovery([[initial], [updated]]),
        responses_event_emitter=emit_event,
    )

    await handler.poll_codex_updates_once()
    await handler.poll_codex_updates_once()

    assert len(emitted) == 1
    assert emitted[0][0] == "runtime.tasks.updated"
    assert emitted[0][1] == {
        "localTaskId": "codex-thread-1",
        "runtime": "codex",
        "title": "Native Codex task",
        "updatedAt": "2026-06-21T01:06:00Z",
        "status": "done",
        "content": "Implemented from native Codex",
    }


@pytest.mark.asyncio
async def test_runtime_work_handler_waits_for_terminal_codex_native_update(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    initial = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={"threadId": "codex-thread-1"},
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:05:00Z",
    )
    streaming = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={
            "threadId": "codex-thread-1",
            "messages": [
                {
                    "id": "codex-thread-1:assistant:1",
                    "role": "assistant",
                    "content": "Partial native Codex response",
                    "status": "streaming",
                },
            ],
        },
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:06:00Z",
    )
    completed = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={
            "threadId": "codex-thread-1",
            "messages": [
                {
                    "id": "codex-thread-1:assistant:1",
                    "role": "assistant",
                    "content": "Final native Codex response",
                    "status": "done",
                },
            ],
        },
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:06:00Z",
    )
    emitted = []

    async def emit_event(event_type, payload):
        emitted.append((event_type, payload))

    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=SequenceDiscovery([[initial], [streaming], [completed]]),
        responses_event_emitter=emit_event,
    )

    await handler.poll_codex_updates_once()
    await handler.poll_codex_updates_once()
    await handler.poll_codex_updates_once()

    assert emitted == [
        (
            "runtime.tasks.updated",
            {
                "localTaskId": "codex-thread-1",
                "runtime": "codex",
                "title": "Native Codex task",
                "updatedAt": "2026-06-21T01:06:00Z",
                "status": "done",
                "content": "Final native Codex response",
            },
        )
    ]


@pytest.mark.asyncio
async def test_runtime_work_handler_suppresses_codex_watcher_after_wegent_send(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    initial = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={"threadId": "codex-thread-1"},
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:05:00Z",
    )
    updated = LocalTaskRecord(
        local_task_id="codex-thread-1",
        workspace_path="/repo/Wegent",
        title="Native Codex task",
        runtime="codex",
        runtime_handle={"threadId": "codex-thread-1"},
        created_at="2026-06-21T01:00:00Z",
        updated_at="2026-06-21T01:06:00Z",
    )
    emitted = []

    async def emit_event(event_type, payload):
        emitted.append((event_type, payload))

    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=SequenceDiscovery([[initial], [updated]]),
        responses_event_emitter=emit_event,
    )

    await handler.poll_codex_updates_once()
    handler.mark_codex_task_updated_by_wegent("codex-thread-1")
    await handler.poll_codex_updates_once()

    assert emitted == []


@pytest.mark.asyncio
async def test_runtime_work_handler_reads_discovered_codex_transcript(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ae"
    session_dir = codex_home / "sessions" / "2026" / "06" / "20"
    session_dir.mkdir(parents=True)
    session_path = session_dir / f"rollout-2026-06-20T14-00-00-{thread_id}.jsonl"
    session_path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "timestamp": "2026-06-20T06:00:00Z",
                        "type": "session_meta",
                        "payload": {
                            "id": thread_id,
                            "cwd": "/repo/Wegent",
                            "thread_source": "user",
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T06:00:01Z",
                        "type": "event_msg",
                        "payload": {
                            "type": "user_message",
                            "message": "Show project task",
                        },
                    }
                ),
                json.dumps(
                    {
                        "timestamp": "2026-06-20T06:00:02Z",
                        "type": "event_msg",
                        "payload": {
                            "type": "task_complete",
                            "last_agent_message": "Project task is visible",
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    discovery, _fake_codex = _codex_discovery_for_threads(
        codex_home,
        SimpleNamespace(
            id=thread_id,
            cwd="/repo/Wegent",
            name="External Codex task",
            path=str(session_path),
            created_at="2026-06-20T05:00:00Z",
            updated_at="2026-06-20T06:00:00Z",
        ),
    )

    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=discovery,
    )
    await handler.handle_runtime_rpc({"method": "runtime.tasks.list", "payload": {}})

    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": thread_id,
            },
        }
    )

    assert result["success"] is True
    assert [message["content"] for message in result["messages"]] == [
        "Show project task",
        "Project task is visible",
    ]


@pytest.mark.asyncio
async def test_runtime_work_handler_marks_active_codex_streaming_message_with_subtask_id(
    tmp_path,
):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class StreamingDiscovery:
        def discover(self):
            return []

        def read_transcript(self, thread_id, session_path=None):
            return [
                {
                    "id": f"{thread_id}:user:1",
                    "role": "user",
                    "content": "hi",
                    "createdAt": "2026-06-21T12:00:00Z",
                    "status": "done",
                },
                {
                    "id": f"{thread_id}:assistant:1",
                    "role": "assistant",
                    "content": "partial",
                    "createdAt": "2026-06-21T12:00:01Z",
                    "status": "streaming",
                },
            ]

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="codex-1",
            workspace_path="/repo/Wegent",
            title="hi",
            runtime="codex",
            runtime_handle={
                "threadId": "codex-1",
                "activeSubtaskId": 7001,
            },
            running=True,
        )
    )

    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=StreamingDiscovery(),
    ).handle_runtime_rpc(
        {
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": "codex-1",
            },
        }
    )

    assert result["success"] is True
    assert result["messages"][1]["content"] == "partial"
    assert result["messages"][1]["subtaskId"] == 7001


@pytest.mark.asyncio
async def test_runtime_work_handler_creates_runtime_task_with_local_transcript(
    tmp_path,
):
    from executor.runtime_work.agent_adapter import RuntimeAgentAdapter
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class EmptyDiscovery:
        def discover(self):
            return []

    executed_requests = []

    async def execute_agent(request, emitter):
        executed_requests.append(request)
        await emitter.start(shell_type="ClaudeCode")
        await emitter.text_delta("Created")
        await emitter.done(content="Created")

    store = LocalTaskStore(tmp_path / "index.json")
    adapter = RuntimeAgentAdapter(
        runtime="claude_code",
        store=store,
        execute_agent=execute_agent,
    )
    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"claude_code": adapter},
        codex_discovery=EmptyDiscovery(),
    )

    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.create",
            "payload": {
                "runtime": "claude_code",
                "workspacePath": "/repo/Wegent",
                "message": "create the task",
                "title": "Create runtime task",
                "executionRequest": {
                    "task_id": 1001,
                    "subtask_id": 2001,
                    "team_id": 1,
                    "prompt": "create the task",
                    "workspace_source": "local_path",
                    "project_workspace_path": "/repo/Wegent",
                    "model_config": {},
                    "bot": [],
                },
            },
        }
    )

    assert result["success"] is True
    assert result["accepted"] is True
    local_task_id = result["localTaskId"]
    await _drain_runtime_adapter(adapter)

    transcript = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": local_task_id,
            },
        }
    )

    assert [message["role"] for message in transcript["messages"]] == [
        "user",
        "assistant",
    ]
    assert transcript["messages"][0]["content"] == "create the task"


@pytest.mark.asyncio
async def test_runtime_work_handler_imports_fork_package_with_parent_metadata(
    tmp_path,
    monkeypatch,
):
    from executor.runtime_work import fork_transfer
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    restored = {}

    async def restore_fork_package_archive(*, archive, workspace_path):
        restored["archive"] = archive
        restored["workspace_path"] = workspace_path

    monkeypatch.setattr(
        fork_transfer,
        "restore_fork_package_archive",
        restore_fork_package_archive,
    )
    store = LocalTaskStore(tmp_path / "index.json")
    handler = RuntimeWorkRpcHandler(store=store, codex_discovery=EmptyDiscovery())

    result = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.import_fork",
            "payload": {
                "source": {
                    "deviceId": "source-device",
                    "workspacePath": "/source/Wegent",
                    "localTaskId": "codex-1",
                },
                "workspacePath": str(tmp_path / "target"),
                "forkPackage": {
                    "sourceRuntime": "codex",
                    "title": "Forked runtime task",
                    "recentMessages": [
                        {"id": "m1", "role": "user", "content": "hello"}
                    ],
                    "runtimeHandle": {"threadId": "codex-1"},
                    "executorSession": {"agent": "CodeX", "threadId": "codex-1"},
                    "archive": {
                        "directUrls": ["http://source/archive"],
                        "downloadUrl": "https://storage/download",
                    },
                },
            },
        }
    )

    assert result["success"] is True
    assert result["accepted"] is True
    assert result["runtime"] == "codex"
    assert restored["archive"]["directUrls"] == ["http://source/archive"]
    record = store.get_task(
        result["localTaskId"], workspace_path=str(tmp_path / "target")
    )
    assert record.parent == {
        "deviceId": "source-device",
        "workspacePath": "/source/Wegent",
        "localTaskId": "codex-1",
    }
    assert record.runtime_handle["executorSession"] == {
        "agent": "CodeX",
        "threadId": "codex-1",
    }
    assert record.runtime_handle["messages"][0]["content"] == "hello"


@pytest.mark.asyncio
async def test_runtime_work_handler_sends_followup_with_same_runtime_session(tmp_path):
    from executor.runtime_work.agent_adapter import RuntimeAgentAdapter
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    class EmptyDiscovery:
        def discover(self):
            return []

    executed_requests = []

    async def execute_agent(request, emitter):
        executed_requests.append(request)
        await emitter.done(content=f"reply:{request.prompt}")

    store = LocalTaskStore(tmp_path / "index.json")
    adapter = RuntimeAgentAdapter(
        runtime="codex",
        store=store,
        execute_agent=execute_agent,
    )
    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={"codex": adapter},
        codex_discovery=EmptyDiscovery(),
    )
    create = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.create",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/repo/Wegent",
                "message": "first",
                "executionRequest": {
                    "task_id": 1002,
                    "subtask_id": 2002,
                    "team_id": 1,
                    "prompt": "first",
                    "workspace_source": "local_path",
                    "project_workspace_path": "/repo/Wegent",
                    "model_config": {"model": "openai", "api_format": "responses"},
                    "bot": [{"id": 7}],
                },
            },
        }
    )
    local_task_id = create["localTaskId"]
    await _drain_runtime_adapter(adapter)

    send = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": local_task_id,
                "message": "second",
            },
        }
    )
    await _drain_runtime_adapter(adapter)

    assert send["success"] is True
    assert send["accepted"] is True
    assert [request.task_id for request in executed_requests] == [1002, 1002]
    assert [request.subtask_id for request in executed_requests] == [2002, 2003]
    assert executed_requests[1].new_session is False
    assert executed_requests[1].prompt == "second"

    transcript = await handler.handle_runtime_rpc(
        {
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": local_task_id,
            },
        }
    )
    assert [message["content"] for message in transcript["messages"]] == [
        "first",
        "reply:first",
        "second",
        "reply:second",
    ]


@pytest.mark.asyncio
async def test_runtime_work_handler_transcript_overlays_im_source(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    store = LocalTaskStore(tmp_path / "index.json")
    store.upsert_task(
        LocalTaskRecord(
            local_task_id="codex-1",
            workspace_path="/repo/Wegent",
            title="Fix reconnect",
            runtime="codex",
            runtime_handle={
                "messages": [
                    {
                        "id": "m1",
                        "role": "user",
                        "content": "hello",
                        "createdAt": "2026-06-20T01:00:00Z",
                    }
                ],
                "sourceMetadataByMessageId": {
                    "m1": {
                        "source": "im",
                        "external_id": "ext-1",
                        "channel_type": "telegram",
                        "channel_id": 10,
                        "conversation_id": "conv-1",
                        "sender_id": "sender-1",
                    }
                },
            },
            created_at="2026-06-20T01:00:00Z",
            updated_at="2026-06-20T02:00:00Z",
            running=False,
        )
    )

    result = await RuntimeWorkRpcHandler(store=store).handle_runtime_rpc(
        {
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/repo/Wegent",
                "localTaskId": "codex-1",
            },
        }
    )

    assert result["success"] is True
    assert result["messages"][0]["source"]["source"] == "im"
    assert result["messages"][0]["source"]["conversation_id"] == "conv-1"

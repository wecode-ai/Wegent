# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json

import pytest


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


@pytest.mark.asyncio
async def test_runtime_work_handler_lists_tasks_by_workspace(tmp_path):
    from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    store = LocalTaskStore(tmp_path / "index.json")
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

    result = await RuntimeWorkRpcHandler(store=store).handle_runtime_rpc(
        {"method": "runtime.tasks.list", "payload": {}}
    )

    assert result["success"] is True
    workspaces = {item["workspacePath"]: item for item in result["workspaces"]}
    assert workspaces["/repo/Wegent"]["localTasks"][0]["localTaskId"] == "codex-1"
    assert workspaces["/repo/Other"]["localTasks"][0]["runtime"] == "claude_code"


def test_codex_discovery_indexes_external_codex_sessions_by_cwd(tmp_path):
    from executor.runtime_work.codex_discovery import CodexSessionDiscovery

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ab"
    (codex_home / "session_index.jsonl").write_text(
        json.dumps(
            {
                "id": thread_id,
                "thread_name": "Implement runtime sidebar",
                "updated_at": "2026-06-20T05:52:31Z",
            }
        ),
        encoding="utf-8",
    )
    session_dir = codex_home / "sessions" / "2026" / "06" / "20"
    session_dir.mkdir(parents=True)
    (session_dir / f"rollout-2026-06-20T13-52-19-{thread_id}.jsonl").write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {
                    "id": thread_id,
                    "cwd": "/repo/Wegent",
                    "thread_source": "user",
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    records = CodexSessionDiscovery(codex_home=codex_home).discover()

    assert len(records) == 1
    assert records[0].local_task_id == thread_id
    assert records[0].workspace_path == "/repo/Wegent"
    assert records[0].title == "Implement runtime sidebar"
    assert records[0].runtime == "codex"
    assert records[0].runtime_handle["threadId"] == thread_id
    assert records[0].runtime_handle["sessionPath"].endswith(f"{thread_id}.jsonl")


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
    from executor.runtime_work.codex_discovery import CodexSessionDiscovery
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ac"
    (codex_home / "session_index.jsonl").write_text(
        json.dumps(
            {
                "id": thread_id,
                "title": "Codex task from device",
                "updatedAt": "2026-06-20T06:00:00Z",
                "cwd": "/repo/Wegent",
                "running": True,
            }
        ),
        encoding="utf-8",
    )

    store = LocalTaskStore(tmp_path / "index.json")
    result = await RuntimeWorkRpcHandler(
        store=store,
        codex_discovery=CodexSessionDiscovery(codex_home=codex_home),
    ).handle_runtime_rpc({"method": "runtime.tasks.list", "payload": {}})

    assert result["success"] is True
    workspaces = {item["workspacePath"]: item for item in result["workspaces"]}
    task = workspaces["/repo/Wegent"]["localTasks"][0]
    assert task["localTaskId"] == thread_id
    assert task["runtime"] == "codex"
    assert task["running"] is True


@pytest.mark.asyncio
async def test_runtime_work_handler_reads_discovered_codex_transcript(tmp_path):
    from executor.runtime_work.codex_discovery import CodexSessionDiscovery
    from executor.runtime_work.local_task_store import LocalTaskStore
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    thread_id = "018f2d6b-8c7a-7abc-9def-0123456789ae"
    (codex_home / "session_index.jsonl").write_text(
        json.dumps(
            {
                "id": thread_id,
                "title": "External Codex task",
                "updatedAt": "2026-06-20T06:00:00Z",
            }
        ),
        encoding="utf-8",
    )
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

    handler = RuntimeWorkRpcHandler(
        store=LocalTaskStore(tmp_path / "index.json"),
        codex_discovery=CodexSessionDiscovery(codex_home=codex_home),
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
    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={
            "claude_code": RuntimeAgentAdapter(
                runtime="claude_code",
                store=store,
                execute_agent=execute_agent,
            )
        },
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
    await asyncio.sleep(0)

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
    assert transcript["messages"][1]["content"] == "Created"
    assert executed_requests[0].task_id == 1001
    assert executed_requests[0].new_session is True


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
    handler = RuntimeWorkRpcHandler(
        store=store,
        adapters={
            "codex": RuntimeAgentAdapter(
                runtime="codex",
                store=store,
                execute_agent=execute_agent,
            )
        },
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
    await asyncio.sleep(0)

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
    await asyncio.sleep(0)

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

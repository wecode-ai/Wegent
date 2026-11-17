# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Cross-process project comment push contracts."""

from contextlib import contextmanager

import pytest

from app.api.ws.wework_runtime_namespace import (
    PROJECT_CHAT_CREATED_EVENT,
    WEWORK_RUNTIME_NAMESPACE,
    project_chat_room,
)
from app.models.delivery import ProjectChatAgent
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat import message_provenance, push


@pytest.fixture(autouse=True)
def persisted_message(test_db, monkeypatch):
    row = ProjectChatMessage(
        message_id="message-1",
        project_id="project-1",
        task_id="TASK-1",
        sender_type="agent",
        sender_id="agent",
        content="Public result",
        runtime_device_id="device",
        runtime_task_id="task",
        metadata_json={},
        status="completed",
    )
    test_db.add(row)
    test_db.commit()

    @contextmanager
    def session():
        yield test_db

    monkeypatch.setattr(message_provenance, "get_db_session", session)
    return row


class _Manager:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def emit(self, event, data, **kwargs) -> None:
        self.calls.append({"event": event, "data": data, **kwargs})


def test_project_chat_push_uses_cross_process_redis_manager(monkeypatch) -> None:
    manager = _Manager()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)
    message = {
        "messageId": "message-1",
        "projectId": "project-1",
        "taskId": "TASK-1",
        "status": "completed",
    }

    push.push_project_chat_message(message)

    assert manager.calls == [
        {
            "event": PROJECT_CHAT_CREATED_EVENT,
            "data": {
                **message,
                "actorUserId": None,
                "actorDisplayName": None,
                "runtimeAddress": None,
                "traceRef": manager.calls[0]["data"]["traceRef"],
                "traceState": "restricted",
            },
            "room": project_chat_room("project-1", "TASK-1"),
            "namespace": WEWORK_RUNTIME_NAMESPACE,
        }
    ]


def test_project_chat_push_is_best_effort(monkeypatch, caplog) -> None:
    def unavailable():
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(push, "_publish_manager", unavailable)

    push.push_project_chat_message(
        {"messageId": "message-1", "projectId": "project-1", "taskId": "TASK-1"}
    )

    assert "Server message push failed" in caplog.text


def test_project_chat_push_refuses_unverified_room_projection(monkeypatch, caplog):
    manager = _Manager()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)

    def unavailable():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(message_provenance, "get_db_session", unavailable)
    push.push_project_chat_message(
        {
            "messageId": "message-1",
            "projectId": "project-1",
            "taskId": "TASK-1",
            "runtimeAddress": {"deviceId": "device", "taskId": "task"},
        }
    )

    assert manager.calls == []
    assert "Room projection failed message_id=message-1" in caplog.text


def test_project_chat_push_never_broadcasts_private_source_fields(monkeypatch) -> None:
    manager = _Manager()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)
    push.push_project_chat_message(
        {
            "messageId": "message-1",
            "projectId": "project-1",
            "taskId": "TASK-1",
            "type": "agent_chunk",
            "content": "private tool output",
            "runtimeAddress": {"deviceId": "device", "taskId": "task"},
            "traceRef": "trace",
            "metadata": {
                "private_prompt": "not shared",
                "run_status": "running",
                "execution_id": 42,
                "contentMode": "delta",
            },
        }
    )

    payload = manager.calls[0]["data"]
    assert payload["runtimeAddress"] is None
    assert payload["traceState"] == "restricted"
    assert payload["content"] == ""
    assert payload["metadata"] == {"run_status": "running"}


def test_project_chat_push_preserves_shared_terminal_execution(
    test_db, persisted_message, monkeypatch
) -> None:
    agent = ProjectChatAgent(
        id="shared-agent",
        cloud_project_id="project-1",
        title="Collector",
        name="Collector",
        created_by_user_id=999,
        metadata_json={"visibility": "public"},
    )
    persisted_message.agent_id = agent.id
    persisted_message.metadata_json = {
        "workflow_task_title": "Collect CPU evidence",
        "run_status": "succeeded",
        "execution_id": 42,
        "private_prompt": "not shared",
    }
    test_db.add(agent)
    test_db.commit()
    manager = _Manager()
    monkeypatch.setattr(push, "_publish_manager", lambda: manager)
    from app.services.project_chat.service import project_chat_service

    view = project_chat_service.to_view(persisted_message, db=test_db).model_dump(
        by_alias=True
    )

    push.push_project_chat_message(view)

    payload = manager.calls[0]["data"]
    assert payload["status"] == "completed"
    assert payload["runtimeAddress"] == {"deviceId": "device", "taskId": "task"}
    assert payload["traceState"] == "available"
    assert payload["metadata"] == {
        "workflow_task_title": "Collect CPU evidence",
        "run_status": "succeeded",
        "execution_id": 42,
    }

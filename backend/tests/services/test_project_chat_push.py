# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Cross-process project comment push contracts."""

from app.api.ws.wework_runtime_namespace import (
    PROJECT_CHAT_CREATED_EVENT,
    WEWORK_RUNTIME_NAMESPACE,
    project_chat_room,
)
from app.services.project_chat import push


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
            "data": message,
            "room": project_chat_room("project-1", "TASK-1"),
            "namespace": WEWORK_RUNTIME_NAMESPACE,
        }
    ]


def test_project_chat_push_is_best_effort(monkeypatch, caplog) -> None:
    def unavailable():
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(push, "_publish_manager", unavailable)

    push.push_project_chat_message({"messageId": "message-1", "projectId": "project-1"})

    assert "Server message push failed" in caplog.text

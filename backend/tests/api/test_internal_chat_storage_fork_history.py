# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.internal import chat_storage
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.task_fork_history import ForkHistoryItem


def _subtask(message_id: int, role: SubtaskRole):
    return SimpleNamespace(
        id=message_id,
        task_id=2,
        user_id=7,
        role=role,
        status=SubtaskStatus.COMPLETED,
        message_id=message_id,
        prompt="hello" if role == SubtaskRole.USER else None,
        result={"value": "world"} if role == SubtaskRole.ASSISTANT else None,
        contexts=[],
        sender_user_id=None,
    )


def _patch_internal_history(monkeypatch, items, *, resolver_applies_limit=False):
    def resolve_for_task(db, *, task_id, user_id, before_message_id=None, limit=None):
        if resolver_applies_limit and limit:
            return items[-limit:]
        return items

    monkeypatch.setattr(
        chat_storage,
        "task_store",
        SimpleNamespace(get_by_id=lambda db, *, task_id: SimpleNamespace(user_id=7)),
        raising=False,
    )
    monkeypatch.setattr(
        chat_storage,
        "task_fork_history_resolver",
        SimpleNamespace(resolve_for_task=resolve_for_task),
        raising=False,
    )
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "list_history_by_task_statuses",
        lambda *args, **kwargs: pytest.fail(
            "internal history should use fork resolver"
        ),
    )
    monkeypatch.setattr(
        chat_storage,
        "subtask_to_messages",
        lambda subtask, db, is_group_chat=False: [
            {
                "id": str(subtask.id),
                "role": subtask.role.value.lower(),
                "content": (
                    subtask.prompt
                    if subtask.role == SubtaskRole.USER
                    else (subtask.result or {}).get("value", "")
                ),
            }
        ],
    )


@pytest.fixture
def internal_chat_client():
    app = FastAPI()
    app.include_router(chat_storage.router, prefix="/internal")
    app.dependency_overrides[get_db] = lambda: SimpleNamespace()
    return TestClient(app)


def test_internal_history_uses_fork_resolver(internal_chat_client, monkeypatch):
    items = [
        ForkHistoryItem(_subtask(1, SubtaskRole.USER), True, 1, 1),
        ForkHistoryItem(_subtask(2, SubtaskRole.ASSISTANT), True, 1, 2),
    ]

    _patch_internal_history(monkeypatch, items)

    response = internal_chat_client.get("/internal/chat/history/task-2")

    assert response.status_code == 200
    assert [message["role"] for message in response.json()["messages"]] == [
        "user",
        "assistant",
    ]


def test_internal_history_applies_limit_after_status_filter(
    internal_chat_client, monkeypatch
):
    pending = _subtask(3, SubtaskRole.ASSISTANT)
    pending.status = SubtaskStatus.PENDING
    items = [
        ForkHistoryItem(_subtask(1, SubtaskRole.USER), True, 1, 1),
        ForkHistoryItem(_subtask(2, SubtaskRole.ASSISTANT), True, 1, 2),
        ForkHistoryItem(pending, False, 2, 3),
    ]
    _patch_internal_history(monkeypatch, items, resolver_applies_limit=True)

    response = internal_chat_client.get("/internal/chat/history/task-2?limit=2")

    assert response.status_code == 200
    assert [message["id"] for message in response.json()["messages"]] == ["1", "2"]

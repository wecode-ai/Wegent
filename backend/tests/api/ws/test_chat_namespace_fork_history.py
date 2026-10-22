# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.api.ws import chat_namespace
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.services.task_fork_history import ForkHistoryItem


@contextmanager
def _db_session():
    yield SimpleNamespace()


def _subtask(message_id: int, role: SubtaskRole = SubtaskRole.ASSISTANT):
    return SimpleNamespace(
        id=message_id,
        task_id=2,
        user_id=7,
        role=role,
        status=SubtaskStatus.COMPLETED,
        message_id=message_id,
        prompt="hello" if role == SubtaskRole.USER else None,
        result={"value": "world"} if role == SubtaskRole.ASSISTANT else None,
        progress=100,
        created_at=None,
        updated_at=None,
        completed_at=None,
    )


def test_fetch_history_messages_uses_fork_resolver(monkeypatch):
    item = ForkHistoryItem(_subtask(2), True, 1, 2)

    monkeypatch.setattr(chat_namespace, "get_db_session", _db_session)
    monkeypatch.setattr(
        chat_namespace,
        "task_fork_history_resolver",
        SimpleNamespace(
            resolve_for_task=lambda db, *, task_id, user_id, after_message_id=None: [
                item
            ]
        ),
        raising=False,
    )
    monkeypatch.setattr(
        chat_namespace.task_stores.subtask_store,
        "list_after_message_id",
        lambda *args, **kwargs: pytest.fail("history sync should use fork resolver"),
    )

    messages = chat_namespace._fetch_history_messages(2, 7, 1)

    assert messages == [
        {
            "subtask_id": 2,
            "message_id": 2,
            "role": "ASSISTANT",
            "content": "world",
            "status": "COMPLETED",
            "created_at": None,
        }
    ]


def test_fetch_subtasks_for_task_join_incremental_uses_fork_resolver(monkeypatch):
    item = ForkHistoryItem(_subtask(2), True, 1, 2)

    monkeypatch.setattr(chat_namespace, "get_db_session", _db_session)
    monkeypatch.setattr(
        chat_namespace,
        "task_fork_history_resolver",
        SimpleNamespace(
            resolve_for_task=lambda db, *, task_id, user_id, after_message_id=None: [
                item
            ]
        ),
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.context.context_service.get_briefs_by_subtask",
        lambda db, subtask_id: [],
    )
    monkeypatch.setattr(
        chat_namespace.task_stores.subtask_store,
        "list_after_message_id",
        lambda *args, **kwargs: pytest.fail("task join should use fork resolver"),
    )

    subtasks = chat_namespace._fetch_subtasks_for_task_join(2, 7, 1)

    assert subtasks[0]["id"] == 2
    assert subtasks[0]["message_id"] == 2
    assert subtasks[0]["role"] == "ASSISTANT"


def test_fetch_subtasks_for_task_join_incremental_serializes_user_sender(monkeypatch):
    item = ForkHistoryItem(_subtask(2, SubtaskRole.USER), True, 1, 2)
    user = SimpleNamespace(id=7, user_name="alice")
    query = SimpleNamespace(
        filter=lambda *args, **kwargs: SimpleNamespace(first=lambda: user)
    )

    @contextmanager
    def db_session_with_user():
        yield SimpleNamespace(query=lambda model: query)

    monkeypatch.setattr(chat_namespace, "get_db_session", db_session_with_user)
    monkeypatch.setattr(
        chat_namespace,
        "task_fork_history_resolver",
        SimpleNamespace(
            resolve_for_task=lambda db, *, task_id, user_id, after_message_id=None: [
                item
            ]
        ),
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.context.context_service.get_briefs_by_subtask",
        lambda db, subtask_id: [],
    )

    subtasks = chat_namespace._fetch_subtasks_for_task_join(2, 7, 1)

    assert subtasks[0]["sender"] == {
        "user_id": 7,
        "user_name": "alice",
    }

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the AI history-backtracking internal endpoints:

- ``GET /chat/history/{session_id}/subtasks`` — whole-session summary list.
- ``GET /chat/history/{session_id}/subtasks/{subtask_id}`` — one raw record.

Both are un-compaction-scoped and strictly session-owned.
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints.internal import chat_storage
from app.core.config import settings
from app.models.subtask import SubtaskRole, SubtaskStatus


def _subtask(sid, role, **kw):
    base = dict(
        id=sid,
        task_id=2,
        user_id=7,
        role=role,
        status=SubtaskStatus.COMPLETED,
        message_id=sid,
        prompt=None,
        result=None,
        contexts=[],
        sender_user_id=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


@pytest.fixture
def internal_chat_client(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")
    app = FastAPI()
    app.include_router(chat_storage.router, prefix="/internal")
    app.dependency_overrides[get_db] = lambda: SimpleNamespace()
    return TestClient(app, headers={"Authorization": "Bearer test-internal-token"})


def _patch_task(monkeypatch, user_id=7):
    monkeypatch.setattr(
        chat_storage,
        "task_store",
        SimpleNamespace(
            get_by_id=lambda db, *, task_id: (
                SimpleNamespace(user_id=user_id) if task_id == 2 else None
            )
        ),
        raising=False,
    )


def test_list_subtasks_returns_summaries(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    subtasks = [
        _subtask(1, SubtaskRole.USER, prompt="hello world"),
        _subtask(2, SubtaskRole.ASSISTANT, result={"value": "hi there"}),
    ]
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "list_new_messages_since",
        lambda db, **kw: subtasks,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks")

    assert resp.status_code == 200
    data = resp.json()["subtasks"]
    assert [s["id"] for s in data] == [1, 2]
    assert data[0]["role"] == "user"
    assert data[0]["preview"] == "hello world"
    assert data[0]["char_count"] == len("hello world")
    assert data[1]["preview"] == "hi there"


def test_list_subtasks_skips_deleted(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    deleted = _subtask(3, SubtaskRole.ASSISTANT, result={"value": "gone"})
    deleted.status = SubtaskStatus.DELETE
    subtasks = [_subtask(1, SubtaskRole.USER, prompt="keep"), deleted]
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "list_new_messages_since",
        lambda db, **kw: subtasks,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks")

    assert resp.status_code == 200
    assert [s["id"] for s in resp.json()["subtasks"]] == [1]


def test_read_subtask_returns_blocks(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    st = _subtask(
        2,
        SubtaskRole.ASSISTANT,
        result={"blocks": [{"type": "text", "text": "a"}], "value": "a"},
    )
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: st if subtask_id == 2 else None,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks/2")

    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "assistant"
    assert body["blocks"] == [{"type": "text", "text": "a"}]
    assert body["value"] == "a"


def test_read_subtask_user_returns_prompt(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    st = _subtask(1, SubtaskRole.USER, prompt="the question")
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: st,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks/1")

    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "user"
    assert body["prompt"] == "the question"
    assert body["blocks"] is None


def test_read_subtask_rejects_deleted(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    deleted = _subtask(4, SubtaskRole.ASSISTANT, result={"value": "gone"})
    deleted.status = SubtaskStatus.DELETE
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: deleted,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks/4")

    assert resp.status_code == 404


def test_read_subtask_rejects_foreign_task(internal_chat_client, monkeypatch):
    _patch_task(monkeypatch)
    foreign = _subtask(9, SubtaskRole.ASSISTANT, task_id=999, result={"value": "x"})
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: foreign,
        raising=False,
    )

    resp = internal_chat_client.get("/internal/chat/history/task-2/subtasks/9")

    assert resp.status_code == 404

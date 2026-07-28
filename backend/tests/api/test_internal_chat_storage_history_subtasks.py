# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""HTTP-wiring tests for the AI history-backtracking endpoints.

- ``GET /chat/history/{session_id}/subtasks`` — paged summary list.
- ``GET /chat/history/{session_id}/subtasks/{subtask_id}`` — one transcript page.

Windowing/rendering logic is unit-tested in ``services/chat/test_subtask_history``;
these cover the HTTP shape and session ownership.
"""

from types import SimpleNamespace

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
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _internal_client(monkeypatch):
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


def test_list_subtasks_returns_paged_summaries(monkeypatch):
    client = _internal_client(monkeypatch)
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

    resp = client.get("/internal/chat/history/task-2/subtasks")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["has_more"] is False
    assert [s["id"] for s in body["subtasks"]] == [1, 2]
    assert body["subtasks"][0]["preview"] == "hello world"


def test_read_subtask_returns_rendered_page(monkeypatch):
    client = _internal_client(monkeypatch)
    _patch_task(monkeypatch)
    st = _subtask(
        2,
        SubtaskRole.ASSISTANT,
        result={"blocks": [{"type": "text", "content": "hello detail"}]},
    )
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: st if subtask_id == 2 else None,
        raising=False,
    )

    resp = client.get("/internal/chat/history/task-2/subtasks/2")

    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "assistant"
    assert body["content"] == "hello detail"
    assert body["has_more"] is False
    assert body["cursor"] == "0:0"


def test_read_subtask_rejects_deleted(monkeypatch):
    client = _internal_client(monkeypatch)
    _patch_task(monkeypatch)
    deleted = _subtask(4, SubtaskRole.ASSISTANT, result={"value": "gone"})
    deleted.status = SubtaskStatus.DELETE
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: deleted,
        raising=False,
    )

    resp = client.get("/internal/chat/history/task-2/subtasks/4")
    assert resp.status_code == 404


def test_read_subtask_rejects_foreign_task(monkeypatch):
    client = _internal_client(monkeypatch)
    _patch_task(monkeypatch)
    foreign = _subtask(9, SubtaskRole.ASSISTANT, task_id=999, result={"value": "x"})
    monkeypatch.setattr(
        chat_storage.subtask_store,
        "get_by_id",
        lambda db, *, subtask_id, owner_user_id=None: foreign,
        raising=False,
    )

    resp = client.get("/internal/chat/history/task-2/subtasks/9")
    assert resp.status_code == 404

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.task import TaskResource
from app.models.user import User


@pytest.fixture(autouse=True)
def configure_internal_chat_auth(
    monkeypatch: pytest.MonkeyPatch,
    test_client: TestClient,
) -> None:
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "test-internal-token")
    test_client.headers["Authorization"] = "Bearer test-internal-token"


def _create_task(db: Session, *, user_id: int, task_id: int) -> TaskResource:
    task = TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {"title": f"task-{task_id}", "prompt": ""},
            "status": {"state": "Available", "status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _create_user_subtask(db: Session, *, user_id: int, task_id: int) -> Subtask:
    subtask = Subtask(
        user_id=user_id,
        task_id=task_id,
        team_id=1,
        title="user-message",
        bot_ids=[1],
        role=SubtaskRole.USER,
        prompt="hello",
        message_id=1,
        parent_id=0,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        completed_at=datetime.now(),
    )
    db.add(subtask)
    db.commit()
    db.refresh(subtask)
    return subtask


def _create_attachment(
    db: Session,
    *,
    user_id: int,
    subtask_id: int,
    extracted_text: str,
    status: str = ContextStatus.READY.value,
) -> SubtaskContext:
    ctx = SubtaskContext(
        subtask_id=subtask_id,
        user_id=user_id,
        context_type=ContextType.ATTACHMENT.value,
        name="report.pdf",
        status=status,
        binary_data=b"",
        extracted_text=extracted_text,
        text_length=len(extracted_text),
        type_data={"mime_type": "application/pdf", "original_filename": "report.pdf"},
    )
    db.add(ctx)
    db.commit()
    db.refresh(ctx)
    return ctx


def test_get_attachment_text_returns_slice(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7001
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    sub = _create_user_subtask(test_db, user_id=test_user.id, task_id=task_id)
    ctx = _create_attachment(
        test_db, user_id=test_user.id, subtask_id=sub.id, extracted_text="0123456789"
    )

    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 4},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == "0123"
    assert body["total_chars"] == 10
    assert body["has_more"] is True
    assert body["mime_type"] == "application/pdf"
    assert body["source_truncated"] is False

    # Tail slice
    resp2 = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 8, "limit": 100},
    )
    body2 = resp2.json()
    assert body2["text"] == "89"
    assert body2["has_more"] is False


def test_cross_task_attachment_is_denied(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_a, task_b = 7101, 7102
    _create_task(test_db, user_id=test_user.id, task_id=task_a)
    _create_task(test_db, user_id=test_user.id, task_id=task_b)
    sub_b = _create_user_subtask(test_db, user_id=test_user.id, task_id=task_b)
    ctx = _create_attachment(
        test_db, user_id=test_user.id, subtask_id=sub_b.id, extracted_text="secret"
    )

    # Request the task_b attachment through task_a's session.
    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_a}", "offset": 0, "limit": 10},
    )
    # 404 (not 403): don't leak existence of attachments in other conversations.
    assert resp.status_code == 404


def test_unlinked_attachment_same_user_allowed(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7401
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    # Unlinked (subtask_id == 0) but owned by the task's user — readable.
    ctx = _create_attachment(
        test_db, user_id=test_user.id, subtask_id=0, extracted_text="preset"
    )
    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 10},
    )
    assert resp.status_code == 200
    assert resp.json()["text"] == "preset"


def test_unlinked_attachment_other_user_denied(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7501
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    # Unlinked attachment owned by a DIFFERENT user — must not be readable, so
    # the model cannot probe arbitrary unlinked ids across users.
    ctx = _create_attachment(
        test_db, user_id=test_user.id + 9999, subtask_id=0, extracted_text="secret"
    )
    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 10},
    )
    # 404 (not 403): don't leak existence across users.
    assert resp.status_code == 404


def test_source_truncated_flag_propagates(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7601
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    sub = _create_user_subtask(test_db, user_id=test_user.id, task_id=task_id)
    ctx = _create_attachment(
        test_db, user_id=test_user.id, subtask_id=sub.id, extracted_text="partial"
    )
    # Mark the stored extract as parse-truncated.
    ctx.type_data = {**ctx.type_data, "is_truncated": True}
    test_db.commit()

    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 100},
    )
    assert resp.status_code == 200
    assert resp.json()["source_truncated"] is True


def test_oversized_limit_is_rejected(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7701
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    sub = _create_user_subtask(test_db, user_id=test_user.id, task_id=task_id)
    ctx = _create_attachment(
        test_db, user_id=test_user.id, subtask_id=sub.id, extracted_text="0123456789"
    )
    # A page is token-clamped anyway; the endpoint caps a single slice.
    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 10_000_000},
    )
    assert resp.status_code == 422


def test_missing_attachment_returns_404(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7201
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    resp = test_client.get(
        "/api/internal/chat/attachments/999999/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 10},
    )
    assert resp.status_code == 404


def test_non_ready_attachment_returns_404(
    test_client: TestClient, test_db: Session, test_user: User
):
    task_id = 7301
    _create_task(test_db, user_id=test_user.id, task_id=task_id)
    sub = _create_user_subtask(test_db, user_id=test_user.id, task_id=task_id)
    ctx = _create_attachment(
        test_db,
        user_id=test_user.id,
        subtask_id=sub.id,
        extracted_text="pending",
        status=ContextStatus.PENDING.value,
    )
    resp = test_client.get(
        f"/api/internal/chat/attachments/{ctx.id}/text",
        params={"session_id": f"task-{task_id}", "offset": 0, "limit": 10},
    )
    assert resp.status_code == 404

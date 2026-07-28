# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API tests for Wework feedback submission."""

import json
import uuid
from typing import BinaryIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import CloudProject, LoopItem
from app.models.user import User


class FeedbackStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.objects[object_key] = stream.read(length)

    def remove_objects(self, object_keys: list[str]) -> None:
        for object_key in object_keys:
            self.objects.pop(object_key, None)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def feedback_project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="FEEDBACK",
        name="Wework feedback",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


@pytest.fixture
def feedback_storage(monkeypatch: pytest.MonkeyPatch) -> FeedbackStorage:
    storage = FeedbackStorage()
    monkeypatch.setattr("app.services.loop_items.service.delivery_storage", storage)
    return storage


def _feedback_form(report_id: str, title: str) -> dict[str, str]:
    return {
        "report_id": report_id,
        "title": title,
        "description": "The send button remained disabled.",
        "context": json.dumps({"taskId": "task-1", "version": "1.2.3"}),
    }


def test_submit_feedback_creates_board_item_for_current_user(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    feedback_project: CloudProject,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "WEWORK_FEEDBACK_PROJECT_ID", str(feedback_project.id)
    )

    response = test_client.post(
        "/api/v1/feedback",
        headers=_auth(test_token),
        data=_feedback_form("WF-100", "Workbench stopped responding"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert response.status_code == 201
    assert response.json() == {
        "report_id": "WF-100",
        "project_id": str(feedback_project.id),
        "item_id": "FEEDBACK-1",
        "created_by_user_id": test_user.id,
        "duplicate": False,
    }
    item = test_db.get(LoopItem, "FEEDBACK-1")
    assert item is not None
    assert item.created_by_user_id == test_user.id
    assert item.status == "inbox"
    assert item.metadata_json == {
        "tags": ["feedback", "wework"],
        "feedback_report_id": "WF-100",
    }
    assert item.description == (
        "The send button remained disabled.\n\nFeedback report: WF-100"
    )
    assert "taskId" not in item.description
    assert list(feedback_storage.objects.values()) == [b"diagnostics"]


def test_submit_feedback_keeps_large_diagnostic_context_out_of_description(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    feedback_project: CloudProject,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "WEWORK_FEEDBACK_PROJECT_ID", str(feedback_project.id)
    )
    form = _feedback_form("WF-LARGE", "Large diagnostics")
    form["context"] = json.dumps({"runtimeLogs": "x" * 100_000})

    response = test_client.post(
        "/api/v1/feedback",
        headers=_auth(test_token),
        data=form,
        files={"bundle": ("feedback.zip", b"full diagnostics", "application/zip")},
    )

    assert response.status_code == 201
    item = test_db.get(LoopItem, "FEEDBACK-1")
    assert item is not None
    assert item.description == (
        "The send button remained disabled.\n\nFeedback report: WF-LARGE"
    )
    assert list(feedback_storage.objects.values()) == [b"full diagnostics"]


def test_submit_feedback_is_idempotent_per_user_and_report(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    feedback_project: CloudProject,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "WEWORK_FEEDBACK_PROJECT_ID", str(feedback_project.id)
    )
    request = _feedback_form("WF-RETRY", "Repeated feedback")
    files = {"bundle": ("feedback.zip", b"diagnostics", "application/zip")}

    first = test_client.post(
        "/api/v1/feedback", headers=_auth(test_token), data=request, files=files
    )
    second = test_client.post(
        "/api/v1/feedback", headers=_auth(test_token), data=request, files=files
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["item_id"] == second.json()["item_id"]
    assert first.json()["duplicate"] is False
    assert second.json()["duplicate"] is True
    assert test_db.query(LoopItem).filter(LoopItem.id == "FEEDBACK-1").count() == 1
    assert len(feedback_storage.objects) == 1


def test_submit_feedback_reports_unavailable_channel_when_not_configured(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", "")

    response = test_client.post(
        "/api/v1/feedback",
        headers=_auth(test_token),
        data=_feedback_form("WF-101", "Cannot submit"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "反馈通道异常，请联系开发者"

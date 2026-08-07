# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""API tests for Wework feedback submission."""

import io
import json
import uuid
from typing import BinaryIO

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from limits.storage import MemoryStorage
from limits.strategies import FixedWindowRateLimiter
from sqlalchemy.orm import Session

from app.api.endpoints import feedback as feedback_endpoint
from app.core.config import settings
from app.models.delivery import CloudProject, LoopItem
from app.models.user import User
from app.services.loop_items.external_provider import external_loop_item_provider


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

    def get_bytes(self, object_key: str, max_bytes: int | None = None) -> bytes:
        content = self.objects[object_key]
        return content if max_bytes is None else content[:max_bytes]


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


def test_submit_feedback_creates_board_item_for_feedback_project_owner(
    test_client: TestClient,
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
        data=_feedback_form("WF-100", "Workbench stopped responding"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert response.status_code == 201
    assert response.json() == {
        "report_id": "WF-100",
        "project_id": str(feedback_project.id),
        "item_id": "FEEDBACK-1",
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


def test_submit_feedback_is_idempotent_per_project_owner_and_report(
    test_client: TestClient,
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

    first = test_client.post("/api/v1/feedback", data=request, files=files)
    second = test_client.post("/api/v1/feedback", data=request, files=files)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["item_id"] == second.json()["item_id"]
    assert first.json()["duplicate"] is False
    assert second.json()["duplicate"] is True
    assert test_db.query(LoopItem).filter(LoopItem.id == "FEEDBACK-1").count() == 1
    assert len(feedback_storage.objects) == 1


def test_submit_feedback_rate_limits_anonymous_callers_by_ip(
    test_client: TestClient,
    feedback_project: CloudProject,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        settings, "WEWORK_FEEDBACK_PROJECT_ID", str(feedback_project.id)
    )
    storage = MemoryStorage()
    monkeypatch.setattr(feedback_endpoint.limiter, "_storage", storage)
    monkeypatch.setattr(
        feedback_endpoint.limiter,
        "_limiter",
        FixedWindowRateLimiter(storage),
    )
    monkeypatch.setattr(feedback_endpoint.limiter, "enabled", True)

    responses = [
        test_client.post(
            "/api/v1/feedback",
            data=_feedback_form(f"WF-RATE-{index}", f"Rate limit {index}"),
            files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
        )
        for index in range(6)
    ]

    assert [response.status_code for response in responses[:5]] == [201] * 5
    assert responses[5].status_code == 429


def test_submit_feedback_reports_unavailable_channel_when_not_configured(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", "")

    response = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-101", "Cannot submit"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "反馈通道异常，请联系开发者"


def test_submit_feedback_reports_unavailable_channel_when_project_is_missing(
    test_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", "999999999")

    response = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-MISSING", "Cannot submit"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "反馈通道异常，请联系开发者"


def test_submit_feedback_uses_gitlab_issue_provider_and_uploads_bundle(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="GLFEEDBACK",
        name="GitLab feedback",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": "gitlab", "provider_config": {}},
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", str(project.id))
    monkeypatch.setattr(
        external_loop_item_provider,
        "create",
        lambda _db, _project_id, _user_id, _user_name, _values: {"id": "GLFEEDBACK-7"},
    )
    monkeypatch.setattr(external_loop_item_provider, "list", lambda *_args: [])
    uploaded: dict[str, object] = {}

    def attach(
        _db: Session,
        item_id: str,
        user_id: int,
        filename: str,
        content_type: str,
        source: BinaryIO,
        max_size_bytes: int,
    ) -> None:
        uploaded.update(
            item_id=item_id,
            user_id=user_id,
            filename=filename,
            content_type=content_type,
            content=source.read(),
            max_size_bytes=max_size_bytes,
        )

    monkeypatch.setattr(external_loop_item_provider, "attach_gitlab_upload", attach)

    response = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-GITLAB", "GitLab feedback"),
        files={"bundle": ("feedback.zip", b"gitlab diagnostics", "application/zip")},
    )

    assert response.status_code == 201
    assert response.json()["item_id"] == "GLFEEDBACK-7"
    assert "created_by_user_id" not in response.json()
    assert uploaded == {
        "item_id": "GLFEEDBACK-7",
        "user_id": test_user.id,
        "filename": "wework-feedback-WF-GITLAB.zip",
        "content_type": "application/zip",
        "content": b"gitlab diagnostics",
        "max_size_bytes": settings.WEWORK_FEEDBACK_MAX_BUNDLE_SIZE_MB * 1024 * 1024,
    }


def test_submit_feedback_uses_github_issue_without_persisting_bundle(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="GHFEEDBACK",
        name="GitHub feedback",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": "github", "provider_config": {}},
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", str(project.id))
    monkeypatch.setattr(
        external_loop_item_provider,
        "create",
        lambda _db, _project_id, _user_id, _user_name, _values: {"id": "GHFEEDBACK-9"},
    )
    monkeypatch.setattr(external_loop_item_provider, "list", lambda *_args: [])

    def unexpected_gitlab_upload(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("GitHub feedback must not use the GitLab upload API")

    monkeypatch.setattr(
        external_loop_item_provider,
        "attach_gitlab_upload",
        unexpected_gitlab_upload,
    )

    response = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-GITHUB", "GitHub feedback"),
        files={"bundle": ("feedback.zip", b"github diagnostics", "application/zip")},
    )

    assert response.status_code == 201
    assert response.json()["item_id"] == "GHFEEDBACK-9"
    assert "created_by_user_id" not in response.json()
    assert feedback_storage.objects == {}
    assert test_db.query(LoopItem).filter(LoopItem.id == "GHFEEDBACK-9").count() == 0


def test_submit_feedback_retries_after_provider_failure(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="RETRYFB",
        name="Retry feedback",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={"task_provider": "github", "provider_config": {}},
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    monkeypatch.setattr(settings, "WEWORK_FEEDBACK_PROJECT_ID", str(project.id))
    monkeypatch.setattr(external_loop_item_provider, "list", lambda *_args: [])

    def fail_create(*_args: object, **_kwargs: object) -> dict[str, object]:
        raise HTTPException(502, "provider failed")

    monkeypatch.setattr(external_loop_item_provider, "create", fail_create)
    first = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-PROVIDER-RETRY", "Retry provider"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert first.status_code == 502

    monkeypatch.setattr(
        external_loop_item_provider,
        "create",
        lambda *_args, **_kwargs: {"id": "RETRYFB-3"},
    )
    second = test_client.post(
        "/api/v1/feedback",
        data=_feedback_form("WF-PROVIDER-RETRY", "Retry provider"),
        files={"bundle": ("feedback.zip", b"diagnostics", "application/zip")},
    )

    assert second.status_code == 201
    assert second.json()["item_id"] == "RETRYFB-3"


def test_gitlab_feedback_bundle_uses_project_upload_and_updates_issue(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    feedback_project: CloudProject,
    feedback_storage: FeedbackStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    feedback_project.created_by_user_id = test_admin_user.id
    feedback_project.metadata_json = {
        "visibility": "public",
        "task_provider": "gitlab",
        "provider_config": {},
    }
    monkeypatch.setattr(
        external_loop_item_provider,
        "_resolve_project",
        lambda _db, _item_id: (feedback_project, 7),
    )
    monkeypatch.setattr(
        "app.services.loop_items.external_provider.delivery_storage",
        feedback_storage,
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        lambda _project, _number: {"description": "Feedback report: WF-UPLOAD"},
    )
    monkeypatch.setattr(
        external_loop_item_provider, "_repository", lambda _project: "group/project"
    )
    request: dict[str, object] = {}

    def upload(
        _project: CloudProject, method: str, path: str, **kwargs: object
    ) -> dict:
        files = kwargs["files"]
        assert isinstance(files, dict)
        filename, source, content_type = files["file"]
        request.update(
            method=method,
            path=path,
            filename=filename,
            content=source.read(),
            content_type=content_type,
        )
        return {"markdown": "[wework-feedback-WF-UPLOAD.zip](/uploads/bundle.zip)"}

    monkeypatch.setattr(external_loop_item_provider, "_request", upload)
    updates: list[tuple[int, dict[str, object]]] = []
    monkeypatch.setattr(
        external_loop_item_provider,
        "_update_issue",
        lambda _project, number, payload: updates.append((number, payload)),
    )
    attachment = external_loop_item_provider.attach_gitlab_upload(
        test_db,
        "GLFEEDBACK-7",
        test_user.id,
        "wework-feedback-WF-UPLOAD.zip",
        "application/zip",
        io.BytesIO(b"diagnostics"),
        1024,
    )

    assert request == {
        "method": "POST",
        "path": "/projects/group%2Fproject/uploads",
        "filename": "wework-feedback-WF-UPLOAD.zip",
        "content": b"diagnostics",
        "content_type": "application/zip",
    }
    assert updates[0][0] == 7
    description = str(updates[0][1]["description"])
    assert description.startswith("Feedback report: WF-UPLOAD\n\n")
    assert "[wework-feedback-WF-UPLOAD.zip](/uploads/bundle.zip)" in description
    assert "<!-- wegent-attachment:gitlab-" in description
    assert list(feedback_storage.objects.values()) == [b"diagnostics"]
    assert attachment is not None
    content, _, filename = external_loop_item_provider.attachment_content(
        test_db, str(attachment["id"]), test_user.id
    )
    assert content == b"diagnostics"
    assert filename == "bundle.zip"

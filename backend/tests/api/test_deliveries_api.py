# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end API tests for immutable TODO delivery snapshots."""

import asyncio
import io
import json
import uuid
from types import SimpleNamespace
from typing import Any, BinaryIO
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.endpoints import deliveries as deliveries_endpoint
from app.core.security import create_access_token, get_password_hash
from app.models.cloud_project import CloudProject, LoopItemTaskBinding
from app.models.delivery import (
    Delivery,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectIncomingEvent,
)
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.issue_workflow import WorkflowPlanView
from app.services import runtime_work_service
from app.services.delivery import delivery_service
from app.services.delivery.storage import (
    DeliveryObjectNotFoundError,
    DeliveryStorageUnavailableError,
)
from app.services.project_automations import project_automation_execution
from app.services.project_incoming_hooks import project_incoming_hook_service


class FakeDeliveryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put_bytes(self, object_key: str, content: bytes, content_type: str) -> None:
        self.objects[object_key] = content

    def put_stream(
        self,
        object_key: str,
        stream: BinaryIO,
        length: int,
        content_type: str,
    ) -> None:
        self.objects[object_key] = stream.read(length)

    def put_json(self, object_key: str, value: Any) -> None:
        self.objects[object_key] = json.dumps(value).encode()

    def get_bytes(self, object_key: str, max_bytes: int | None = None) -> bytes:
        try:
            value = self.objects[object_key]
        except KeyError as exc:
            raise DeliveryObjectNotFoundError(object_key) from exc
        if max_bytes is not None and len(value) > max_bytes:
            raise ValueError("too large")
        return value

    def download_url(self, object_key: str, expires_seconds: int = 900) -> str:
        return f"https://storage.test/{object_key}"

    def remove_objects(self, object_keys: list[str]) -> None:
        for object_key in object_keys:
            self.objects.pop(object_key, None)


class UnavailableDeliveryStorage(FakeDeliveryStorage):
    def put_bytes(self, object_key: str, content: bytes, content_type: str) -> None:
        raise DeliveryStorageUnavailableError("storage unavailable")


@pytest.fixture
def delivery_storage(monkeypatch: pytest.MonkeyPatch) -> FakeDeliveryStorage:
    storage = FakeDeliveryStorage()
    monkeypatch.setattr(delivery_service, "storage", storage)
    monkeypatch.setattr("app.services.loop_items.service.delivery_storage", storage)
    return storage


def test_todo_attachment_flow(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Attachment TODO"},
    ).json()["id"]

    uploaded = test_client.post(
        f"/api/v1/loop-items/{item_id}/attachments",
        headers=_auth(test_token),
        files={"file": ("brief.txt", b"context", "text/plain")},
    )
    assert uploaded.status_code == 201
    attachment = uploaded.json()
    assert attachment["display_name"] == "brief.txt"
    assert attachment["size_bytes"] == 7
    assert attachment["markdown_url"] == f"wegent://attachments/{attachment['id']}"

    listed = test_client.get(
        f"/api/v1/loop-items/{item_id}/attachments", headers=_auth(test_token)
    )
    assert [item["id"] for item in listed.json()] == [attachment["id"]]

    accessed = test_client.get(
        f"/api/v1/loop-item-attachments/{attachment['id']}/access",
        headers=_auth(test_token),
    )
    assert accessed.status_code == 200
    assert accessed.json() == {
        "url": f"wegent://attachments/{attachment['id']}",
        "expires_in_seconds": 0,
    }

    content = test_client.get(
        f"/api/v1/loop-item-attachments/{attachment['id']}/content",
        headers=_auth(test_token),
    )
    assert content.status_code == 200
    assert content.content == b"context"

    deleted = test_client.delete(
        f"/api/v1/loop-item-attachments/{attachment['id']}",
        headers=_auth(test_token),
    )
    assert deleted.status_code == 204
    assert not delivery_storage.objects


@pytest.fixture
def delivery_project(test_db: Session, test_user: User) -> CloudProject:
    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="DELIVERY",
        name="Delivery project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    return project


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_external_loop_items_forward_assignee_filters(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.loop_items.external_provider import external_loop_item_provider

    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="GHBOARD",
        name="GitHub board",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={
            "task_provider": "github",
            "provider_config": {"repository": "octo/example"},
        },
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)

    captured: dict[str, object] = {}

    def fake_list(
        _db: Session,
        _project_id: int,
        _user_id: int,
        **kwargs: object,
    ) -> list[dict[str, object]]:
        captured.update(kwargs)
        return []

    monkeypatch.setattr(external_loop_item_provider, "list", fake_list)
    response = test_client.get(
        f"/api/v1/cloud-projects/{project.id}/loop-items"
        f"?assignee_type=user&assignee_id={test_user.id}",
        headers=_auth(test_token),
    )

    assert response.status_code == 200
    assert captured == {"assignee_type": "user", "assignee_id": str(test_user.id)}


def test_external_loop_item_comments_reject_unauthorized_private_project_access(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.loop_items.external_provider import external_loop_item_provider

    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="PRIVATECOMMENTS",
        name="Private external comments",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={
            "visibility": "private",
            "task_provider": "github",
            "provider_config": {"repository": "octo/private"},
        },
    )
    unauthorized_user = User(
        user_name="external-comments-outsider",
        password_hash=get_password_hash("outsider-password"),
        email="external-comments-outsider@example.com",
        is_active=True,
    )
    test_db.add_all([project, unauthorized_user])
    test_db.commit()

    issue_loader = MagicMock()
    monkeypatch.setattr(external_loop_item_provider, "_get_issue", issue_loader)
    token = create_access_token(data={"sub": unauthorized_user.user_name})

    response = test_client.get(
        "/api/v1/loop-items/PRIVATECOMMENTS-7/comments",
        headers=_auth(token),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Cloud project not found"
    issue_loader.assert_not_called()


def test_external_loop_item_comments_return_empty_list_for_authorized_user(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.loop_items.external_provider import external_loop_item_provider

    public_id = str(uuid.uuid4())
    project = CloudProject(
        public_id=public_id,
        project_key="EMPTYCOMMENTS",
        name="Empty external comments",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
        metadata_json={
            "visibility": "private",
            "task_provider": "github",
            "provider_config": {"repository": "octo/empty"},
        },
    )
    test_db.add(project)
    test_db.commit()

    monkeypatch.setattr(
        external_loop_item_provider,
        "_get_issue",
        MagicMock(return_value={"number": 7}),
    )
    monkeypatch.setattr(
        external_loop_item_provider,
        "_response",
        MagicMock(return_value={"can_view_detail": True}),
    )
    comment_loader = MagicMock(return_value=[])
    monkeypatch.setattr(
        external_loop_item_provider,
        "_list_comments",
        comment_loader,
    )

    response = test_client.get(
        "/api/v1/loop-items/EMPTYCOMMENTS-7/comments",
        headers=_auth(test_token),
    )

    assert response.status_code == 200
    assert response.json() == []
    comment_loader.assert_called_once_with(project, 7)


def test_loop_items_support_unbounded_hierarchy_and_reject_cycles(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    headers = _auth(test_token)
    root = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=headers,
        json={"title": "Development"},
    ).json()
    child = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=headers,
        json={"title": "Frontend", "parent_id": root["id"]},
    ).json()
    grandchild = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=headers,
        json={"title": "Login page", "parent_id": child["id"]},
    )

    assert grandchild.status_code == 201
    assert grandchild.json()["parent_id"] == child["id"]
    listed = test_client.get(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items", headers=headers
    )
    assert {item["parent_id"] for item in listed.json()["items"]} == {
        None,
        root["id"],
        child["id"],
    }
    cycle = test_client.patch(
        f"/api/v1/loop-items/{root['id']}",
        headers=headers,
        json={"version": root["version"], "parent_id": grandchild.json()["id"]},
    )
    assert cycle.status_code == 422
    assert cycle.json()["detail"] == "TODO hierarchy cannot contain a cycle"


def test_board_snapshot_returns_first_screen_dependencies(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    test_user: User,
) -> None:
    headers = _auth(test_token)
    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=headers,
        json={"title": "Snapshot item"},
    ).json()
    binding = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=headers,
        json={
            "deviceId": "local-device",
            "taskId": "snapshot-runtime-task",
            "taskTitle": "Snapshot runtime task",
            "modelSelection": {
                "modelName": "gpt-5.6-codex",
                "modelType": "public",
                "options": {"reasoning": "high"},
            },
        },
    )
    assert binding.status_code == 201
    assert binding.json()["modelSelection"] == {
        "modelName": "gpt-5.6-codex",
        "modelType": "public",
        "options": {"reasoning": "high"},
    }

    response = test_client.get(
        f"/api/v1/cloud-projects/{delivery_project.id}/board-snapshot",
        headers=headers,
    )

    assert response.status_code == 200
    snapshot = response.json()
    assert [entry["id"] for entry in snapshot["items"]] == [item["id"]]
    assert snapshot["task_bindings"] == [binding.json()]
    assert snapshot["members"][0]["user_id"] == test_user.id
    assert snapshot["members"][0]["role"] == "Owner"
    assert snapshot["agents"] == []


def test_loop_item_reorder_orders_one_lane(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    headers = _auth(test_token)

    def create(title: str, status: str = "inbox") -> dict[str, Any]:
        response = test_client.post(
            f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
            headers=headers,
            json={"title": title, "status": status},
        )
        assert response.status_code == 201
        return response.json()

    first = create("First")
    second = create("Second")
    other_lane = create("Other lane", status="pending")

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items/reorder",
        headers=headers,
        json={
            "parent_id": None,
            "status": "inbox",
            "item_ids": [second["id"], first["id"]],
        },
    )
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [
        second["id"],
        first["id"],
    ]
    assert [item["sort_order"] for item in response.json()["items"]] == [0, 1]

    listed = test_client.get(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items", headers=headers
    ).json()["items"]
    inbox_ids = [item["id"] for item in listed if item["status"] == "inbox"]
    assert inbox_ids == [second["id"], first["id"]]
    # The other lane keeps its own ordering state.
    assert (
        next(item for item in listed if item["id"] == other_lane["id"])["sort_order"]
        == 0
    )

    # Moving a TODO to another lane resets its manual position to the top.
    moved = test_client.patch(
        f"/api/v1/loop-items/{second['id']}",
        headers=headers,
        json={"version": second["version"], "status": "pending"},
    )
    assert moved.status_code == 200
    assert moved.json()["sort_order"] == 0

    missing = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items/reorder",
        headers=headers,
        json={"parent_id": None, "status": "inbox", "item_ids": ["MISS-1"]},
    )
    assert missing.status_code == 422


def test_loop_item_parent_must_be_in_same_project(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
) -> None:
    headers = _auth(test_token)
    parent = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=headers,
        json={"title": "Parent"},
    ).json()
    public_id = str(uuid.uuid4())
    other = CloudProject(
        public_id=public_id,
        project_key="OTHER",
        name="Other project",
        description="",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{public_id}",
    )
    test_db.add(other)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=other.id,
            entity_id=str(test_user.id),
            user_id=test_user.id,
            role="Owner",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()

    response = test_client.post(
        f"/api/v1/cloud-projects/{other.id}/loop-items",
        headers=headers,
        json={"title": "Invalid child", "parent_id": parent["id"]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Parent TODO must belong to the same project"


def test_delivery_returns_service_unavailable_without_repeating_cleanup(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    storage = UnavailableDeliveryStorage()
    monkeypatch.setattr(delivery_service, "storage", storage)
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Unavailable storage"},
    ).json()["id"]

    response = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "handoff"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "Delivery object storage is unavailable"


def test_delivery_flow_creates_immutable_snapshot(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published_events: list[tuple[str, str]] = []
    monkeypatch.setattr(
        "app.services.delivery.service.publish_loop_item_changed",
        lambda db, *, item, reason, actor_user_id: published_events.append(
            (item.id, reason)
        ),
    )
    item_response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Ship delivery", "description": "Original task"},
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]
    source_task = {
        "deviceId": "local-device",
        "taskId": "runtime-task-1",
        "taskTitle": "Implement cloud delivery",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201
    assert binding_response.json()["task_title"] == "Implement cloud delivery"
    collaborators = test_client.get(
        f"/api/v1/loop-items/{item_id}/collaborators",
        headers=_auth(test_token),
    )
    assert collaborators.status_code == 200
    assert collaborators.json()[0]["source"] == "task"

    draft_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={
            "markdown": "# Handoff\nContinue from here.",
            "chat": {"scope": "conversation", "messages": [{"role": "user"}]},
            "source_task": source_task,
        },
    )
    assert draft_response.status_code == 201
    delivery_id = draft_response.json()["id"]

    asset_response = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/assets",
        headers=_auth(test_token),
        data={"relative_path": "src/result.txt"},
        files={"file": ("result.txt", io.BytesIO(b"done"), "text/plain")},
    )
    assert asset_response.status_code == 201
    assert asset_response.json()["sha256"] == (
        "a4c3ed04a95a3da14a9d235c83d868bed7c0f45cf7f3faa751ee8f50598d2211"
    )

    finalized = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/finalize", headers=_auth(test_token)
    )
    assert finalized.status_code == 200
    assert finalized.json()["status"] == "delivered"
    assert any(key.endswith("manifest.json") for key in delivery_storage.objects)
    assert published_events == [(item_id, "delivery_finalized")]

    detail = test_client.get(
        f"/api/v1/deliveries/{delivery_id}", headers=_auth(test_token)
    )
    assert detail.status_code == 200
    assert detail.json()["markdown"].startswith("# Handoff")
    assert detail.json()["chat"]["scope"] == "conversation"
    assert detail.json()["source_task_snapshot"]["taskId"] == "runtime-task-1"
    assert detail.json()["assets"][0]["relative_path"] == "src/result.txt"

    immutable = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/assets",
        headers=_auth(test_token),
        data={"relative_path": "late.txt"},
        files={"file": ("late.txt", b"late", "text/plain")},
    )
    assert immutable.status_code == 409


def test_collaboration_human_delivery_closes_assignment_without_completing_issue(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Review CPU evidence", "status": "in_progress"},
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]
    source_task = {
        "deviceId": "human-device",
        "taskId": "human-runtime-task",
        "taskTitle": "Review CPU evidence",
        "humanAssignmentId": "human-assignment-1",
        "dispatchId": "dispatch-1",
        "dispatchRoundId": "round-1",
        "assignmentId": "review-cpu",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201
    assert binding_response.json()["human_assignment_id"] == "human-assignment-1"

    draft_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={
            "markdown": "# Review\nEvidence accepted.",
            "source_task": source_task,
        },
    )
    assert draft_response.status_code == 201
    delivery_id = draft_response.json()["id"]

    finalized = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/finalize",
        headers=_auth(test_token),
    )
    assert finalized.status_code == 200
    assert finalized.json()["status"] == "delivered"
    assert finalized.json()["source_task_snapshot"] == {
        "taskId": "human-runtime-task",
        "deviceId": "human-device",
        "userId": item_response.json()["created_by_user_id"],
        "backendTaskId": None,
        "humanAssignmentId": "human-assignment-1",
        "dispatchId": "dispatch-1",
        "dispatchRoundId": "round-1",
        "assignmentId": "review-cpu",
    }
    test_db.expire_all()
    item = test_db.get(LoopItem, item_id)
    assert item is not None
    assert item.status == "in_progress"
    assert item.completed_at is None
    assert item.current_delivery_id == delivery_id


def test_direct_human_delivery_moves_issue_to_review(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Prepare release notes", "status": "in_progress"},
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]
    source_task = {
        "deviceId": "human-device",
        "taskId": "direct-human-runtime-task",
        "taskTitle": "Prepare release notes",
        "humanAssignmentId": "direct-human-assignment-1",
        "dispatchId": "direct-human:assignment-1",
        "dispatchRoundId": "direct",
        "assignmentId": "assignment-1",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201

    draft_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={
            "markdown": "# Release notes\nReady for review.",
            "source_task": source_task,
        },
    )
    assert draft_response.status_code == 201
    delivery_id = draft_response.json()["id"]

    finalized = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/finalize",
        headers=_auth(test_token),
    )

    assert finalized.status_code == 200
    test_db.expire_all()
    item = test_db.get(LoopItem, item_id)
    assert item is not None
    assert item.status == "in_review"
    assert item.completed_at is None
    assert item.current_delivery_id == delivery_id
    assert item.metadata_json["status_history"][-1]["trigger"] == "human_delivery"
    assert item.metadata_json["status_history"][-1]["to_status"] == "in_review"


def test_delivery_response_reads_expired_orm_fields(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Serialize expired delivery"},
    ).json()["id"]
    draft = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "handoff"},
    )
    assert draft.status_code == 201

    delivery = test_db.get(Delivery, draft.json()["id"])
    assert delivery is not None
    test_db.expire(delivery)

    response = deliveries_endpoint._delivery_response(test_db, delivery)

    assert response.id == delivery.id
    assert response.loop_item_id == item_id
    assert response.status == "draft"


def test_pull_request_delivery_creates_change_request_binding(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "nodes": [
                {
                    "id": "implementation",
                    "name": "Implementation",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                    "required_deliverables": [
                        {
                            "id": "pull-request",
                            "name": "Pull request",
                            "description": "",
                            "value_type": "pull_request",
                        }
                    ],
                }
            ],
        },
    }
    test_db.commit()
    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Ship pull request"},
    ).json()
    source_task = {
        "deviceId": "local-device",
        "taskId": "implementation-task",
        "taskTitle": "Implement feature",
        "workflowNodeId": "implementation",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201
    draft = test_client.post(
        f"/api/v1/loop-items/{item['id']}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "# Complete", "source_task": source_task},
    )
    assert draft.status_code == 201

    finalized = test_client.post(
        f"/api/v1/deliveries/{draft.json()['id']}/finalize",
        headers=_auth(test_token),
        json={
            "fulfillments": [
                {
                    "requirement_id": "pull-request",
                    "kind": "pull_request",
                    "provider": "github",
                    "url": "https://github.com/acme/app/pull/7",
                    "number": 7,
                    "state": "draft",
                    "head_branch": "feature/events",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                }
            ]
        },
    )

    assert finalized.status_code == 200, finalized.text
    binding = test_db.get(LoopItemTaskBinding, binding_response.json()["id"])
    assert binding is not None
    assert binding.change_requests == [
        {
            "provider": "github",
            "instance_url": "https://github.com",
            "repository": "acme/app",
            "number": 7,
            "url": "https://github.com/acme/app/pull/7",
            "head_branch": "feature/events",
            "base_branch": "main",
            "head_commit": "abc1234",
            "source": "delivery",
            "bound_at": binding.change_requests[0]["bound_at"],
            "last_confirmed_at": binding.change_requests[0]["last_confirmed_at"],
        }
    ]


@pytest.mark.parametrize("initial_status", ["inbox", "pending"])
def test_binding_task_preserves_unstarted_todo_until_runtime_starts(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    initial_status: str,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Start from runtime", "status": initial_status},
    ).json()

    response = test_client.post(
        f"/api/v1/loop-items/{created['id']}/tasks",
        headers=_auth(test_token),
        json={"deviceId": "local-device", "taskId": f"task-{initial_status}"},
    )

    assert response.status_code == 201
    item = test_client.get(
        f"/api/v1/loop-items/{created['id']}", headers=_auth(test_token)
    ).json()
    assert item["status"] == initial_status
    assert item["version"] == created["version"]


def test_project_workflow_is_snapshotted_into_new_issue(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 4,
            "nodes": [
                {
                    "id": "develop",
                    "name": "开发",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                },
                {
                    "id": "test",
                    "name": "测试",
                    "kind": "my_task",
                    "depends_on": ["develop"],
                    "required": True,
                    "workspace_policy": "inherit",
                },
            ],
        },
    }
    test_db.commit()

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Workflow issue"},
    )

    assert response.status_code == 201
    workflow = response.json()["workflow"]
    assert workflow["definition_version"] == 4
    assert [node["status"] for node in workflow["nodes"]] == ["ready", "blocked"]


def test_updating_assigned_issue_execution_config_wakes_cloud_executor(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Wake assigned execution", "status": "inbox"},
    ).json()
    item = test_db.get(LoopItem, created["id"])
    assert item is not None
    item.assignee_agent_id = "agent-1"
    test_db.commit()
    test_db.refresh(item)

    refresh = MagicMock(side_effect=lambda _db, *, item, user_id: item)
    dispatch = AsyncMock()
    wake = AsyncMock()
    monkeypatch.setattr(
        deliveries_endpoint.loop_item_service,
        "refresh_agent_execution_configuration",
        refresh,
    )
    monkeypatch.setattr(
        "app.services.board_team_execution.dispatch_board_team_assignment",
        dispatch,
    )
    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        wake,
    )

    response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": item.version,
            "execution_config": {
                "agent_id": "agent-1",
                "runtime_profile_id": None,
                "execution_device_id": "cloud-device",
                "model": "public-model",
                "model_type": "public",
                "model_options": {},
                "workspace_binding": {"type": "standalone"},
            },
        },
    )

    assert response.status_code == 200
    refresh.assert_called_once()
    dispatch.assert_awaited_once()
    wake.assert_awaited_once_with()


def test_non_ai_issue_created_in_inbox_emits_task_created_automation(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rule = SimpleNamespace(id="rule-1")
    ingest = AsyncMock(return_value=1)
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor.matching_rules",
        MagicMock(return_value=[rule]),
    )
    monkeypatch.setattr(
        deliveries_endpoint.project_incoming_hook_service,
        "ingest_internal",
        ingest,
    )

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Trigger inbox automation"},
    )

    assert response.status_code == 201
    created = response.json()
    assert created["status"] == "inbox"
    ingest.assert_awaited_once()
    event = ingest.await_args.args[1]
    assert event.event_type == "task.created"
    assert event.project_id == str(delivery_project.id)
    assert event.subject_id == created["id"]
    assert ingest.await_args.kwargs["automation_id"] == "rule-1"

    updated = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={"version": created["version"], "status": "in_progress"},
    )

    assert updated.status_code == 200
    assert ingest.await_count == 2
    status_event = ingest.await_args_list[1].args[1]
    assert status_event.event_type == "task.status_changed"
    assert status_event.subject_id == created["id"]


def test_issue_creation_requires_one_automation_when_multiple_rules_match(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matching_rules = [
        SimpleNamespace(id="rule-1", title="Implement", description="Build the change"),
        SimpleNamespace(id="rule-2", title="Review", description="Review the request"),
    ]
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor.matching_rules",
        MagicMock(return_value=matching_rules),
    )
    before_count = test_db.query(LoopItem).count()

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Choose one workflow"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "automation_selection_required",
        "message": "Multiple automations match this Issue",
        "candidates": [
            {
                "id": "rule-1",
                "name": "Implement",
                "description": "Build the change",
            },
            {
                "id": "rule-2",
                "name": "Review",
                "description": "Review the request",
            },
        ],
    }
    assert test_db.query(LoopItem).count() == before_count


def test_issue_creation_dispatches_only_the_selected_matching_automation(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matching_rules = [
        SimpleNamespace(id="rule-1", title="Implement", description=""),
        SimpleNamespace(id="rule-2", title="Review", description=""),
    ]
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor.matching_rules",
        MagicMock(return_value=matching_rules),
    )
    ingest = AsyncMock(return_value=1)
    monkeypatch.setattr(
        deliveries_endpoint.project_incoming_hook_service,
        "ingest_internal",
        ingest,
    )

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Run one workflow",
            "automation_rule_id": "rule-2",
        },
    )

    assert response.status_code == 201
    ingest.assert_awaited_once()
    assert ingest.await_args.kwargs["automation_id"] == "rule-2"


def test_tag_update_requires_and_dispatches_one_matching_automation(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Choose tag automation"},
    ).json()
    matching_rules = [
        SimpleNamespace(id="rule-1", title="Implement", description=""),
        SimpleNamespace(id="rule-2", title="Review", description=""),
    ]
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor.matching_rules",
        MagicMock(return_value=matching_rules),
    )
    ingest = AsyncMock(return_value=1)
    monkeypatch.setattr(
        deliveries_endpoint.project_incoming_hook_service,
        "ingest_internal",
        ingest,
    )

    selection_response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={"version": created["version"], "tags": ["review"]},
    )

    assert selection_response.status_code == 409
    assert (
        selection_response.json()["detail"]["code"] == "automation_selection_required"
    )
    unchanged = test_db.get(LoopItem, created["id"])
    assert unchanged is not None
    test_db.refresh(unchanged)
    assert unchanged.tags == []
    assert unchanged.version == created["version"]
    ingest.assert_not_awaited()

    selected_response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "tags": ["review"],
            "automation_rule_id": "rule-2",
        },
    )

    assert selected_response.status_code == 200
    assert selected_response.json()["tags"] == ["review"]
    ingest.assert_awaited_once()
    event = ingest.await_args.args[1]
    assert event.event_type == "task.tag_added"
    assert event.payload["added_tags"] == ["review"]
    assert ingest.await_args.kwargs["automation_id"] == "rule-2"


def test_binding_subscription_backend_task_uses_task_store(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    backend_task = TaskResource(
        user_id=test_user.id,
        kind="Task",
        name=f"delivery-subscription-{uuid.uuid4()}",
        namespace="default",
        json={},
        is_active=TaskResource.STATE_SUBSCRIPTION,
    )
    test_db.add(backend_task)
    test_db.commit()
    test_db.refresh(backend_task)
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Bind subscription task"},
    ).json()

    response = test_client.post(
        f"/api/v1/loop-items/{created['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "subscription-task",
            "backendTaskId": backend_task.id,
        },
    )

    assert response.status_code == 201
    assert response.json()["backend_task_id"] == backend_task.id


@pytest.mark.parametrize("initial_status", ["in_progress", "in_review", "completed"])
def test_binding_task_preserves_started_or_finished_todo_status(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    initial_status: str,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Keep workflow state", "status": initial_status},
    ).json()

    response = test_client.post(
        f"/api/v1/loop-items/{created['id']}/tasks",
        headers=_auth(test_token),
        json={"deviceId": "local-device", "taskId": f"task-{initial_status}"},
    )

    assert response.status_code == 201
    item = test_client.get(
        f"/api/v1/loop-items/{created['id']}", headers=_auth(test_token)
    ).json()
    assert item["status"] == initial_status
    assert item["version"] == created["version"]


def test_runtime_task_can_narrow_project_context_to_todo(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    task = {"deviceId": "local-device", "taskId": "project-context-task"}
    project_binding = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/tasks",
        headers=_auth(test_token),
        json=task,
    )
    assert project_binding.status_code == 201
    assert str(project_binding.json()["cloud_project_id"]) == str(delivery_project.id)
    assert project_binding.json()["loop_item_id"] is None

    context = test_client.get(
        "/api/v1/runtime-tasks/cloud-context",
        headers=_auth(test_token),
        params={"device_id": task["deviceId"], "task_id": task["taskId"]},
    )
    assert context.status_code == 200
    assert context.json()["project"]["name"] == delivery_project.name
    assert context.json()["loop_item"] is None

    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Choose after exploration"},
    ).json()
    todo_binding = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json=task,
    )
    assert todo_binding.status_code == 201

    narrowed = test_client.get(
        "/api/v1/runtime-tasks/cloud-context",
        headers=_auth(test_token),
        params={"device_id": task["deviceId"], "task_id": task["taskId"]},
    ).json()
    assert str(narrowed["cloud_project_id"]) == str(delivery_project.id)
    assert narrowed["loop_item"]["id"] == item["id"]


def test_delivery_submitter_becomes_collaborator_without_runtime_task(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Write directly in cloud"},
    ).json()["id"]

    delivery_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "Cloud-only result"},
    )
    assert delivery_response.status_code == 201

    collaborators = test_client.get(
        f"/api/v1/loop-items/{item_id}/collaborators",
        headers=_auth(test_token),
    )
    assert collaborators.status_code == 200
    assert collaborators.json()[0]["source"] == "delivery"


def test_delivery_rejects_parent_path(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Path safety"},
    ).json()["id"]
    draft = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "safe"},
    ).json()

    response = test_client.post(
        f"/api/v1/deliveries/{draft['id']}/assets",
        headers=_auth(test_token),
        data={"relative_path": "../secret.txt"},
        files={"file": ("secret.txt", b"secret", "text/plain")},
    )

    assert response.status_code == 422
    assert not any("secret.txt" in key for key in delivery_storage.objects)


def test_delivery_rejects_oversized_asset_and_discards_draft(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.services.delivery.service.settings.DELIVERY_MAX_ASSET_SIZE_MB", 1
    )
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Large asset"},
    ).json()["id"]
    draft = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "draft"},
    ).json()

    too_large = test_client.post(
        f"/api/v1/deliveries/{draft['id']}/assets",
        headers=_auth(test_token),
        data={"relative_path": "large.bin"},
        files={
            "file": ("large.bin", b"x" * (1024 * 1024 + 1), "application/octet-stream")
        },
    )
    discarded = test_client.delete(
        f"/api/v1/deliveries/{draft['id']}", headers=_auth(test_token)
    )

    assert too_large.status_code == 413
    assert discarded.status_code == 204
    assert not delivery_storage.objects


def test_project_member_can_discover_shared_todo_and_delivery(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
) -> None:
    item_id = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Continue shared work"},
    ).json()["id"]
    member = User(
        user_name="delivery-member",
        password_hash=get_password_hash("member-password"),
        email="delivery-member@example.com",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=delivery_project.id,
            entity_id=str(member.id),
            role="Viewer",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    member_token = create_access_token(data={"sub": member.user_name})

    projects_response = test_client.get(
        "/api/v1/cloud-projects", headers=_auth(member_token)
    )
    items_response = test_client.get(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(member_token),
    )

    assert projects_response.status_code == 200
    assert any(
        str(item["id"]) == str(delivery_project.id)
        for item in projects_response.json()["items"]
    )
    assert items_response.status_code == 200
    assert items_response.json()["items"][0]["id"] == item_id

    collaborator_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/collaborators",
        headers=_auth(test_token),
        json={"user_id": member.id},
    )
    assert collaborator_response.status_code == 201
    assert collaborator_response.json()["user_name"] == member.user_name

    member_collaborators = test_client.get(
        f"/api/v1/loop-items/{item_id}/collaborators",
        headers=_auth(member_token),
    )
    assert member_collaborators.status_code == 200
    assert [row["user_id"] for row in member_collaborators.json()] == [member.id]


def test_loop_item_unread_follows_content_revision_and_read_cursor(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Unread projection"},
    )
    assert created.status_code == 201
    item = created.json()
    assert item["content_revision"] == 1
    assert item["is_unread"] is False

    member = User(
        user_name="unread-member",
        password_hash=get_password_hash("member-password"),
        email="unread-member@example.com",
        is_active=True,
    )
    test_db.add(member)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type=ResourceType.CLOUD_PROJECT.value,
            resource_id=delivery_project.id,
            entity_id=str(member.id),
            role="Viewer",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()
    member_token = create_access_token(data={"sub": member.user_name})

    member_item = test_client.get(
        f"/api/v1/loop-items/{item['id']}", headers=_auth(member_token)
    )
    assert member_item.status_code == 200
    assert member_item.json()["is_unread"] is True

    version_before_read = member_item.json()["version"]
    marked = test_client.post(
        f"/api/v1/loop-items/{item['id']}/read", headers=_auth(member_token)
    )
    assert marked.status_code == 200
    assert marked.json()["is_unread"] is False
    assert marked.json()["version"] == version_before_read

    updated = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": item["version"], "title": "Unread projection updated"},
    )
    assert updated.status_code == 200
    assert updated.json()["content_revision"] == 2
    assert updated.json()["is_unread"] is False

    refreshed_member_item = test_client.get(
        f"/api/v1/loop-items/{item['id']}", headers=_auth(member_token)
    )
    assert refreshed_member_item.status_code == 200
    assert refreshed_member_item.json()["content_revision"] == 2
    assert refreshed_member_item.json()["is_unread"] is True


def test_mark_loop_item_read_repairs_legacy_metadata_without_read_revisions(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Legacy unread projection"},
    )
    assert created.status_code == 201
    item = test_db.get(LoopItem, created.json()["id"])
    assert item is not None
    item.metadata_json = {"content_revision": 3, "legacy": True}
    test_db.commit()

    marked = test_client.post(
        f"/api/v1/loop-items/{item.id}/read",
        headers=_auth(test_token),
    )

    assert marked.status_code == 200
    assert marked.json()["content_revision"] == 3
    assert marked.json()["is_unread"] is False
    test_db.refresh(item)
    assert item.metadata_json["legacy"] is True
    assert item.metadata_json["read_revisions"][str(item.created_by_user_id)] == 3


def test_mark_loop_item_read_persists_activity_sequence(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Activity cursor"},
    )
    assert created.status_code == 201

    marked = test_client.post(
        f"/api/v1/loop-items/{created.json()['id']}/read",
        headers=_auth(test_token),
        json={"activity_sequence": 17},
    )

    assert marked.status_code == 200
    assert marked.json()["activity_read_sequence"] == 17
    item = test_db.get(LoopItem, created.json()["id"])
    assert item is not None
    assert (
        item.metadata_json["activity_read_sequences"][str(item.created_by_user_id)]
        == 17
    )


def _github_webhook_headers(
    *,
    delivery_id: str,
) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-GitHub-Event": "check_run",
        "X-GitHub-Delivery": delivery_id,
    }


def _failed_check_payload() -> dict[str, object]:
    return {
        "action": "completed",
        "check_run": {
            "id": 100,
            "status": "completed",
            "conclusion": "failure",
            "head_sha": "abc1234",
            "pull_requests": [
                {
                    "number": 7,
                    "html_url": "https://github.example/acme/app/pull/7",
                    "head": {"ref": "fix/checks", "sha": "abc1234"},
                    "base": {"ref": "main"},
                }
            ],
        },
        "repository": {
            "id": 42,
            "full_name": "acme/app",
            "html_url": "https://github.example/acme/app",
        },
    }


def test_pr_delivery_resolves_unresolved_external_event_and_binds_run(
    test_client: TestClient,
    test_token: str,
    test_db: Session,
    test_user: User,
    delivery_project: CloudProject,
    delivery_storage: FakeDeliveryStorage,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An MR/PR delivery closes the loop for an event that arrived before its
    change request was bound: the run starts skipped/unresolved, the delivery
    binds the change request and requeues the event, and reprocessing succeeds
    on the same task."""

    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "nodes": [
                {
                    "id": "implementation",
                    "name": "Implementation",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                    "required_deliverables": [
                        {
                            "id": "pull-request",
                            "name": "Pull request",
                            "description": "",
                            "value_type": "pull_request",
                        }
                    ],
                }
            ],
        },
    }
    test_db.commit()

    subscription = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/incoming-hooks",
        headers=_auth(test_token),
        json={
            "name": "GitHub repository",
            "source_type": "github",
            "collection_mode": "webhook",
            "resource": {
                "resource_type": "repository",
                "url": "https://github.example/acme/app",
            },
        },
    )
    assert subscription.status_code == 201, subscription.text
    hook = subscription.json()

    rule_response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/automations",
        headers=_auth(test_token),
        json={
            "name": "Resume bound task",
            "prompt": "Fix the failing checks in the bound task.",
            "triggerType": "event",
            "eventType": "change_request.checks_failed",
            "eventConfig": {
                "subscription_id": hook["id"],
                "execution_target": "continue_binding",
                "target_branches": ["main"],
            },
            "targetKind": "human",
            "targetId": str(test_user.id),
        },
    )
    assert rule_response.status_code == 201, rule_response.text

    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Feature implementation"},
    ).json()
    source_task = {
        "deviceId": "local-device",
        "taskId": "implementation-task",
        "taskTitle": "Implement feature",
        "workflowNodeId": "implementation",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201, binding_response.text

    monkeypatch.setattr(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        AsyncMock(),
    )

    payload = _failed_check_payload()
    body = json.dumps(payload, separators=(",", ":"))
    delivered = test_client.post(
        str(hook["webhookUrl"]),
        headers=_github_webhook_headers(delivery_id="delivery-unresolved"),
        content=body,
    )
    assert delivered.status_code == 202
    asyncio.run(
        project_incoming_hook_service.process_event(
            test_db,
            delivered.json()["eventId"],
        )
    )

    run = test_db.query(ProjectAutomationRun).one()
    event = test_db.query(ProjectIncomingEvent).one()
    test_db.refresh(run)
    test_db.refresh(event)
    assert run.status == "skipped"
    assert "binding" in (run.description or "").lower()
    assert event.status == "unresolved"

    draft = test_client.post(
        f"/api/v1/loop-items/{item['id']}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "# Complete", "source_task": source_task},
    )
    assert draft.status_code == 201, draft.text
    finalized = test_client.post(
        f"/api/v1/deliveries/{draft.json()['id']}/finalize",
        headers=_auth(test_token),
        json={
            "fulfillments": [
                {
                    "requirement_id": "pull-request",
                    "kind": "pull_request",
                    "provider": "github",
                    "url": "https://github.example/acme/app/pull/7",
                    "number": 7,
                    "state": "draft",
                    "head_branch": "feature/events",
                    "base_branch": "main",
                    "head_commit": "abc1234",
                }
            ]
        },
    )
    assert finalized.status_code == 200, finalized.text

    bound = test_db.get(LoopItemTaskBinding, binding_response.json()["id"])
    assert bound is not None
    assert len(bound.change_requests) == 1
    assert bound.change_requests[0]["number"] == 7
    assert bound.change_requests[0]["provider"] == "github"

    test_db.refresh(event)
    assert event.status == "received"

    send_runtime_message = AsyncMock(
        return_value=SimpleNamespace(accepted=True, error=None)
    )
    monkeypatch.setattr(
        runtime_work_service,
        "send_runtime_message",
        send_runtime_message,
    )
    asyncio.run(project_incoming_hook_service.process_event(test_db, str(event.id)))

    test_db.refresh(run)
    test_db.refresh(event)
    assert run.status == "succeeded"
    assert run.task_id == str(item["id"])
    assert event.status == "processed"
    send_runtime_message.assert_awaited_once()

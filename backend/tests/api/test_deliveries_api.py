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
from app.services.issue_workflow_planning import issue_workflow_planning_service
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


def test_workflow_delivery_rejects_empty_fulfillments(
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
                    "id": "backend",
                    "name": "Backend",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                    "required_deliverables": [
                        {
                            "id": "backend-wiki",
                            "name": "Backend Wiki",
                            "description": "",
                            "value_type": "text",
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
        json={"title": "Workflow delivery"},
    ).json()
    source_task = {
        "deviceId": "local-device",
        "taskId": "backend-task",
        "taskTitle": "Implement backend",
        "workflowNodeId": "backend",
    }
    binding = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding.status_code == 201
    draft = test_client.post(
        f"/api/v1/loop-items/{item['id']}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "# Backend", "source_task": source_task},
    )
    assert draft.status_code == 201
    delivery_id = draft.json()["id"]

    finalized = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/finalize",
        headers=_auth(test_token),
        json={"fulfillments": []},
    )

    assert finalized.status_code == 422
    assert (
        finalized.json()["detail"]
        == "Workflow Delivery must fulfill at least one required deliverable"
    )
    detail = test_client.get(
        f"/api/v1/deliveries/{delivery_id}", headers=_auth(test_token)
    )
    assert detail.status_code == 200
    assert detail.json()["status"] == "draft"


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


@pytest.mark.parametrize("target_status", ["pending", "in_review"])
def test_crossing_processing_boundary_starts_orchestrated_issue_workflow(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
    target_status: str,
) -> None:
    rule = ProjectAutomationRule(
        cloud_project_id=delivery_project.id,
        title="Develop automatically",
        description="Start from the Issue workflow",
        status="enabled",
        created_by_user_id=delivery_project.created_by_user_id,
        metadata_json={
            "trigger_type": "workflow",
            "assignment_mode": "manual",
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add(rule)
    test_db.flush()
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "execution_config": {
                "agent_id": "agent-1",
                "runtime_profile_id": "runtime-1",
                "model": "model-1",
                "workspace_binding": {
                    "type": "backend_project",
                    "projectId": delivery_project.id,
                },
            },
            "nodes": [
                {
                    "id": "develop",
                    "name": "Develop",
                    "kind": "automation",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "none",
                    "automation_rule_id": str(rule.id),
                }
            ],
        },
    }
    test_db.commit()
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Start workflow from board", "status": "inbox"},
    ).json()
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={"version": created["version"], "status": target_status},
    )

    assert response.status_code == 200
    assert response.json()["status"] == target_status
    assert response.json()["workflow"]["nodes"][0]["status"] == "queued"
    run = test_db.query(ProjectAutomationRun).one()
    assert run.task_id == created["id"]
    dispatch.assert_awaited_once()


def test_ai_issue_created_in_pending_waits_for_configuration_then_starts(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rule = ProjectAutomationRule(
        cloud_project_id=delivery_project.id,
        title="AI manager",
        description="Plan and assign the Issue.",
        status="enabled",
        created_by_user_id=delivery_project.created_by_user_id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
            "event_config": {},
            "action": "ai_assign",
            "manager": {"type": "custom"},
            "runtime": {
                "source": "fixed_profile",
                "runtime_profile_id": None,
            },
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add(rule)
    test_db.flush()
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "none",
            "advancement_policy": "ai",
            "ai_automation_rule_id": str(rule.id),
            "nodes": [],
        },
    }
    test_db.commit()
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    created_response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Configure before AI planning", "status": "pending"},
    )

    assert created_response.status_code == 201
    created = created_response.json()
    assert created["status"] == "pending"
    assert created["workflow"]["execution_config"]["model"] is None
    assert test_db.query(ProjectAutomationRun).count() == 0
    dispatch.assert_not_awaited()

    workflow = created["workflow"]
    workflow["execution_config"] = {
        "agent_id": None,
        "runtime_profile_id": None,
        "execution_device_id": "local-device",
        "model": "gpt-5-codex",
        "model_type": "runtime",
        "model_options": {},
        "workspace_binding": {"type": "standalone"},
    }
    started_response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "status": "pending",
            "workflow": workflow,
        },
    )

    assert started_response.status_code == 200
    run = test_db.query(ProjectAutomationRun).one()
    assert run.task_id == created["id"]
    assert (run.metadata_json or {})["workflow_execution_config"]["model"] == (
        "gpt-5-codex"
    )
    dispatch.assert_awaited_once()


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


def test_status_automation_workflow_is_returned_by_status_update(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    rule = ProjectAutomationRule(
        cloud_project_id=delivery_project.id,
        title="Bind workflow on processing",
        description="Attach the canonical workflow before the board decides execution mode.",
        status="enabled",
        created_by_user_id=delivery_project.created_by_user_id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {
                "transition": "entered_processing",
                "runtime_workflow_definition": {
                    "version": 1,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "implement",
                            "name": "Implement",
                            "execution_mode": "robot",
                            "execution_config": {
                                "execution_device_id": "local-device",
                                "model": "runtime-model",
                                "workspace_binding": None,
                            },
                        }
                    ],
                },
            },
            "action": "execute",
            "role": {"source": "generic", "agent_id": None},
            "runtime": {
                "source": "runtime_user",
                "user_id": delivery_project.created_by_user_id,
            },
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add(rule)
    test_db.commit()
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Bind workflow before execution", "status": "inbox"},
    ).json()

    response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={"version": created["version"], "status": "in_progress"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "in_progress"
    assert payload["workflow"]["nodes"][0]["id"] == "implement"
    assert payload["workflow"]["nodes"][0]["status"] == "ready"
    assert (
        payload["workflow"]["nodes"][0]["execution_config"]["workspace_binding"] is None
    )


def test_status_update_requires_one_automation_before_entering_processing(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Choose workflow on processing", "status": "inbox"},
    ).json()
    item = test_db.get(LoopItem, created["id"])
    assert item is not None
    item.metadata_json = {
        **(item.metadata_json or {}),
        "workflow": {
            "version": 1,
            "definition_version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "approval_policy": "required",
            "orchestration_status": "idle",
            "nodes": [
                {
                    "id": "legacy-step",
                    "name": "Legacy step",
                    "prompt": "Do not start after selecting a canonical automation",
                    "execution_mode": "human",
                    "status": "ready",
                }
            ],
        },
    }
    test_db.commit()
    matching_rules = [
        SimpleNamespace(id="rule-1", title="Implement", description="Build the change"),
        SimpleNamespace(id="rule-2", title="Review", description="Review the request"),
    ]
    matching = MagicMock(return_value=matching_rules)
    ingest = AsyncMock(return_value=1)
    start = AsyncMock(return_value=1)
    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor.matching_rules",
        matching,
    )
    monkeypatch.setattr(
        deliveries_endpoint.project_incoming_hook_service,
        "ingest_internal",
        ingest,
    )
    monkeypatch.setattr(
        deliveries_endpoint.issue_workflow_start_service,
        "start",
        start,
    )

    selection_response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={"version": created["version"], "status": "pending"},
    )

    assert selection_response.status_code == 409
    assert selection_response.json()["detail"] == {
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
    unchanged = test_client.get(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
    ).json()
    assert unchanged["status"] == "inbox"
    assert unchanged["version"] == created["version"]
    ingest.assert_not_awaited()

    selected_response = test_client.patch(
        f"/api/v1/loop-items/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "status": "pending",
            "automation_rule_id": "rule-2",
        },
    )

    assert selected_response.status_code == 200
    assert selected_response.json()["status"] == "pending"
    start.assert_not_awaited()
    ingest.assert_awaited_once()
    assert ingest.await_args.kwargs["automation_id"] == "rule-2"


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


def test_issue_created_in_inbox_starts_its_existing_workflow(
    test_client: TestClient,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start = AsyncMock(return_value=1)
    monkeypatch.setattr(
        deliveries_endpoint.issue_workflow_start_service,
        "start",
        start,
    )

    response = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Start inbox workflow",
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "none",
                "advancement_policy": "ai",
                "coordinator_prompt": "",
                "approval_policy": "automatic",
                "ai_automation_rule_id": "rule-1",
                "execution_config": None,
                "orchestration_status": "idle",
                "active_run_id": None,
                "active_plan_version": None,
                "current_stage_id": None,
                "nodes": [],
            },
        },
    )

    assert response.status_code == 201
    assert response.json()["status"] == "inbox"
    start.assert_awaited_once()
    assert start.await_args.kwargs["item"].id == response.json()["id"]


def test_pausing_planning_cancels_active_ai_manager(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = LoopItem(
        id=f"I{uuid.uuid4().hex[:10]}",
        cloud_project_id=delivery_project.id,
        title="Pause planning",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "none",
                "advancement_policy": "ai",
                "approval_policy": "required",
                "ai_automation_rule_id": "rule-1",
                "orchestration_status": "idle",
                "nodes": [],
            }
        },
    )
    test_db.add(issue)
    test_db.flush()
    workflow_run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    manager_run = ProjectAutomationRun(
        id=f"A{uuid.uuid4().hex[:10]}",
        cloud_project_id=delivery_project.id,
        parent_id="rule-1",
        task_id=issue.id,
        title="AI manager",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"event": {"payload": {"workflow_run_id": workflow_run.id}}},
    )
    test_db.add(manager_run)
    test_db.commit()
    cancel_run = AsyncMock(return_value={"id": manager_run.id, "status": "cancelled"})
    monkeypatch.setattr(
        deliveries_endpoint.project_automation_service,
        "cancel_run",
        cancel_run,
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue.id}/workflow-plan/pause",
        headers=_auth(test_token),
        json={},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "paused"
    cancel_run.assert_awaited_once_with(
        test_db,
        str(delivery_project.id),
        manager_run.id,
        test_user.id,
    )
    resume_response = test_client.post(
        f"/api/v1/loop-items/{issue.id}/workflow-plan/resume",
        headers=_auth(test_token),
        json={},
    )
    assert resume_response.status_code == 409
    assert resume_response.json()["detail"] == "The AI manager is still stopping"


def test_pausing_planning_does_not_claim_success_without_runtime_confirmation(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = LoopItem(
        id=f"I{uuid.uuid4().hex[:10]}",
        cloud_project_id=delivery_project.id,
        title="Pause planning without Runtime confirmation",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "none",
                "advancement_policy": "ai",
                "approval_policy": "required",
                "ai_automation_rule_id": "rule-1",
                "orchestration_status": "idle",
                "nodes": [],
            }
        },
    )
    test_db.add(issue)
    test_db.flush()
    workflow_run = issue_workflow_planning_service.ensure_run(
        test_db,
        issue=issue,
        user_id=test_user.id,
    )
    manager_run = ProjectAutomationRun(
        id=f"A{uuid.uuid4().hex[:10]}",
        cloud_project_id=delivery_project.id,
        parent_id="rule-1",
        task_id=issue.id,
        title="AI manager",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"event": {"payload": {"workflow_run_id": workflow_run.id}}},
    )
    test_db.add(manager_run)
    test_db.commit()
    monkeypatch.setattr(
        deliveries_endpoint.project_automation_service,
        "cancel_run",
        AsyncMock(
            side_effect=HTTPException(
                status_code=502,
                detail="Runtime did not confirm cancellation",
            )
        ),
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue.id}/workflow-plan/pause",
        headers=_auth(test_token),
        json={},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Runtime did not confirm cancellation"
    plan = issue_workflow_planning_service.get(
        test_db,
        issue_id=issue.id,
        user_id=test_user.id,
    )
    assert plan is not None
    assert plan.status == "planning"


def test_assignment_endpoint_preserves_coordinator_identity(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = LoopItem(
        id=f"I{uuid.uuid4().hex[:10]}",
        cloud_project_id=delivery_project.id,
        title="Submit manager plan",
        status="pending",
        created_by_user_id=test_user.id,
    )
    test_db.add(issue)
    test_db.commit()
    submit = AsyncMock(return_value={"orchestration_status": "completed"})
    monkeypatch.setattr(deliveries_endpoint.issue_assignment_service, "decide", submit)

    response = test_client.post(
        f"/api/v1/loop-items/{issue.id}/assignment",
        headers={
            **_auth(test_token),
            "X-Wegent-Automation-Run-ID": "automation-run-1",
        },
        json={
            "request_id": "decision-1",
            "expected_assignment_version": 0,
            "action": "complete",
            "reason": "Acceptance verified",
        },
    )

    assert response.status_code == 200
    submit.assert_awaited_once()
    assert submit.await_args.kwargs["manager_run_id"] == "automation-run-1"
    assert submit.await_args.kwargs["issue_id"] == issue.id
    assert submit.await_args.kwargs["decision"].action == "complete"


def test_workflow_task_binding_requires_a_ready_non_automated_stage(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
) -> None:
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "nodes": [
                {
                    "id": "develop",
                    "name": "Develop",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                },
                {
                    "id": "test",
                    "name": "Test",
                    "kind": "my_task",
                    "depends_on": ["develop"],
                    "required": True,
                    "workspace_policy": "inherit",
                },
                {
                    "id": "deploy",
                    "name": "Deploy",
                    "kind": "automation",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "none",
                    "automation_rule_id": "rule-1",
                },
            ],
        },
    }
    test_db.commit()
    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Workflow binding"},
    ).json()

    blocked = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "test-task",
            "workflowNodeId": "test",
        },
    )
    assert blocked.status_code == 409

    automatic = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "deploy-task",
            "workflowNodeId": "deploy",
        },
    )
    assert automatic.status_code == 422

    first = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "develop-task",
            "workflowNodeId": "develop",
        },
    )
    assert first.status_code == 201
    assert first.json()["workflow_node_id"] == "develop"
    context = test_client.get(
        "/api/v1/runtime-tasks/cloud-context",
        headers=_auth(test_token),
        params={"device_id": "local-device", "task_id": "develop-task"},
    )
    assert context.status_code == 200
    assert context.json()["workflow_node_id"] == "develop"

    duplicate = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "other-develop-task",
            "workflowNodeId": "develop",
        },
    )
    assert duplicate.status_code == 201
    assert duplicate.json()["workflow_node_id"] == "develop"

    stored_item = test_db.get(LoopItem, item["id"])
    assert stored_item is not None
    metadata = dict(stored_item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    nodes[0]["status"] = "awaiting_approval"
    workflow["nodes"] = nodes
    metadata["workflow"] = workflow
    stored_item.metadata_json = metadata
    test_db.commit()

    correction = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "correction-task",
            "workflowNodeId": "develop",
        },
    )
    assert correction.status_code == 201
    assert correction.json()["workflow_node_id"] == "develop"

    stored_item = test_db.get(LoopItem, item["id"])
    assert stored_item is not None
    metadata = dict(stored_item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    nodes[0]["decision_history"] = [
        {
            "action": "reject",
            "actor_user_id": 1,
            "reason": "Needs correction",
            "decided_at": "2026-08-19T02:47:28+00:00",
        }
    ]
    workflow["nodes"] = nodes
    metadata["workflow"] = workflow
    stored_item.metadata_json = metadata
    test_db.commit()
    current = test_client.get(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
    ).json()

    serialized = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={
            "version": current["version"],
            "status": current["status"],
            "workflow": current["workflow"],
        },
    )
    assert serialized.status_code == 200


def test_workflow_task_binding_survives_missing_dependency_delivery_content(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
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
                    "id": "develop",
                    "name": "Develop",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                },
                {
                    "id": "deploy",
                    "name": "Deploy",
                    "kind": "my_task",
                    "depends_on": ["develop"],
                    "dependency_context": {"develop": ["deliveries"]},
                    "required": True,
                    "workspace_policy": "inherit",
                },
            ],
        },
    }
    test_db.commit()
    item = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Missing dependency delivery"},
    ).json()
    source_task = {
        "deviceId": "local-device",
        "taskId": "develop-task",
        "taskTitle": "Develop",
        "workflowNodeId": "develop",
    }
    source_binding = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert source_binding.status_code == 201
    draft = test_client.post(
        f"/api/v1/loop-items/{item['id']}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "# Develop", "source_task": source_task},
    ).json()
    finalized = test_client.post(
        f"/api/v1/deliveries/{draft['id']}/finalize",
        headers=_auth(test_token),
    )
    assert finalized.status_code == 200

    delivery = test_db.get(Delivery, draft["id"])
    assert delivery is not None
    delivery_storage.objects.pop(delivery.markdown_object_key)
    stored_item = test_db.get(LoopItem, item["id"])
    assert stored_item is not None
    metadata = dict(stored_item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    nodes[0]["status"] = "completed"
    nodes[1]["status"] = "ready"
    workflow["nodes"] = nodes
    metadata["workflow"] = workflow
    stored_item.metadata_json = metadata
    test_db.commit()

    response = test_client.post(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={
            "deviceId": "local-device",
            "taskId": "deploy-task",
            "workflowNodeId": "deploy",
        },
    )

    assert response.status_code == 201
    assert response.json()["workflow_node_id"] == "deploy"
    binding = test_db.get(LoopItemTaskBinding, response.json()["id"])
    assert binding is not None
    assert "workflow_stage_input" not in binding.metadata_json
    context_response = test_client.get(
        f"/api/v1/loop-items/{item['id']}/workflow-nodes/deploy/input-context",
        headers=_auth(test_token),
    )
    assert context_response.status_code == 200
    compiled_instruction = context_response.json()["compiled_task_instruction"]
    assert "workflow_node_id: deploy" in compiled_instruction
    assert "get_board_item" in compiled_instruction
    assert "read_delivery" in compiled_instruction
    assert draft["id"] in compiled_instruction
    assert context_response.json()["upstream_deliverables"][0]["stage_id"] == "develop"
    assert "dependencies" not in context_response.json()


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
            "assignmentMode": "manual",
            "roleSource": "generic",
            "runtimeSource": "runtime_user",
            "runtimeUserId": test_user.id,
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

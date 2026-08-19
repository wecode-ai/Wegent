# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""End-to-end API tests for immutable TODO delivery snapshots."""

import io
import json
import uuid
from typing import Any, BinaryIO
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, ProjectWorkflowPlanItem, ProjectWorkflowRun
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.task import TaskResource
from app.models.user import User
from app.services.delivery import delivery_service
from app.services.delivery.storage import DeliveryStorageUnavailableError


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
        value = self.objects[object_key]
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
) -> None:
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


def test_ai_workflow_plan_is_approved_idempotently_and_advances_from_checkpoint(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.project_automations import project_automation_processor

    process = AsyncMock(return_value=1)
    monkeypatch.setattr(project_automation_processor, "process", process)
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "ai",
            "approval_policy": "required",
            "ai_automation_rule_id": "coordinator-rule",
            "nodes": [
                {
                    "id": "analysis",
                    "name": "Analysis",
                    "depends_on": [],
                    "workspace_policy": "composer",
                },
                {
                    "id": "delivery",
                    "name": "Delivery",
                    "depends_on": ["analysis"],
                    "workspace_policy": "inherit",
                },
            ],
        },
    }
    test_db.commit()

    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "AI coordinated issue"},
    )
    assert created.status_code == 201
    issue = created.json()
    assert issue["workflow"]["orchestration_status"] == "planning"
    assert issue["workflow"]["current_stage_id"] == "analysis"
    process.reset_mock()

    submitted = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan",
        headers=_auth(test_token),
        json={
            "summary": "Analyze first",
            "items": [
                {
                    "client_key": "analysis-1",
                    "stage_id": "analysis",
                    "title": "Analyze requirements",
                    "assignee_type": "user",
                    "assignee_id": str(test_user.id),
                    "assignee_name": test_user.user_name,
                }
            ],
        },
    )
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "awaiting_approval"

    approved = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/approve",
        headers=_auth(test_token),
    )
    assert approved.status_code == 200
    approved_plan = approved.json()
    child_id = approved_plan["items"][0]["task_id"]
    assert approved_plan["status"] == "running"
    assert child_id

    repeated = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/approve",
        headers=_auth(test_token),
    )
    assert repeated.status_code == 200
    assert repeated.json()["items"][0]["task_id"] == child_id

    completed = test_client.patch(
        f"/api/v1/loop-items/{child_id}",
        headers=_auth(test_token),
        json={"status": "completed", "version": 1},
    )
    assert completed.status_code == 200

    next_plan = test_client.get(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan",
        headers=_auth(test_token),
    )
    assert next_plan.status_code == 200
    assert next_plan.json()["stage_id"] == "delivery"
    assert next_plan.json()["plan_version"] == 2
    assert next_plan.json()["status"] == "planning"
    process.assert_awaited_once()
    event = process.await_args.args[1]
    assert event.event_type == "workflow.replan"
    assert event.subject_id == issue["id"]


def test_ai_workflow_rejects_active_run_from_another_issue(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.project_automations import project_automation_processor

    monkeypatch.setattr(
        project_automation_processor,
        "process",
        AsyncMock(return_value=1),
    )
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "none",
            "advancement_policy": "ai",
            "approval_policy": "required",
            "ai_automation_rule_id": "coordinator-rule",
            "nodes": [],
        },
    }
    test_db.commit()

    first = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "First AI issue"},
    ).json()
    second = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Second AI issue"},
    ).json()

    tampered_workflow = {
        **second["workflow"],
        "active_run_id": first["workflow"]["active_run_id"],
    }
    rejected_update = test_client.patch(
        f"/api/v1/loop-items/{second['id']}",
        headers=_auth(test_token),
        json={
            "version": second["version"],
            "workflow": tampered_workflow,
        },
    )
    assert rejected_update.status_code == 409
    assert rejected_update.json()["detail"] == (
        "AI workflow state is managed by workflow actions"
    )

    second_item = test_db.get(LoopItem, second["id"])
    assert second_item is not None
    metadata = dict(second_item.metadata_json or {})
    workflow = dict(metadata["workflow"])
    workflow["active_run_id"] = first["workflow"]["active_run_id"]
    metadata["workflow"] = workflow
    second_item.metadata_json = metadata
    test_db.commit()

    response = test_client.get(
        f"/api/v1/loop-items/{second['id']}/workflow-plan",
        headers=_auth(test_token),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "The active workflow run does not belong to this Issue"
    )


def test_ai_workflow_without_dag_plans_and_completes_at_issue_scope(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.project_automations import project_automation_processor

    monkeypatch.setattr(
        project_automation_processor,
        "process",
        AsyncMock(return_value=1),
    )
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "none",
            "advancement_policy": "ai",
            "approval_policy": "required",
            "ai_automation_rule_id": "coordinator-rule",
            "nodes": [],
        },
    }
    test_db.commit()

    created = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Free AI coordinated issue"},
    )
    assert created.status_code == 201
    issue = created.json()
    assert issue["workflow"]["orchestration_status"] == "planning"
    assert issue["workflow"]["current_stage_id"] is None
    assert issue["workflow"]["nodes"] == []

    paused = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/pause",
        headers=_auth(test_token),
    )
    assert paused.status_code == 200
    assert paused.json()["status"] == "paused"

    resumed = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/resume",
        headers=_auth(test_token),
    )
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "planning"
    assert resumed.json()["stage_id"] == "__issue__"

    replanned = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/replan",
        headers=_auth(test_token),
    )
    assert replanned.status_code == 200
    assert replanned.json()["plan_version"] == 2
    assert replanned.json()["stage_id"] == "__issue__"

    submitted = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan",
        headers=_auth(test_token),
        json={
            "summary": "Plan the whole Issue",
            "items": [
                {
                    "client_key": "issue-1",
                    "stage_id": "__issue__",
                    "title": "Deliver the Issue",
                    "assignee_type": "user",
                    "assignee_id": str(test_user.id),
                    "assignee_name": test_user.user_name,
                }
            ],
        },
    )
    assert submitted.status_code == 200
    assert submitted.json()["stage_id"] == "__issue__"
    assert submitted.json()["plan_version"] == 2

    approved = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/approve",
        headers=_auth(test_token),
    )
    assert approved.status_code == 200
    child_id = approved.json()["items"][0]["task_id"]

    completed = test_client.patch(
        f"/api/v1/loop-items/{child_id}",
        headers=_auth(test_token),
        json={"status": "completed", "version": 1},
    )
    assert completed.status_code == 200

    refreshed = test_client.get(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(test_token),
    )
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "in_review"
    assert refreshed.json()["workflow"]["orchestration_status"] == "completed"
    assert refreshed.json()["workflow"]["active_run_id"] is None
    assert refreshed.json()["workflow"]["current_stage_id"] is None
    assert refreshed.json()["workflow"]["nodes"] == []


def test_ai_workflow_replans_once_when_a_task_reports_rework(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    delivery_project: CloudProject,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.project_automations import project_automation_processor

    process = AsyncMock(return_value=1)
    monkeypatch.setattr(project_automation_processor, "process", process)
    delivery_project.metadata_json = {
        **(delivery_project.metadata_json or {}),
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "ai",
            "approval_policy": "required",
            "ai_automation_rule_id": "coordinator-rule",
            "nodes": [
                {
                    "id": "test",
                    "name": "Test",
                    "depends_on": [],
                    "workspace_policy": "composer",
                }
            ],
        },
    }
    test_db.commit()

    issue = test_client.post(
        f"/api/v1/cloud-projects/{delivery_project.id}/loop-items",
        headers=_auth(test_token),
        json={"title": "Verify AI workflow"},
    ).json()
    process.reset_mock()
    submitted = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan",
        headers=_auth(test_token),
        json={
            "summary": "Run verification",
            "items": [
                {
                    "client_key": "test-1",
                    "stage_id": "test",
                    "title": "Verify implementation",
                    "assignee_type": "user",
                    "assignee_id": str(test_user.id),
                    "assignee_name": test_user.user_name,
                }
            ],
        },
    )
    assert submitted.status_code == 200
    approved = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/workflow-plan/approve",
        headers=_auth(test_token),
    ).json()
    child_id = approved["items"][0]["task_id"]

    outcome = test_client.post(
        f"/api/v1/loop-items/{child_id}/workflow-outcome",
        headers=_auth(test_token),
        json={
            "verdict": "needs_rework",
            "summary": "Login returns 500",
            "findings": ["Empty user profile crashes the handler"],
        },
    )

    assert outcome.status_code == 200
    assert outcome.json()["status"] == "planning"
    assert outcome.json()["stage_id"] == "test"
    assert outcome.json()["plan_version"] == 2
    assert outcome.json()["items"] == []
    process.assert_awaited_once()
    event = process.await_args.args[1]
    assert event.event_type == "workflow.replan"
    assert event.subject_id == issue["id"]
    assert event.payload["rework"]["summary"] == "Login returns 500"
    assert process.await_args.kwargs["automation_id"] == "coordinator-rule"

    runs = (
        test_db.query(ProjectWorkflowRun)
        .filter(ProjectWorkflowRun.parent_id == issue["id"])
        .all()
    )
    assert len(runs) == 2
    assert {run.status for run in runs} == {"failed", "planning"}
    old_run = next(run for run in runs if run.status == "failed")
    old_item = (
        test_db.query(ProjectWorkflowPlanItem)
        .filter(ProjectWorkflowPlanItem.parent_id == old_run.id)
        .one()
    )
    assert old_item.status == "superseded"
    assert old_item.metadata_json["outcome"]["verdict"] == "needs_rework"

    repeated = test_client.post(
        f"/api/v1/loop-items/{child_id}/workflow-outcome",
        headers=_auth(test_token),
        json={
            "verdict": "needs_rework",
            "summary": "Login returns 500",
            "findings": ["Empty user profile crashes the handler"],
        },
    )
    assert repeated.status_code == 200
    assert repeated.json()["plan_version"] == 2
    assert process.await_count == 1
    assert (
        test_db.query(ProjectWorkflowRun)
        .filter(ProjectWorkflowRun.parent_id == issue["id"])
        .count()
        == 2
    )


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

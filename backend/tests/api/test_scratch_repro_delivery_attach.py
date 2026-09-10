# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Scratch reproduction for WORK-208: delivery finalize while node is running."""

import json
import uuid
from typing import Any, BinaryIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem
from app.models.user import User
from app.services.delivery import delivery_service


def _auth(test_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {test_token}"}


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
            raise ValueError(object_key) from exc
        if max_bytes is not None and len(value) > max_bytes:
            raise ValueError("too large")
        return value

    def download_url(self, object_key: str, expires_seconds: int = 900) -> str:
        return f"https://storage.test/{object_key}"

    def remove_objects(self, object_keys: list[str]) -> None:
        for object_key in object_keys:
            self.objects.pop(object_key, None)


@pytest.fixture
def delivery_storage(monkeypatch: pytest.MonkeyPatch) -> FakeDeliveryStorage:
    storage = FakeDeliveryStorage()
    monkeypatch.setattr(delivery_service, "storage", storage)
    monkeypatch.setattr("app.services.loop_items.service.delivery_storage", storage)
    return storage


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


def test_scratch_finalize_while_node_running_attaches_delivery(
    test_client: TestClient,
    test_token: str,
    delivery_project: Any,
    delivery_storage: Any,
    test_db: Session,
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
        json={"title": "Ship pull request while node running"},
    ).json()
    item_id = item["id"]

    # Force the workflow node into the running state, like a dispatched robot.
    stored = test_db.get(LoopItem, item_id)
    assert stored is not None
    metadata = dict(stored.metadata_json or {})
    workflow = dict(metadata["workflow"])
    nodes = [dict(node) for node in workflow["nodes"]]
    for node in nodes:
        if node.get("id") == "implementation":
            node["status"] = "running"
    workflow["nodes"] = nodes
    metadata["workflow"] = workflow
    stored.metadata_json = metadata
    test_db.commit()

    source_task = {
        "deviceId": "local-device",
        "taskId": "implementation-task",
        "taskTitle": "Implement feature",
        "workflowNodeId": "implementation",
    }
    binding_response = test_client.post(
        f"/api/v1/loop-items/{item_id}/tasks",
        headers=_auth(test_token),
        json=source_task,
    )
    assert binding_response.status_code == 201
    draft = test_client.post(
        f"/api/v1/loop-items/{item_id}/deliveries",
        headers=_auth(test_token),
        json={"markdown": "# Complete", "source_task": source_task},
    )
    assert draft.status_code == 201
    delivery_id = draft.json()["id"]

    finalized = test_client.post(
        f"/api/v1/deliveries/{delivery_id}/finalize",
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

    test_db.expire_all()
    stored = test_db.get(LoopItem, item_id)
    assert stored is not None
    node = next(
        candidate
        for candidate in (stored.metadata_json or {})["workflow"]["nodes"]
        if candidate.get("id") == "implementation"
    )
    assert delivery_id in node.get(
        "delivery_ids", []
    ), f"delivery not attached to node: {node.get('delivery_ids')}"

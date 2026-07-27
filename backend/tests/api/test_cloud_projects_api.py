# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for cloud projects, TODOs, and local task associations."""

import io
from datetime import datetime
from typing import BinaryIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import CloudProject, Delivery, DeliveryAsset
from app.models.project import Project
from app.models.user import User
from app.services.cloud_files import cloud_file_service
from app.services.delivery import delivery_service


class FakeCloudFileStorage:
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

    def get_bytes(self, object_key: str, max_bytes: int | None = None) -> bytes:
        return self.objects[object_key]

    def download_url(self, object_key: str, expires_seconds: int = 900) -> str:
        return f"https://storage.test/{object_key}"

    def remove_objects(self, object_keys: list[str]) -> None:
        for key in object_keys:
            self.objects.pop(key, None)

    def copy_object(self, source_key: str, target_key: str) -> None:
        self.objects[target_key] = self.objects[source_key]


@pytest.fixture
def cloud_file_storage(monkeypatch: pytest.MonkeyPatch) -> FakeCloudFileStorage:
    storage = FakeCloudFileStorage()
    monkeypatch.setattr(cloud_file_service, "storage", storage)
    monkeypatch.setattr(delivery_service, "storage", storage)
    return storage


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_cloud_project_tag_registry(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "preg", "name": "Tag registry"},
    )
    assert created.status_code == 201
    project = created.json()
    assert project["tags"] == []

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(test_token),
        json={
            "version": project["version"],
            "tags": [" 产品需求 ", "产品需求", "研发"],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["tags"] == ["产品需求", "研发"]

    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(test_token))
    assert listed.status_code == 200
    match = next(item for item in listed.json()["items"] if item["id"] == project["id"])
    assert match["tags"] == ["产品需求", "研发"]

    # Updating other fields leaves the registry untouched.
    renamed = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(test_token),
        json={"version": updated.json()["version"], "name": "Renamed"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["tags"] == ["产品需求", "研发"]

    cleared = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(test_token),
        json={"version": renamed.json()["version"], "tags": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["tags"] == []


def test_cloud_project_generates_key_when_omitted(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"name": "中文项目空间", "description": "Generated key"},
    )

    assert created.status_code == 201
    assert isinstance(created.json()["id"], str)
    assert created.json()["project_key"].startswith("PRJ")
    assert 2 <= len(created.json()["project_key"]) <= 16


def test_cloud_project_persists_external_task_provider_and_encrypted_token(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GIT_TOKEN_AES_KEY", raising=False)
    monkeypatch.delenv("GIT_TOKEN_AES_IV", raising=False)

    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "name": "GitHub issues",
            "task_provider": "github",
            "provider_config": {
                "repository": "wecode-ai/Wegent",
                "domain": "github.com",
                "token": "github-secret",
            },
        },
    )

    assert created.status_code == 201
    assert created.json()["project_store"] == "backend"
    assert created.json()["task_provider"] == "github"
    assert created.json()["provider_config"] == {
        "repository": "wecode-ai/Wegent",
        "domain": "github.com",
        "credential_configured": True,
    }

    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(test_token))
    match = next(
        item for item in listed.json()["items"] if item["id"] == created.json()["id"]
    )
    assert match["task_provider"] == "github"
    assert match["provider_config"]["repository"] == "wecode-ai/Wegent"
    assert match["provider_config"]["credential_configured"] is True

    stored = (
        test_db.query(CloudProject)
        .filter(CloudProject.id == created.json()["id"])
        .one()
    )
    serialized = str(stored.metadata_json)
    assert "github-secret" not in serialized
    assert "ciphertext" in serialized
    credential_metadata = stored.metadata_json["provider_config"]["credential"]
    assert credential_metadata["version"] == 2
    assert credential_metadata["algorithm"] == "aes-256-gcm"

    credential = test_client.get(
        f"/api/v1/cloud-projects/{created.json()['id']}/provider-credential",
        headers=_auth(test_token),
    )
    assert credential.status_code == 200
    assert credential.json() == {"token": "github-secret"}
    assert credential.headers["cache-control"] == "no-store"


def test_cloud_project_can_add_missing_provider_token(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "name": "Existing GitLab project",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.example.com",
                "api_base": "https://gitlab.example.com/api/v4",
            },
        },
    ).json()

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.example.com",
                "api_base": "https://gitlab.example.com/api/v4",
                "token": "gitlab-secret",
            },
        },
    )

    assert updated.status_code == 200
    assert updated.json()["provider_config"]["credential_configured"] is True
    credential = test_client.get(
        f"/api/v1/cloud-projects/{created['id']}/provider-credential",
        headers=_auth(test_token),
    )
    assert credential.json() == {"token": "gitlab-secret"}


def test_external_cloud_project_rejects_internal_loop_item_routes(
    test_client: TestClient, test_token: str
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "name": "GitLab issues",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.example.com",
                "api_base": "https://gitlab.example.com/api/v4",
            },
        },
    ).json()

    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
    )
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Must be created in GitLab"},
    )

    assert listed.status_code == 409
    assert created.status_code == 409
    assert "use the local Issue provider" in created.json()["detail"]


def test_cloud_project_can_link_local_workspace(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    local_project = Project(
        user_id=test_user.id,
        name="Local checkout",
        client_origin="wework",
    )
    test_db.add(local_project)
    test_db.commit()
    test_db.refresh(local_project)

    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "collab",
            "name": "Shared collaboration",
            "description": "A cloud-first project",
        },
    )
    assert created.status_code == 201
    cloud_project = created.json()
    assert cloud_project["project_key"] == "COLLAB"

    linked = test_client.post(
        f"/api/v1/cloud-projects/{cloud_project['id']}/local-bindings",
        headers=_auth(test_token),
        json={
            "local_project_id": local_project.id,
            "device_id": "desktop-1",
            "is_default": True,
        },
    )
    assert linked.status_code == 201
    assert linked.json()["local_project_id"] == local_project.id

    bindings = test_client.get(
        f"/api/v1/cloud-projects/{cloud_project['id']}/local-bindings",
        headers=_auth(test_token),
    )
    assert bindings.status_code == 200
    assert bindings.json()[0]["device_id"] == "desktop-1"


def test_todo_lifecycle_and_multiple_local_tasks(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "chain", "name": "Task chain"},
    ).json()
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Prepare release", "priority": "high"},
    )
    assert created.status_code == 201
    item = created.json()
    assert item["id"] == "CHAIN-1"
    assert item["cloud_project_id"] == project["id"]
    assert item["status"] == "inbox"

    tasks = [
        {"deviceId": "desktop-1", "taskId": f"release-{index}"} for index in range(2)
    ]
    for task in tasks:
        response = test_client.post(
            f"/api/v1/loop-items/{item['id']}/tasks",
            headers=_auth(test_token),
            json=task,
        )
        assert response.status_code == 201

    bindings = test_client.get(
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
    )
    assert bindings.status_code == 200
    assert {binding["task_id"] for binding in bindings.json()} == {
        task["taskId"] for task in tasks
    }
    linked_item = test_client.get(
        "/api/v1/runtime-tasks/loop-item",
        headers=_auth(test_token),
        params={"device_id": "desktop-1", "task_id": "release-0"},
    )
    assert linked_item.status_code == 200
    assert linked_item.json()["id"] == item["id"]

    unbound = test_client.request(
        "DELETE",
        f"/api/v1/loop-items/{item['id']}/tasks",
        headers=_auth(test_token),
        json={"deviceId": "desktop-1", "taskId": "release-0"},
    )
    assert unbound.status_code == 204
    no_longer_linked = test_client.get(
        "/api/v1/runtime-tasks/loop-item",
        headers=_auth(test_token),
        params={"device_id": "desktop-1", "task_id": "release-0"},
    )
    assert no_longer_linked.status_code == 404

    current_item = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
    ).json()["items"][0]

    started = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": current_item["version"], "status": "in_progress"},
    )
    assert started.status_code == 200
    assert started.json()["version"] == current_item["version"] + 1

    stale = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": item["version"], "title": "Stale title"},
    )
    assert stale.status_code == 409

    my_work = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=_auth(test_token)
    )
    assert my_work.status_code == 200
    assert my_work.json()["items"][0]["has_active_task"] is True


def test_loop_item_tags_roundtrip(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "tags", "name": "Tagged items"},
    ).json()
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={
            "title": "Tagged item",
            "assignee_user_id": test_user.id,
            "tags": [" 产品需求 ", "产品需求", "研发", ""],
        },
    )
    assert created.status_code == 201
    item = created.json()
    # Tags are trimmed, deduped, and empties dropped.
    assert item["tags"] == ["产品需求", "研发"]

    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
    )
    assert listed.status_code == 200
    assert listed.json()["items"][0]["tags"] == ["产品需求", "研发"]

    updated = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": item["version"], "tags": ["线上问题"]},
    )
    assert updated.status_code == 200
    assert updated.json()["tags"] == ["线上问题"]

    cleared = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": updated.json()["version"], "tags": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["tags"] == []

    my_work = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=_auth(test_token)
    )
    assert my_work.status_code == 200
    assert my_work.json()["items"][0]["tags"] == []

    # Updates that omit tags must leave existing tags untouched.
    tagged = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": cleared.json()["version"], "tags": ["产品需求"]},
    )
    assert tagged.status_code == 200
    untouched = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": tagged.json()["version"], "title": "Retagged item"},
    )
    assert untouched.status_code == 200
    assert untouched.json()["tags"] == ["产品需求"]


def test_cloud_project_owner_can_manage_members(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    member_user = User(
        user_name="collaborator",
        password_hash="unused",
        email="collaborator@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(member_user)
    test_db.commit()
    test_db.refresh(member_user)
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "members", "name": "Member roles"},
    ).json()

    added = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(test_token),
        json={"user_id": member_user.id, "role": "Developer"},
    )
    assert added.status_code == 201
    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/members/{member_user.id}",
        headers=_auth(test_token),
        json={"role": "Reporter"},
    )
    assert updated.status_code == 200
    assert updated.json()["role"] == "Reporter"
    members = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(test_token),
    )
    assert members.status_code == 200
    members = members.json()
    assert {member["user_id"] for member in members} == {test_user.id, member_user.id}

    removed = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}/members/{member_user.id}",
        headers=_auth(test_token),
    )
    assert removed.status_code == 204


def test_todo_can_move_directly_between_board_states(
    test_client: TestClient,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "state", "name": "State machine"},
    ).json()
    item = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Review transition"},
    ).json()
    response = test_client.patch(
        f"/api/v1/loop-items/{item['id']}",
        headers=_auth(test_token),
        json={"version": item["version"], "status": "in_review"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "in_review"


def test_cloud_workspace_file_round_trip(
    test_client: TestClient,
    test_token: str,
    cloud_file_storage: FakeCloudFileStorage,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "files", "name": "Shared files"},
    ).json()
    folder = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/folders",
        headers=_auth(test_token),
        json={"path": "research"},
    )
    uploaded = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/files",
        headers=_auth(test_token),
        data={"path": "research/notes.md"},
        files={"file": ("notes.md", io.BytesIO(b"# Notes"), "text/markdown")},
    )

    assert folder.status_code == 201
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/files",
        headers=_auth(test_token),
    )
    accessed = test_client.get(
        f"/api/v1/cloud-projects/files/{file_id}/access",
        headers=_auth(test_token),
    )
    assert [item["path"] for item in listed.json()["items"]] == [
        "research",
        "research/notes.md",
    ]
    assert accessed.status_code == 200
    assert accessed.json()["url"].endswith("/shared/research/notes.md")

    moved = test_client.patch(
        f"/api/v1/cloud-projects/files/{folder.json()['id']}",
        headers=_auth(test_token),
        json={"path": "archive", "version": folder.json()["version"]},
    )
    assert moved.status_code == 200
    assert moved.json()["path"] == "archive"
    moved_files = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/files",
        headers=_auth(test_token),
    ).json()["items"]
    assert [entry["path"] for entry in moved_files] == [
        "archive",
        "archive/notes.md",
    ]

    non_recursive = test_client.delete(
        f"/api/v1/cloud-projects/files/{folder.json()['id']}",
        headers=_auth(test_token),
    )
    assert non_recursive.status_code == 409
    recursive = test_client.delete(
        f"/api/v1/cloud-projects/files/{folder.json()['id']}?recursive=true",
        headers=_auth(test_token),
    )
    assert recursive.status_code == 204
    assert cloud_file_storage.objects == {}


def test_cloud_workspace_lists_immutable_delivery_files(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    cloud_file_storage: FakeCloudFileStorage,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "snap", "name": "Delivery snapshots"},
    ).json()
    item = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Publish report"},
    ).json()
    delivered_at = datetime(2026, 7, 22, 12, 0, 0)
    delivery = Delivery(
        id="delivery-snapshot",
        loop_item_id=item["id"],
        created_by_user_id=1,
        status="delivered",
        markdown_object_key="snapshot/markdown.md",
        delivered_at=delivered_at,
    )
    asset = DeliveryAsset(
        id="asset-snapshot",
        delivery_id=delivery.id,
        kind="file",
        display_name="report.pdf",
        relative_path="reports/report.pdf",
        object_key="snapshot/files/report.pdf",
        content_type="application/pdf",
        size_bytes=6,
        sha256="0" * 64,
    )
    test_db.add_all([delivery, asset])
    test_db.commit()
    cloud_file_storage.objects[asset.object_key] = b"report"

    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/delivery-files",
        headers=_auth(test_token),
    )
    accessed = test_client.get(
        f"/api/v1/delivery-assets/{asset.id}/access",
        headers=_auth(test_token),
    )

    assert listed.status_code == 200
    assert listed.json()["items"] == [
        {
            "asset_id": asset.id,
            "delivery_id": delivery.id,
            "loop_item_id": item["id"],
            "loop_item_title": "Publish report",
            "relative_path": "reports/report.pdf",
            "display_name": "report.pdf",
            "content_type": "application/pdf",
            "size_bytes": 6,
            "delivered_at": "2026-07-22T12:00:00",
        }
    ]
    assert accessed.status_code == 200
    assert accessed.json()["url"].endswith("/snapshot/files/report.pdf")

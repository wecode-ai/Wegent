# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for cloud projects, TODOs, and local task associations."""

import hashlib
import hmac
import io
import json
from datetime import datetime
from typing import BinaryIO

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.delivery import (
    CloudProject,
    Delivery,
    DeliveryAsset,
    LoopItem,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project import Project
from app.models.user import User
from app.services.cloud_files import cloud_file_service
from app.services.delivery import delivery_service


class FakeProviderResponse:
    def __init__(self, payload: object, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code
        self.content = b"{}"

    def json(self) -> object:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "provider error",
                request=httpx.Request("GET", "https://provider.invalid"),
                response=httpx.Response(self.status_code),
            )


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


def test_cloud_project_card_display_is_shared_through_project_metadata(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "display", "name": "Shared card display"},
    ).json()
    assert created["card_display"] == {
        "show_assignee": True,
        "show_priority": True,
        "show_tags": True,
        "show_date": True,
    }

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "card_display": {
                **created["card_display"],
                "show_assignee": False,
            },
        },
    )
    assert updated.status_code == 200
    assert updated.json()["card_display"]["show_assignee"] is False

    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(test_token))
    match = next(item for item in listed.json()["items"] if item["id"] == created["id"])
    assert match["card_display"]["show_assignee"] is False


def test_cloud_project_board_config_supports_custom_statuses(
    test_client: TestClient, test_db: Session, test_token: str
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "board", "name": "Custom board"},
    ).json()
    assert [item["id"] for item in project["board_config"]["statuses"]] == [
        "inbox",
        "pending",
        "in_progress",
        "in_review",
        "completed",
    ]

    configured = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(test_token),
        json={
            "version": project["version"],
            "board_config": {
                "group_by": "priority",
                "statuses": [
                    {"id": "idea", "name": "想法", "color": "gray"},
                    {"id": "shipping", "name": "发布中", "color": "blue"},
                ],
            },
        },
    )
    assert configured.status_code == 200
    project = configured.json()
    assert project["board_config"]["group_by"] == "priority"

    task = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Ship it", "status": "shipping"},
    )
    assert task.status_code == 201

    stored_task = test_db.query(LoopItem).filter(LoopItem.id == task.json()["id"]).one()
    stored_task.assignee_user_id = None
    test_db.commit()
    my_work = test_client.get(
        "/api/v1/cloud-work-items/my-work", headers=_auth(test_token)
    )
    assert any(item["id"] == task.json()["id"] for item in my_work.json()["items"])

    cleared = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(test_token),
        json={
            "version": project["version"],
            "board_config": {"group_by": "assignee", "statuses": []},
        },
    )
    assert cleared.status_code == 200
    test_db.expire_all()
    refreshed = test_client.get(
        f"/api/v1/loop-items/{task.json()['id']}", headers=_auth(test_token)
    )
    assert refreshed.json()["status"] == ""


def test_cloud_project_ai_automation_is_shared_through_project_metadata(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "ai", "name": "AI automation"},
    ).json()
    assert created["ai_automation"] == {
        "auto_retry_on_failure": False,
        "max_retry_count": 1,
    }

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "ai_automation": {
                "auto_retry_on_failure": True,
                "max_retry_count": 3,
            },
        },
    )
    assert updated.status_code == 200
    assert updated.json()["ai_automation"] == {
        "auto_retry_on_failure": True,
        "max_retry_count": 3,
    }

    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(test_token))
    match = next(item for item in listed.json()["items"] if item["id"] == created["id"])
    assert match["ai_automation"]["auto_retry_on_failure"] is True
    assert match["ai_automation"]["max_retry_count"] == 3


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


def test_cloud_project_list_tolerates_unknown_task_provider(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    known = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "known", "name": "Known provider"},
    ).json()
    newer = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "newer", "name": "Newer provider"},
    ).json()
    stored = test_db.query(CloudProject).filter(CloudProject.id == newer["id"]).one()
    stored.metadata_json = {
        **stored.metadata_json,
        "task_provider": "provider-from-newer-branch",
    }
    test_db.commit()

    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(test_token))

    assert listed.status_code == 200
    projects = {item["id"]: item for item in listed.json()["items"]}
    assert projects[known["id"]]["task_provider"] == "local"
    assert projects[newer["id"]]["task_provider"] == "provider-from-newer-branch"


def test_added_member_can_list_private_cloud_project(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    member = User(
        user_name="cloud-project-member",
        password_hash="unused",
        email="cloud-project-member@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    member_token = create_access_token(data={"sub": member.user_name})

    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "sharedprivate",
            "name": "Shared private project",
            "visibility": "private",
        },
    ).json()
    added = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(test_token),
        json={"user_id": member.id, "role": "Developer"},
    )

    assert added.status_code == 201
    listed = test_client.get("/api/v1/cloud-projects", headers=_auth(member_token))
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["items"]] == [project["id"]]
    assert listed.json()["items"][0]["access_role"] == "Developer"


def test_public_project_visitors_only_access_their_own_todo_details(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    visitor = User(
        user_name="public-project-visitor",
        password_hash="unused",
        email="visitor@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(visitor)
    test_db.commit()
    test_db.refresh(visitor)
    visitor_token = create_access_token(data={"sub": visitor.user_name})

    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "public",
            "name": "Public collaboration",
            "visibility": "public",
        },
    ).json()
    owner_item = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Owner task", "description": "private task details"},
    ).json()

    listed_projects = test_client.get(
        "/api/v1/cloud-projects", headers=_auth(visitor_token)
    )
    assert listed_projects.status_code == 200
    visible_project = next(
        item for item in listed_projects.json()["items"] if item["id"] == project["id"]
    )
    assert visible_project["visibility"] == "public"
    assert visible_project["access_role"] == "RestrictedAnalyst"
    assert visible_project["current_user_id"] == visitor.id
    assert visible_project["current_user_name"] == visitor.user_name

    listed_items = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(visitor_token),
    )
    assert listed_items.status_code == 200
    owner_summary = listed_items.json()["items"][0]
    assert owner_summary["id"] == owner_item["id"]
    assert owner_summary["description"] == ""
    assert owner_summary["can_view_detail"] is False
    assert owner_summary["can_edit"] is False

    hidden_detail = test_client.get(
        f"/api/v1/loop-items/{owner_item['id']}",
        headers=_auth(visitor_token),
    )
    assert hidden_detail.status_code == 404

    visitor_item = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(visitor_token),
        json={"title": "Visitor task", "description": "visitor details"},
    )
    assert visitor_item.status_code == 201
    visitor_item_body = visitor_item.json()
    assert visitor_item_body["created_by_user_id"] == visitor.id
    assert visitor_item_body["can_view_detail"] is True
    assert visitor_item_body["can_edit"] is True

    updated = test_client.patch(
        f"/api/v1/loop-items/{visitor_item_body['id']}",
        headers=_auth(visitor_token),
        json={"version": visitor_item_body["version"], "title": "Visitor task updated"},
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Visitor task updated"

    external_project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "publicext",
            "name": "Public external collaboration",
            "visibility": "public",
            "task_provider": "github",
            "provider_config": {
                "repository": "acme/public",
                "token": "shared-provider-secret",
            },
        },
    ).json()
    hidden_credential = test_client.get(
        f"/api/v1/cloud-projects/{external_project['id']}/provider-credential",
        headers=_auth(visitor_token),
    )
    assert hidden_credential.status_code == 404


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
    assert credential.status_code == 404


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
    assert credential.status_code == 404


def test_cloud_project_normalizes_gitlab_web_page_repository(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "name": "GitLab web URL",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "hongyu91/tab-prompt/-/issues",
                "domain": "gitlab.example.com",
                "api_base": "https://gitlab.example.com/api/v4",
                "token": "gitlab-secret",
            },
        },
    )

    assert created.status_code == 201
    assert created.json()["provider_config"]["repository"] == "hongyu91/tab-prompt"


def test_external_cloud_project_requires_provider_credential(
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
    assert "Provider credential is not configured" in created.json()["detail"]


def test_backend_routes_cloud_github_issues_without_exposing_token(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created_issue = {
        "number": 7,
        "title": "Backend issue",
        "body": "private details",
        "state": "open",
        "labels": [
            {"name": "wegent:creator:1:admin"},
            {"name": "wegent:status:in_progress"},
            {"name": "bug"},
        ],
        "created_at": "2026-07-28T00:00:00Z",
        "updated_at": "2026-07-28T00:00:00Z",
        "closed_at": None,
    }
    requests: list[tuple[str, str, object]] = []

    def provider_request(
        method: str, url: str, **kwargs: object
    ) -> FakeProviderResponse:
        requests.append((method, url, kwargs.get("json")))
        if method == "GET":
            return FakeProviderResponse([created_issue])
        return FakeProviderResponse(created_issue)

    monkeypatch.setattr(httpx, "request", provider_request)
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "cloudgh",
            "name": "Cloud GitHub",
            "task_provider": "github",
            "provider_config": {
                "repository": "acme/repo",
                "token": "server-only-secret",
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
        json={"title": "Backend issue", "status": "in_progress", "tags": ["bug"]},
    )

    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == "CLOUDGH-7"
    assert created.status_code == 201
    assert any(method == "POST" for method, _, _ in requests)
    assert all("server-only-secret" not in str(payload) for _, _, payload in requests)


def test_public_github_project_enforces_issue_ownership(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    visitor = User(
        user_name="external-visitor",
        password_hash="unused",
        email="external-visitor@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(visitor)
    test_db.commit()
    test_db.refresh(visitor)
    visitor_token = create_access_token(data={"sub": visitor.user_name})
    issues = {
        1: {
            "number": 1,
            "title": "Owner issue",
            "body": "owner-only details",
            "state": "open",
            "labels": [{"name": "wegent:creator:1:admin"}],
            "created_at": "2026-07-28T00:00:00Z",
            "updated_at": "2026-07-28T00:00:00Z",
        },
        2: {
            "number": 2,
            "title": "Visitor issue",
            "body": "visitor details",
            "state": "open",
            "labels": [{"name": f"wegent:creator:{visitor.id}:{visitor.user_name}"}],
            "created_at": "2026-07-28T00:00:00Z",
            "updated_at": "2026-07-28T00:00:00Z",
        },
    }

    def provider_request(
        method: str, url: str, **kwargs: object
    ) -> FakeProviderResponse:
        if method == "GET" and url.endswith("/issues"):
            return FakeProviderResponse(list(issues.values()))
        number = int(url.rsplit("/", 1)[-1])
        return FakeProviderResponse(issues[number])

    monkeypatch.setattr(httpx, "request", provider_request)
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "publicgh",
            "name": "Public GitHub",
            "visibility": "public",
            "task_provider": "github",
            "provider_config": {
                "repository": "acme/public",
                "token": "server-only-secret",
            },
        },
    ).json()

    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(visitor_token),
    )
    assert listed.status_code == 200
    by_id = {item["id"]: item for item in listed.json()["items"]}
    assert by_id["PUBLICGH-1"]["description"] == ""
    assert by_id["PUBLICGH-1"]["can_view_detail"] is False
    assert by_id["PUBLICGH-2"]["description"] == "visitor details"
    assert by_id["PUBLICGH-2"]["created_by_user_name"] == visitor.user_name
    assert by_id["PUBLICGH-2"]["can_edit"] is True

    hidden = test_client.get(
        "/api/v1/loop-items/PUBLICGH-1", headers=_auth(visitor_token)
    )
    visible = test_client.get(
        "/api/v1/loop-items/PUBLICGH-2", headers=_auth(visitor_token)
    )
    assert hidden.status_code == 404
    assert visible.status_code == 200


def test_backend_routes_gitlab_updates_and_comments(
    test_client: TestClient,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    issue = {
        "iid": 9,
        "title": "GitLab issue",
        "description": "details",
        "state": "opened",
        "labels": ["wegent:creator:1:admin", "wegent:status:pending"],
        "created_at": "2026-07-28T00:00:00Z",
        "updated_at": "2026-07-28T00:00:00Z",
    }
    requests: list[tuple[str, str, object]] = []

    def provider_request(
        method: str, url: str, **kwargs: object
    ) -> FakeProviderResponse:
        payload = kwargs.get("json")
        requests.append((method, url, payload))
        if url.endswith("/notes"):
            return FakeProviderResponse(
                {
                    "id": 10,
                    "body": "ship it",
                    "author": {"username": "admin"},
                    "web_url": "https://gitlab.example.com/note/10",
                    "created_at": "2026-07-28T00:00:00Z",
                }
            )
        if method == "PUT" and isinstance(payload, dict):
            issue.update(payload)
            if isinstance(issue.get("labels"), str):
                issue["labels"] = str(issue["labels"]).split(",")
            issue["state"] = (
                "closed" if payload.get("state_event") == "close" else issue["state"]
            )
        return FakeProviderResponse(issue)

    monkeypatch.setattr(httpx, "request", provider_request)
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "cloudgl",
            "name": "Cloud GitLab",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "group/project",
                "domain": "gitlab.example.com",
                "api_base": "https://gitlab.example.com/api/v4",
                "token": "server-only-secret",
            },
        },
    ).json()

    updated = test_client.patch(
        "/api/v1/loop-items/CLOUDGL-9",
        headers=_auth(test_token),
        json={"version": 1, "status": "completed"},
    )
    commented = test_client.post(
        "/api/v1/loop-items/CLOUDGL-9/comments",
        headers=_auth(test_token),
        json={"body": "ship it"},
    )

    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"
    assert commented.status_code == 201
    assert commented.json()["web_url"] == "https://gitlab.example.com/note/10"
    assert any(method == "PUT" for method, _, _ in requests)
    assert any(url.endswith("/notes") for _, url, _ in requests)
    assert all("server-only-secret" not in str(payload) for _, _, payload in requests)


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
    assert item["assignee_name"] == test_user.user_name
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
    assert started.status_code == 200, started.text
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
    assert listed.json()["items"][0]["assignee_name"] == test_user.user_name

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


def test_loop_item_ai_assignee_is_project_scoped_and_exclusive(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="api-cloud-dev-1",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "cloud"},
                "metadata": {"name": "api-cloud-dev-1"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "aiowner", "name": "AI-owned work"},
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Reviewer",
            "runtime": "codex",
            "model": None,
            "systemPrompt": "Verify before reporting completion.",
            "executionEnvironment": "cloud",
            "executionDeviceId": "api-cloud-dev-1",
        },
    ).json()
    item = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Review this", "assignee_agent_id": agent["id"]},
    )

    assert item.status_code == 201
    assert item.json()["assignee_agent_id"] == agent["id"]
    assert item.json()["assignee_agent_name"] == "Reviewer"
    assert item.json()["assignee_user_id"] is None

    reassigned = test_client.patch(
        f"/api/v1/loop-items/{item.json()['id']}",
        headers=_auth(test_token),
        json={"version": item.json()["version"], "assignee_user_id": test_user.id},
    )
    assert reassigned.status_code == 200
    assert reassigned.json()["assignee_user_id"] == test_user.id
    assert reassigned.json()["assignee_agent_id"] is None


def test_cloud_project_robot_binds_local_project(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="api-local-dev-1",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "local"},
                "metadata": {"name": "api-local-dev-1"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "robotbind", "name": "Robot binding"},
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Bound Reviewer",
            "runtime": "codex",
            "executionEnvironment": "local",
            "executionDeviceId": "api-local-dev-1",
            "localProjectId": 91,
        },
    )
    assert agent.status_code == 201
    body = agent.json()
    assert body["localProjectId"] == 91

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents/{body['id']}",
        headers=_auth(test_token),
        json={"version": body["version"], "localProjectId": 92},
    )
    assert updated.status_code == 200
    assert updated.json()["localProjectId"] == 92

    cleared = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents/{body['id']}",
        headers=_auth(test_token),
        json={"version": updated.json()["version"], "localProjectId": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["localProjectId"] is None


def test_task_created_event_assigns_matching_project_automation_robot(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="event-cloud-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "cloud"},
                "metadata": {"name": "event-cloud-device"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "eventauto", "name": "Event automation"},
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Dispatcher",
            "runtime": "codex",
            "executionEnvironment": "cloud",
            "executionDeviceId": "event-cloud-device",
        },
    ).json()

    async def select_agent(db: Session, rule: object, event: object) -> str:
        return agent["id"]

    monkeypatch.setattr(
        "app.services.project_automations.project_automation_processor._select_agent",
        select_agent,
    )
    created_rule = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Assign new bugs",
            "prompt": "Read the task and choose its owner.",
            "triggerType": "event",
            "eventType": "task.created",
            "eventConfig": {"statuses": ["pending"], "priorities": ["high"]},
            "assignmentMode": "automatic",
        },
    )
    assert created_rule.status_code == 201
    rule = created_rule.json()
    assert rule["triggerType"] == "event"
    assert rule["assignmentMode"] == "automatic"
    assert rule["agentId"] is None
    assert rule["webhookEventId"] == rule["id"]
    assert rule["nextRunAt"] is None

    ignored = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Low priority bug", "status": "pending", "priority": "low"},
    )
    assert ignored.status_code == 201
    assert ignored.json()["assignee_agent_id"] is None

    task = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Production bug", "status": "pending", "priority": "high"},
    )
    assert task.status_code == 201
    assert task.json()["assignee_agent_id"] == agent["id"]
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == task.json()["id"])
        .one()
    )
    assert execution.execution_note == "Read the task and choose its owner."

    runs = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/runs",
        headers=_auth(test_token),
    )
    assert runs.status_code == 200
    assert len(runs.json()) == 1
    assert runs.json()[0]["trigger"] == "event"
    assert runs.json()[0]["taskId"] == task.json()["id"]


def test_project_automation_webhook_verifies_github_signature(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="hook-cloud-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "cloud"},
                "metadata": {"name": "hook-cloud-device"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "hook",
            "name": "Webhook project",
            "task_provider": "github",
            "provider_config": {
                "repository": "acme/hook",
                "token": "provider-token",
            },
        },
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Dispatcher",
            "runtime": "codex",
            "executionEnvironment": "cloud",
            "executionDeviceId": "hook-cloud-device",
        },
    ).json()
    rule = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "External issue",
            "prompt": "Dispatch the issue.",
            "triggerType": "event",
            "eventType": "task.created",
            "agentId": agent["id"],
        },
    ).json()
    assert rule["webhookSecret"]
    listed = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
    ).json()
    assert listed[0]["webhookSecret"] is None

    rotated_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}"
        "/rotate-webhook-secret",
        headers=_auth(test_token),
    )
    assert rotated_response.status_code == 200, rotated_response.text
    rotated = rotated_response.json()
    assert rotated["webhookSecret"]
    assert rotated["webhookSecret"] != rule["webhookSecret"]
    assert rotated["version"] == rule["version"] + 1

    captured: dict[str, object] = {}

    async def fake_process(
        db: Session, event: object, *, automation_id: str | None = None
    ) -> int:
        captured["event"] = event
        captured["automation_id"] = automation_id
        return 1

    monkeypatch.setattr(
        "app.api.endpoints.project_automations.project_automation_processor.process",
        fake_process,
    )
    payload = {"action": "opened", "issue": {"number": 42, "title": "Bug"}}
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = (
        "sha256="
        + hmac.new(rotated["webhookSecret"].encode(), body, hashlib.sha256).hexdigest()
    )
    rejected = test_client.post(
        f"/api/v1/cloud-projects/automation-events/{rule['webhookEventId']}",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=bad",
        },
    )
    response = test_client.post(
        f"/api/v1/cloud-projects/automation-events/{rule['webhookEventId']}",
        content=body,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature},
    )

    assert rejected.status_code == 401
    assert response.status_code == 202, response.text
    assert response.json() == {"status": "accepted", "dispatched": 1}
    assert captured["automation_id"] == rule["id"]
    event = captured["event"]
    assert getattr(event, "event_type") == "task.created"
    assert getattr(event, "subject_id") == f"{project['project_key']}-42"
    assert getattr(event, "actor_user_id") == test_user.id

    old_signature = (
        "sha256="
        + hmac.new(rule["webhookSecret"].encode(), body, hashlib.sha256).hexdigest()
    )
    old_secret_response = test_client.post(
        f"/api/v1/cloud-projects/automation-events/{rule['webhookEventId']}",
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": old_signature,
        },
    )
    assert old_secret_response.status_code == 401

    manual_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/run",
        headers=_auth(test_token),
    )
    assert manual_response.status_code == 409


def test_project_automation_webhook_verifies_gitlab_token(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={
            "project_key": "labhook",
            "name": "GitLab webhook project",
            "task_provider": "gitlab",
            "provider_config": {
                "repository": "acme/hook",
                "token": "provider-token",
            },
        },
    ).json()
    agent = ProjectChatAgent(
        cloud_project_id=project["id"],
        name="Dispatcher",
        title="Dispatcher",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"runtime": "codex"},
    )
    test_db.add(agent)
    test_db.commit()
    rule = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "External issue",
            "prompt": "Dispatch the issue.",
            "triggerType": "event",
            "eventType": "task.created",
            "agentId": agent.id,
        },
    ).json()

    async def fake_process(
        db: Session, event: object, *, automation_id: str | None = None
    ) -> int:
        return 1

    monkeypatch.setattr(
        "app.api.endpoints.project_automations.project_automation_processor.process",
        fake_process,
    )
    response = test_client.post(
        f"/api/v1/cloud-projects/automation-events/{rule['webhookEventId']}",
        headers={"X-Gitlab-Token": rule["webhookSecret"]},
        json={
            "object_kind": "issue",
            "event_type": "issue",
            "object_attributes": {"action": "open", "iid": 7, "title": "Bug"},
        },
    )

    assert response.status_code == 202, response.text
    assert response.json() == {"status": "accepted", "dispatched": 1}


def test_cloud_project_automation_creates_generic_task_for_cloud_robot(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="automation-cloud-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "cloud"},
                "metadata": {"name": "automation-cloud-device"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "automation", "name": "Project automation"},
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Project assistant",
            "runtime": "codex",
            "executionEnvironment": "cloud",
            "executionDeviceId": "automation-cloud-device",
        },
    ).json()

    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Daily project summary",
            "prompt": "Summarize yesterday's completed work.",
            "cronExpression": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "agentId": agent["id"],
            "enabled": True,
        },
    )
    assert created.status_code == 201
    rule = created.json()
    assert rule["agentId"] == agent["id"]
    assert rule["executionEnvironment"] == "cloud"
    assert rule["nextRunAt"] is not None
    assert rule["nextRunAt"].endswith("Z")

    started = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/run",
        headers=_auth(test_token),
    )
    assert started.status_code == 200, started.text
    run = started.json()
    assert run["status"] == "running"
    assert run["taskId"]
    assert run["timezone"] == "Asia/Shanghai"
    assert run["scheduledFor"].endswith("Z")

    task = test_client.get(
        f"/api/v1/loop-items/{run['taskId']}", headers=_auth(test_token)
    )
    assert task.status_code == 200
    assert task.json()["assignee_agent_id"] == agent["id"]
    assert task.json()["automation"]["run_id"] == run["id"]
    assert task.json()["description"] == "Summarize yesterday's completed work."
    assert task.json()["tags"] == ["automation"]


def test_cloud_project_manual_automation_starts_when_local_device_claims(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="automation-local-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "local"},
                "metadata": {"name": "automation-local-device"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "autolocal", "name": "Local automation"},
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Local bug fixer",
            "runtime": "codex",
            "executionEnvironment": "local",
            "executionDeviceId": "automation-local-device",
        },
    ).json()
    rule = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Local scan",
            "prompt": "Scan bugs.",
            "cronExpression": "0 3 * * *",
            "timezone": "Asia/Shanghai",
            "agentId": agent["id"],
            "enabled": True,
        },
    ).json()

    started = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/run",
        headers=_auth(test_token),
    )
    assert started.status_code == 200, started.text
    run = started.json()
    assert run["status"] == "waiting_device"
    assert run["taskId"] is None
    assert run["expiresAt"] is None

    claimed = test_client.post(
        "/api/v1/loop-item-executions/claim-my-next",
        headers=_auth(test_token),
        json={
            "executionDeviceId": "automation-local-device",
            "deviceCapacity": 1,
            "leaseSeconds": 300,
        },
    )
    assert claimed.status_code == 200, claimed.text
    execution = claimed.json()
    assert execution["executionDeviceId"] == "automation-local-device"
    assert execution["status"] == "running"

    started_runtime = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/executions/{execution['id']}/runtime-start",
        headers=_auth(test_token),
        json={
            "runtime_device_id": "automation-local-device",
            "runtime_task_id": execution["runtimeTaskId"],
            "prompt": "Scan bugs.",
        },
    )
    assert started_runtime.status_code == 200, started_runtime.text

    runs = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/runs",
        headers=_auth(test_token),
    )
    assert runs.status_code == 200, runs.text
    activated = runs.json()[0]
    assert activated["status"] == "running"
    assert activated["taskId"]


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

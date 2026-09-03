# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for cloud projects, TODOs, and local task associations."""

import base64
import hashlib
import hmac
import io
import json
from contextlib import contextmanager
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
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.project import Project
from app.models.user import User
from app.services.auth import create_task_token
from app.services.cloud_files import cloud_file_service
from app.services.delivery import delivery_service
from app.services.loop_items.external_provider import external_loop_item_provider


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


def _create_runnable_wegent_team(
    db: Session,
    *,
    user_id: int,
    prefix: str,
) -> Kind:
    model_name = f"{prefix}-model"
    shell_name = f"{prefix}-shell"
    ghost_name = f"{prefix}-ghost"
    bot_name = f"{prefix}-bot"
    team_name = f"{prefix}-team"
    resources = [
        Kind(
            kind="Model",
            name=model_name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Model",
                "metadata": {"name": model_name, "namespace": "default"},
                "spec": {
                    "modelConfig": {
                        "env": {
                            "api_key": "test-key",
                            "base_url": "https://models.invalid/v1",
                            "model_id": "test-model",
                            "model": "openai",
                        }
                    },
                    "protocol": "openai",
                },
            },
        ),
        Kind(
            kind="Shell",
            name=shell_name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Shell",
                "metadata": {"name": shell_name, "namespace": "default"},
                "spec": {"shellType": "Chat"},
            },
        ),
        Kind(
            kind="Ghost",
            name=ghost_name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Ghost",
                "metadata": {"name": ghost_name, "namespace": "default"},
                "spec": {"systemPrompt": "Handle the board automation."},
            },
        ),
        Kind(
            kind="Bot",
            name=bot_name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {"name": bot_name, "namespace": "default"},
                "spec": {
                    "ghostRef": {"name": ghost_name, "namespace": "default"},
                    "shellRef": {"name": shell_name, "namespace": "default"},
                    "modelRef": {"name": model_name, "namespace": "default"},
                },
            },
        ),
        Kind(
            kind="Team",
            name=team_name,
            namespace="default",
            user_id=user_id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {"name": team_name, "namespace": "default"},
                "spec": {
                    "members": [
                        {
                            "botRef": {
                                "name": bot_name,
                                "namespace": "default",
                            }
                        }
                    ],
                    "collaborationModel": "solo",
                },
            },
        ),
    ]
    db.add_all(resources)
    db.commit()
    team = resources[-1]
    db.refresh(team)
    return team


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


def test_cloud_project_pull_request_automation_is_shared_through_project_metadata(
    test_client: TestClient, test_token: str
) -> None:
    created = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "prfix", "name": "PR auto repair"},
    ).json()
    assert created["pull_request_automation"]["enabled"] is False
    assert "merge_queue_failed" in created["pull_request_automation"]["statuses"]

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{created['id']}",
        headers=_auth(test_token),
        json={
            "version": created["version"],
            "pull_request_automation": {
                "enabled": True,
                "statuses": ["checks_failed", "merge_queue_timed_out"],
                "prompt": "Inspect the complete failure logs.",
            },
        },
    )
    assert updated.status_code == 200
    assert updated.json()["pull_request_automation"] == {
        "enabled": True,
        "statuses": ["checks_failed", "merge_queue_timed_out"],
        "prompt": "Inspect the complete failure logs.",
    }


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


def test_archiving_cloud_project_deletes_all_automation_rules(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "cleanup", "name": "Automation cleanup"},
    ).json()
    scheduled_rule = ProjectAutomationRule(
        cloud_project_id=project["id"],
        title="Scheduled rule",
        status="enabled",
        due_at=datetime(2020, 1, 1),
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "schedule",
            "cron_expression": "0 3 * * *",
            "timezone": "UTC",
        },
    )
    event_rule = ProjectAutomationRule(
        cloud_project_id=project["id"],
        title="Event rule",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    test_db.add_all([scheduled_rule, event_rule])
    test_db.commit()
    rule_ids = [scheduled_rule.id, event_rule.id]

    archived = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}",
        params={"version": project["version"]},
        headers=_auth(test_token),
    )

    assert archived.status_code == 204, archived.text
    test_db.expire_all()
    stored_project = test_db.get(CloudProject, project["id"])
    assert stored_project is not None
    assert stored_project.status == "archived"
    stored_rules = (
        test_db.query(ProjectAutomationRule)
        .filter(ProjectAutomationRule.id.in_(rule_ids))
        .all()
    )
    assert len(stored_rules) == 2
    for rule in stored_rules:
        assert rule.status == "disabled"
        assert rule.deleted_at is not None
        assert loop_datetime_value_is_unset(rule.due_at)
        assert rule.updated_by_user_id == test_user.id
        assert rule.version == 2


def test_archiving_cloud_project_rejects_active_automation_run(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "running", "name": "Running automation"},
    ).json()
    rule = ProjectAutomationRule(
        cloud_project_id=project["id"],
        title="Active rule",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"trigger_type": "schedule", "timezone": "UTC"},
    )
    test_db.add(rule)
    test_db.flush()
    test_db.add(
        ProjectAutomationRun(
            cloud_project_id=project["id"],
            parent_id=rule.id,
            title="Active run",
            status="running",
            created_by_user_id=test_user.id,
        )
    )
    test_db.commit()

    archived = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}",
        params={"version": project["version"]},
        headers=_auth(test_token),
    )

    assert archived.status_code == 409
    assert "Stop active automation runs" in archived.json()["detail"]
    test_db.expire_all()
    assert test_db.get(CloudProject, project["id"]).status == "active"


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
    provider_params: list[object] = []

    def provider_request(
        method: str, url: str, **kwargs: object
    ) -> FakeProviderResponse:
        requests.append((method, url, kwargs.get("json")))
        provider_params.append(kwargs.get("params"))
        if method == "GET" and url.endswith("/issues"):
            return FakeProviderResponse([created_issue])
        if method == "PATCH" and isinstance(kwargs.get("json"), dict):
            created_issue.update(kwargs["json"])
        return FakeProviderResponse(created_issue)

    monkeypatch.setattr(
        external_loop_item_provider._http_client, "request", provider_request
    )
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
    paged = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/loop-item-pages",
        headers=_auth(test_token),
        params={"status": "in_progress", "limit": 25},
    )
    created = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Backend issue", "status": "in_progress", "tags": ["bug"]},
    )
    archived = test_client.delete(
        "/api/v1/loop-items/CLOUDGH-7",
        headers=_auth(test_token),
    )

    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == "CLOUDGH-7"
    assert paged.status_code == 200
    assert paged.json()["items"][0]["description"] == ""
    assert paged.json()["items"][0]["detail_loaded"] is False
    assert any(
        isinstance(params, dict)
        and params.get("state") == "open"
        and params.get("labels") == "wegent:status:in_progress"
        for params in provider_params
    )
    assert created.status_code == 201
    assert archived.status_code == 204
    assert any(payload == {"state": "closed"} for _, _, payload in requests)
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

    monkeypatch.setattr(
        external_loop_item_provider._http_client, "request", provider_request
    )
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
    assert by_id["PUBLICGH-2"]["description"] == ""
    assert by_id["PUBLICGH-2"]["detail_loaded"] is False
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
    assert visible.json()["description"] == "visitor details"
    assert visible.json()["detail_loaded"] is True


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

    monkeypatch.setattr(
        external_loop_item_provider._http_client, "request", provider_request
    )
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
            "systemPrompt": "Verify before reporting completion.",
            "capabilityDescription": "Reviews backend changes and test evidence.",
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
    assert agent["capabilityDescription"] == (
        "Reviews backend changes and test evidence."
    )

    reassigned = test_client.patch(
        f"/api/v1/loop-items/{item.json()['id']}",
        headers=_auth(test_token),
        json={"version": item.json()["version"], "assignee_user_id": test_user.id},
    )
    assert reassigned.status_code == 200
    assert reassigned.json()["assignee_user_id"] == test_user.id
    assert reassigned.json()["assignee_agent_id"] is None


def test_cloud_project_robot_binds_default_runtime_profile(
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
    first_profile = test_client.post(
        "/api/v1/runtime-profiles",
        headers=_auth(test_token),
        json={
            "name": "Local Runtime 1",
            "executionEnvironment": "local",
            "executionDeviceId": "api-local-dev-1",
            "model": "model-1",
            "workspacePolicy": "project",
        },
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Bound Reviewer",
            "runtime": "codex",
            "defaultRuntimeProfileId": first_profile["id"],
        },
    )
    assert agent.status_code == 201
    body = agent.json()
    assert body["defaultRuntimeProfileId"] == first_profile["id"]
    assert body["localProjectId"] is None

    second_profile = test_client.post(
        "/api/v1/runtime-profiles",
        headers=_auth(test_token),
        json={
            "name": "Local Runtime 2",
            "executionEnvironment": "local",
            "executionDeviceId": "api-local-dev-1",
            "model": "model-2",
            "workspacePolicy": "git_worktree",
        },
    ).json()
    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents/{body['id']}",
        headers=_auth(test_token),
        json={
            "version": body["version"],
            "defaultRuntimeProfileId": second_profile["id"],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["defaultRuntimeProfileId"] == second_profile["id"]

    cleared = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents/{body['id']}",
        headers=_auth(test_token),
        json={"version": updated.json()["version"], "defaultRuntimeProfileId": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["defaultRuntimeProfileId"] is None


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
    stored_rule = test_db.get(ProjectAutomationRule, rule["id"])
    assert stored_rule is not None
    stored_metadata = dict(stored_rule.metadata_json)
    stored_credential = stored_metadata["webhook_secret_encrypted"]
    assert stored_credential["algorithm"] == "aes-256-gcm"
    assert "nonce" in stored_credential

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

    tampered_credential = dict(stored_credential)
    ciphertext = bytearray(base64.b64decode(tampered_credential["ciphertext"]))
    ciphertext[0] ^= 0x01
    tampered_credential["ciphertext"] = base64.b64encode(ciphertext).decode()
    stored_metadata["webhook_secret_encrypted"] = tampered_credential
    stored_rule.metadata_json = stored_metadata
    test_db.commit()
    tampered_response = test_client.post(
        f"/api/v1/cloud-projects/automation-events/{rule['webhookEventId']}",
        content=body,
        headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature},
    )
    assert tampered_response.status_code == 401

    manual_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/run",
        headers=_auth(test_token),
    )
    assert manual_response.status_code == 200, manual_response.text
    assert manual_response.json()["trigger"] == "manual"
    assert manual_response.json()["automationId"] == rule["id"]


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

    captured: dict[str, object] = {}

    async def fake_process(
        db: Session, event: object, *, automation_id: str | None = None
    ) -> int:
        captured["event"] = event
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
            "object_attributes": {
                "action": "open",
                "iid": 7,
                "title": "Bug",
                "state": "opened",
                "labels": [
                    {"title": "backend"},
                    {"title": "wegent:status:in_progress"},
                    {"title": "wegent:priority:high"},
                ],
            },
        },
    )

    assert response.status_code == 202, response.text
    assert response.json() == {"status": "accepted", "dispatched": 1}
    event = captured["event"]
    assert getattr(event, "payload")["status"] == "in_progress"
    assert getattr(event, "payload")["priority"] == "high"
    assert getattr(event, "payload")["tags"] == ["backend"]


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
    runtime_profile = test_client.post(
        "/api/v1/runtime-profiles",
        headers=_auth(test_token),
        json={
            "name": "Automation cloud Runtime",
            "executionEnvironment": "cloud",
            "executionDeviceId": "automation-cloud-device",
            "model": "test-model",
            "workspacePolicy": "project",
        },
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Project assistant",
            "runtime": "codex",
            "defaultRuntimeProfileId": runtime_profile["id"],
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
    assert rule["runtimeSource"] == "agent_default"
    assert rule["runtimeProfileId"] is None
    assert rule["nextRunAt"] is not None
    assert rule["nextRunAt"].endswith("Z")

    started = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/run",
        headers=_auth(test_token),
    )
    assert started.status_code == 200, started.text
    run = started.json()
    assert run["status"] == "queued"
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


def test_cloud_project_automation_supports_managed_executor_sources(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="desktop-a",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {"deviceType": "local"},
                "metadata": {"name": "desktop-a"},
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "managed", "name": "Managed automation"},
    ).json()
    runtime_profile = test_client.post(
        "/api/v1/runtime-profiles",
        headers=_auth(test_token),
        json={
            "name": "Managed Runtime",
            "executionEnvironment": "local",
            "executionDeviceId": "desktop-a",
            "model": "model-a",
            "workspacePolicy": "project",
        },
    ).json()

    custom = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Custom AI",
            "prompt": "Read the project and handle the event.",
            "assignmentMode": "ai_managed",
            "managerType": "custom",
            "runtimeSource": "fixed_profile",
            "runtimeProfileId": runtime_profile["id"],
            "cronExpression": "0 3 * * *",
        },
    )
    assert custom.status_code == 201, custom.text
    assert custom.json()["assignmentMode"] == "ai_managed"
    assert custom.json()["managerType"] == "custom"
    assert custom.json()["runtimeSource"] == "fixed_profile"
    assert custom.json()["runtimeProfileId"] == runtime_profile["id"]
    assert custom.json()["agentId"] is None

    team = _create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        prefix="managed-automation",
    )
    wegent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Reusable robot",
            "prompt": "Read the project and handle the event.",
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "wegentTeamId": team.id,
            "cronExpression": "0 4 * * *",
        },
    )
    assert wegent.status_code == 201, wegent.text
    assert wegent.json()["assignmentMode"] == "ai_managed"
    assert wegent.json()["managerType"] == "wegent"
    assert wegent.json()["wegentTeamId"] == team.id
    assert wegent.json()["agentId"] is None

    team_model = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Model",
            Kind.name == "managed-automation-model",
        )
        .one()
    )
    team_model.is_active = False
    test_db.commit()
    missing_model = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Broken reusable robot",
            "prompt": "This request must be rejected before dispatch.",
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "wegentTeamId": team.id,
            "cronExpression": "0 4 * * *",
        },
    )
    missing_model_update = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/automations/{custom.json()['id']}",
        headers=_auth(test_token),
        json={
            "version": custom.json()["version"],
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "wegentTeamId": team.id,
        },
    )
    assert missing_model.status_code == 422, missing_model.text
    assert "model is unavailable" in missing_model.json()["detail"]
    assert missing_model_update.status_code == 422, missing_model_update.text
    team_model.is_active = True
    test_db.commit()

    inactive_team = Kind(
        kind="Team",
        name="inactive-agent",
        namespace="default",
        user_id=test_user.id,
        is_active=False,
        json={"spec": {"name": "inactive-agent"}},
    )
    test_db.add(inactive_team)
    test_db.commit()
    test_db.refresh(inactive_team)
    inaccessible = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Inactive robot",
            "prompt": "This request must be rejected.",
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "wegentTeamId": inactive_team.id,
            "cronExpression": "0 5 * * *",
        },
    )
    assert inaccessible.status_code == 422, inaccessible.text

    removed_contract = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automations",
        headers=_auth(test_token),
        json={
            "name": "Legacy executor fields",
            "prompt": "This request must be rejected.",
            "assignmentMode": "ai_managed",
            "managerType": "wegent",
            "wegentTeamName": team.name,
            "wegentTeamNamespace": team.namespace,
            "cronExpression": "0 5 * * *",
        },
    )
    assert removed_contract.status_code == 422, removed_contract.text


def test_cloud_project_manual_automation_waits_for_runtime_truth_after_local_claim(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_db.add(
        Kind(
            kind="Device",
            name="automation-local-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": "local",
                    "runtimeInstanceId": "runtime-automation-local",
                },
                "metadata": {"name": "automation-local-device"},
            },
        )
    )
    test_db.add(
        Kind(
            kind="Device",
            name="automation-runtime-device",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            json={
                "spec": {
                    "deviceType": "local",
                    "runtimeInstanceId": "runtime-automation-local",
                },
                "metadata": {"name": "automation-runtime-device"},
            },
        )
    )
    test_db.add(
        Kind(
            kind="Model",
            name="test-model",
            namespace="default",
            user_id=0,
            is_active=True,
            json={
                "spec": {
                    "modelConfig": {
                        "env": {
                            "model": "claude",
                            "model_id": "test-model",
                            "api_key": "test-key",
                            "base_url": "https://runtime.example.com",
                        }
                    }
                }
            },
        )
    )
    test_db.commit()
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "autolocal", "name": "Local automation"},
    ).json()
    runtime_profile = test_client.post(
        "/api/v1/runtime-profiles",
        headers=_auth(test_token),
        json={
            "name": "Local automation Runtime",
            "executionEnvironment": "local",
            "executionDeviceId": "automation-local-device",
            "model": "test-model",
            "workspacePolicy": "project",
        },
    ).json()
    agent = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={
            "name": "Local bug fixer",
            "runtime": "codex",
            "defaultRuntimeProfileId": runtime_profile["id"],
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
    assert run["status"] == "queued"
    assert run["taskId"]
    assert run["expiresAt"] is None
    queued_execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == run["id"])
        .one()
    )
    assert queued_execution.status == "queued"
    assert queued_execution.execution_device_id == "automation-local-device"
    assert queued_execution.execution_environment == "local"
    assert queued_execution.executor_owner_user_id == test_user.id

    from app.services.device.capacity import RuntimeCapacity
    from app.services.loop_item_executions.device_pull import (
        acknowledge_execution,
        pull_execution,
    )

    monkeypatch.setattr(
        "app.services.loop_item_executions.device_pull."
        "validate_runtime_capacity_observation_sync",
        lambda *_args, **_kwargs: RuntimeCapacity(
            runtime_instance_id="runtime-automation-local",
            limit=1,
            active=0,
            active_task_ids=frozenset(),
            queued=0,
        ),
    )
    monkeypatch.setattr(
        "app.services.loop_item_executions.service._runtime_capacity_used",
        lambda *_args, **_kwargs: 0,
    )

    @contextmanager
    def test_db_session():
        yield test_db

    monkeypatch.setattr(
        "app.services.loop_item_executions.device_pull.get_db_session",
        test_db_session,
    )

    pulled = pull_execution(
        owner_user_id=test_user.id,
        execution_target_id="automation-local-device",
        runtime_device_id="automation-runtime-device",
        runtime_instance_id="runtime-automation-local",
        environment="local",
        runtime_capacity={
            "limit": 1,
            "active": 0,
            "active_task_ids": [],
            "queued": 0,
        },
    )
    assert pulled["success"], pulled
    task = pulled["task"]
    assert task is not None
    assert task["payload"]["message"]
    assert task["payload"]["executionRequest"]["model_config"]
    assert task["payload"]["modelId"] == "test-model"

    accepted = acknowledge_execution(
        owner_user_id=test_user.id,
        runtime_device_id="automation-runtime-device",
        runtime_instance_id="runtime-automation-local",
        execution_id=task["execution_id"],
        runtime_task_id=task["runtime_task_id"],
        accepted=True,
        prompt="Scan bugs.",
        error=None,
    )
    assert accepted == {"success": True}

    runs = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/automations/{rule['id']}/runs",
        headers=_auth(test_token),
    )
    assert runs.status_code == 200, runs.text
    activated = runs.json()[0]
    assert activated["status"] == "queued"
    assert activated["taskId"]


def test_ai_manager_assignment_endpoint_applies_tool_selected_member(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    project = test_client.post(
        "/api/v1/cloud-projects",
        headers=_auth(test_token),
        json={"project_key": "managedassign", "name": "Managed assignment"},
    ).json()
    task = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Choose an owner"},
    ).json()
    rule = ProjectAutomationRule(
        id="api-manager-rule",
        cloud_project_id=project["id"],
        title="AI manager",
        description="Match the task to project capabilities.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "action": "ai_assign",
            "role": {"source": "generic", "agent_id": None},
            "runtime": {
                "source": "issue_creator",
                "runtime_profile_id": None,
                "user_id": None,
            },
            "manager": {"type": "custom", "wegent_team_id": None},
        },
    )
    run = ProjectAutomationRun(
        id="api-manager-run",
        cloud_project_id=project["id"],
        parent_id=rule.id,
        task_id=task["id"],
        title="AI manager run",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"trigger": "task_created"},
    )
    test_db.add_all([rule, run])
    test_db.commit()
    task_token = create_task_token(
        task_id=0,
        subtask_id=0,
        user_id=test_user.id,
        user_name=test_user.user_name,
    )

    assigned = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/automation-runs/{run.id}/assign",
        headers=_auth(task_token),
        json={"assigneeType": "user", "assigneeId": str(test_user.id)},
    )

    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["assignee_user_id"] == test_user.id
    stored = test_db.get(LoopItem, task["id"])
    assert stored is not None
    assert stored.assignee_user_id == test_user.id
    assert stored.assignee_agent_id == ""


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
        json={
            "user_id": member_user.id,
            "role": "Developer",
            "capability_description": "Frontend implementation",
        },
    )
    assert added.status_code == 201
    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/members/{member_user.id}",
        headers=_auth(test_token),
        json={
            "role": "Reporter",
            "capability_description": "Product acceptance and release checks",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["role"] == "Reporter"
    assert updated.json()["capability_description"] == (
        "Product acceptance and release checks"
    )
    owner_updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}/members/{test_user.id}",
        headers=_auth(test_token),
        json={"capability_description": "Owns product scope and priorities"},
    )
    assert owner_updated.status_code == 200
    assert owner_updated.json()["role"] == "Owner"
    members = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(test_token),
    )
    assert members.status_code == 200
    members = members.json()
    assert {member["user_id"] for member in members} == {test_user.id, member_user.id}
    assert {
        member["user_id"]: member["capability_description"] for member in members
    } == {
        test_user.id: "Owns product scope and priorities",
        member_user.id: "Product acceptance and release checks",
    }

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
    read_content = test_client.get(
        f"/api/v1/cloud-projects/files/{file_id}/content",
        headers=_auth(test_token),
    )
    assert read_content.status_code == 200
    assert read_content.content == b"# Notes"
    assert read_content.headers["content-type"].startswith("text/markdown")

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
        json={"title": "Release issue"},
    ).json()
    root_item = test_db.get(LoopItem, item["id"])
    assert root_item is not None
    root_item.parent_id = ""
    test_db.commit()
    task = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "Publish report", "parent_id": item["id"]},
    ).json()
    delivered_at = datetime(2026, 7, 22, 12, 0, 0)
    delivery = Delivery(
        id="delivery-snapshot",
        loop_item_id=task["id"],
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
            "loop_item_id": task["id"],
            "loop_item_title": "Publish report",
            "relative_path": "reports/report.pdf",
            "display_name": "report.pdf",
            "content_type": "application/pdf",
            "size_bytes": 6,
            "delivered_at": "2026-07-22T12:00:00",
            "loop_item_path": [
                {"id": item["id"], "title": "Release issue"},
                {"id": task["id"], "title": "Publish report"},
            ],
        }
    ]
    assert accessed.status_code == 200
    assert accessed.json()["url"].endswith("/snapshot/files/report.pdf")
    read_content = test_client.get(
        f"/api/v1/delivery-assets/{asset.id}/content",
        headers=_auth(test_token),
    )
    assert read_content.status_code == 200
    assert read_content.content == b"report"
    assert read_content.headers["content-type"] == "application/pdf"

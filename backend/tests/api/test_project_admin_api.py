# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Page and tool transports share project configuration transactions."""

import json
from contextlib import nullcontext
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_project_admin, wework_space, wework_space_batch
from app.models.delivery import CloudProject
from app.models.resource_member import ResourceMember
from app.models.user import User


def _create(client: TestClient, token: str) -> tuple[dict, dict]:
    headers = {"Authorization": f"Bearer {token}"}
    response = client.post(
        "/api/v1/cloud-projects",
        headers=headers,
        json={"name": "Administration parity", "project_key": "PARITY"},
    )
    assert response.status_code == 201
    return response.json(), headers


def test_page_and_mcp_replay_the_same_operation(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch,
) -> None:
    project, headers = _create(test_client, test_token)
    project_id = project["id"]
    monkeypatch.setattr(
        wework_project_admin, "SessionLocal", lambda: nullcontext(test_db)
    )
    request = {
        "version": project["version"],
        "operation_id": "shared-operation",
        "tags": ["review"],
    }
    page = test_client.patch(
        f"/api/v1/cloud-projects/{project_id}", headers=headers, json=request
    )
    assert page.status_code == 200
    result = page.json()["project_admin_result"]
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    replay = wework_project_admin.update_project_tags(token, request, project_id)
    assert replay == result
    read = test_client.get(f"/api/v1/projects/{project_id}", headers=headers)
    assert read.status_code == 200
    assert read.json()["project_admin_config"]["configuration"]["tags"] == ["review"]
    assert (
        read.json()["project_admin_config"]["projectVersion"]
        == result["projectVersion"]
    )
    stored = test_db.get(CloudProject, project_id)
    assert len(stored.metadata_json["project_admin_operations"]) == 1
    schema = read.json()["project_admin_capabilities"]["updateSpaceInputSchema"]
    model_name = schema["properties"]["project"]["$ref"].split("/")[-1]
    project_schema = schema["$defs"][model_name]
    assert project_schema["additionalProperties"] is False
    assert "board_views" in project_schema["properties"]
    assert "provider_config" not in project_schema["properties"]


@pytest.mark.parametrize("tags", ["design", {"name": "design"}])
def test_malformed_tag_patch_preserves_saved_configuration(
    test_client: TestClient, test_db: Session, test_token: str, tags: object
) -> None:
    project, headers = _create(test_client, test_token)
    saved = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=headers,
        json={"version": project["version"], "tags": ["design"]},
    )
    assert saved.status_code == 200
    project = saved.json()
    stored = test_db.get(CloudProject, project["id"])
    before = deepcopy(stored.metadata_json)

    result = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=headers,
        json={"version": project["version"], "tags": tags},
    )

    assert result.status_code == 422
    assert result.json()["reason_code"] == "invalid_config"
    test_db.refresh(stored)
    assert stored.metadata_json == before
    assert stored.version == project["version"]


def test_page_configuration_writes_remain_enabled_during_mcp_rollback(
    test_client: TestClient, test_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "WEWORK_PROJECT_ADMIN_TOOLS_V1", False)
    project, headers = _create(test_client, test_token)

    updated = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=headers,
        json={
            "version": project["version"],
            "collaboration_policy": {"content": "Page configuration stays writable"},
        },
    )

    assert updated.status_code == 200, updated.text
    policy = updated.json()["project_admin_result"]["after"]["collaboration_policy"]
    assert policy["content"] == "Page configuration stays writable"


@pytest.mark.parametrize("first_transport", ["page", "generic", "dedicated"])
def test_intervening_write_does_not_change_replayed_public_write_response(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    first_transport: str,
) -> None:
    project, headers = _create(test_client, test_token)
    project_id = project["id"]
    path = f"/api/v1/cloud-projects/{project_id}"
    for module in (wework_project_admin, wework_space):
        monkeypatch.setattr(module, "SessionLocal", lambda: nullcontext(test_db))
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    request = {
        "version": project["version"],
        "operation_id": "first-response",
        "tags": ["first"],
    }
    if first_transport == "generic":
        first = wework_space.update_space(token, request, project_id)
        assert "error" not in first
    elif first_transport == "dedicated":
        first = wework_project_admin.update_project_tags(token, request, project_id)
        assert "error" not in first
    else:
        first = test_client.patch(path, headers=headers, json=request)
        assert first.status_code == 200, first.text
    original_page = test_client.patch(path, headers=headers, json=request).json()
    original_generic = wework_space.update_space(token, request, project_id)
    original_receipt = deepcopy(original_page["project_admin_result"])

    second = test_client.patch(
        path,
        headers=headers,
        json={
            "version": original_page["version"],
            "operation_id": "second-response",
            "name": "Second configuration",
            "tags": ["second"],
            "collaboration_policy": {"content": "Second policy"},
        },
    )
    assert second.status_code == 200, second.text
    page_replay = test_client.patch(path, headers=headers, json=request)
    generic_replay = wework_space.update_space(token, request, project_id)
    dedicated_replay = wework_project_admin.update_project_tags(
        token, request, project_id
    )

    assert page_replay.status_code == 200, page_replay.text
    assert page_replay.json() == original_page
    assert generic_replay == original_generic
    assert dedicated_replay == original_receipt
    assert "metadata_json" not in page_replay.json()
    assert "project_admin_operations" not in json.dumps(page_replay.json())
    current = test_client.get(f"/api/v1/projects/{project_id}", headers=headers).json()
    assert current["name"] == "Second configuration"
    assert current["tags"] == ["second"]
    assert current["version"] == second.json()["version"]
    stored = test_db.get(CloudProject, project_id)
    assert len(stored.metadata_json["project_admin_operations"]) == 2


def test_replay_uses_current_permissions_and_execution_configuration(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project, owner_headers = _create(test_client, test_token)
    project_id = project["id"]
    path = f"/api/v1/cloud-projects/{project_id}"
    actor = User(
        user_name="replaying-maintainer", password_hash="unused", is_active=True
    )
    test_db.add(actor)
    test_db.flush()
    workspace_grant = ResourceMember.create(
        resource_type="Workspace",
        resource_id=int(project["workspace_id"]),
        entity_id=str(actor.id),
        role="Maintainer",
        status="approved",
    )
    test_db.add_all(
        [
            workspace_grant,
            ResourceMember.create(
                resource_type="CloudProject",
                resource_id=int(project_id),
                entity_id=str(actor.id),
                role="Maintainer",
                status="approved",
            ),
        ]
    )
    stored = test_db.get(CloudProject, project_id)
    metadata = deepcopy(stored.metadata_json)
    metadata["workflow_definition"] = {
        "execution_config": {"system_prompt": "OLD_PRIVATE_PROMPT"}
    }
    metadata["execution_environment"] = {
        "setup_steps": [{"command": "OLD_PRIVATE_SETUP"}]
    }
    stored.metadata_json = metadata
    test_db.commit()
    headers = {
        "Authorization": f"Bearer {create_access_token(data={'sub': actor.user_name})}"
    }
    token = MCPAuthInfo(user_id=actor.id, user_name=actor.user_name, auth_type="user")
    for module in (wework_project_admin, wework_space):
        monkeypatch.setattr(module, "SessionLocal", lambda: nullcontext(test_db))
    request = {
        "version": project["version"],
        "operation_id": "authorized-first-result",
        "tags": ["first"],
    }
    first = test_client.patch(path, headers=headers, json=request)
    assert first.status_code == 200, first.text
    original = first.json()
    second = test_client.patch(
        path,
        headers=owner_headers,
        json={
            "version": original["version"],
            "operation_id": "permissions-and-private-execution",
            "tags": ["second"],
            "workflow_definition": {
                "execution_config": {"system_prompt": "CURRENT_PRIVATE_PROMPT"}
            },
            "execution_environment": {
                "setup_steps": [{"command": "CURRENT_PRIVATE_SETUP"}]
            },
            "member_changes": [{"operation": "remove_direct", "user_id": actor.id}],
        },
    )
    assert second.status_code == 200, second.text

    replay = test_client.patch(path, headers=headers, json=request)

    assert replay.status_code == 200, replay.text
    assert replay.json()["tags"] == ["first"]
    assert replay.json()["version"] == original["version"]
    assert replay.json()["project_admin_result"] == original["project_admin_result"]
    assert replay.json()["permission_sources"] != original["permission_sources"]
    assert all(
        source["type"] != "direct" for source in replay.json()["permission_sources"]
    )
    execution = replay.json()["workflow_definition"]["execution_config"]
    assert execution["system_prompt"] == "CURRENT_PRIVATE_PROMPT"
    assert replay.json()["execution_environment"]["setup_steps"][0]["command"] == (
        "CURRENT_PRIVATE_SETUP"
    )
    test_db.refresh(stored)
    journal = stored.metadata_json["project_admin_operations"]
    assert "OLD_PRIVATE_PROMPT" not in json.dumps(journal)
    assert "CURRENT_PRIVATE_PROMPT" not in json.dumps(journal)
    assert "OLD_PRIVATE_SETUP" not in json.dumps(journal)
    assert "CURRENT_PRIVATE_SETUP" not in json.dumps(journal)
    snapshot = journal[request["operation_id"]]["response"]
    authorization_fields = {"access_role", "permission_sources", "workspace_context"}
    private_fields = {
        "provider_config",
        "execution_environment",
        "workflow_definition",
        "project_admin_operations",
    }
    assert authorization_fields.isdisjoint(snapshot)
    assert private_fields.isdisjoint(snapshot["metadata_json"])
    assert len(journal) == 2

    workspace_grant.role = "Viewer"
    test_db.commit()
    forbidden = test_client.patch(path, headers=headers, json=request)
    generic = wework_space.update_space(token, request, project_id)
    dedicated = wework_project_admin.update_project_tags(token, request, project_id)

    assert forbidden.status_code == 403, forbidden.text
    assert generic["error"]["reason_code"] == "permission_denied"
    assert dedicated["error"]["reason_code"] == "permission_denied"
    current = test_client.get(f"/api/v1/projects/{project_id}", headers=headers).json()
    assert current["tags"] == ["second"]
    assert current["version"] == second.json()["version"]
    test_db.refresh(stored)
    assert len(stored.metadata_json["project_admin_operations"]) == 2


def test_generic_tool_preview_refreshes_rolled_back_project_state(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project, _headers = _create(test_client, test_token)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: nullcontext(test_db))
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    preview = wework_space.update_space(
        token,
        {"version": project["version"], "tags": ["preview"], "dry_run": True},
        project["id"],
    )

    assert preview["name"] == project["name"]
    assert preview["version"] == project["version"]
    assert preview["tags"] == project["tags"]
    assert preview["project_admin_result"]["after"]["tags"] == ["preview"]
    assert preview["project_admin_result"]["auditId"] is None
    stored = test_db.get(CloudProject, project["id"])
    assert stored.tags == project["tags"]
    assert stored.version == project["version"]
    assert "project_admin_operations" not in stored.metadata_json


@pytest.mark.parametrize("operation", ["list", "create"])
def test_space_tools_load_expired_project_rows(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    project, _headers = _create(test_client, test_token)
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: nullcontext(test_db))
    service = wework_space.cloud_project_service
    method_name = "list_accessible" if operation == "list" else "create"
    original = getattr(service, method_name)

    def expired_result(*args, **kwargs):
        result = original(*args, **kwargs)
        for row in result if operation == "list" else [result]:
            test_db.expire(row)
        return result

    monkeypatch.setattr(service, method_name, expired_result)
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    if operation == "list":
        result = wework_space_batch.dispatch("list_spaces", token, {})
        assert result["items"][0]["id"] == project["id"]
        assert result["items"][0]["name"] == project["name"]
    else:
        result = wework_space.create_space(token, "Refreshed space", "REFRESHED")
        assert result["id"] != project["id"]
        assert result["name"] == "Refreshed space"
        assert result["version"] == 1


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        (["  "], []),
        ([123], ["123"]),
        ([" review ", "review", ""], ["review"]),
        (
            [f"tag-{index}" for index in range(20)] + [" tag-0 ", ""],
            [f"tag-{index}" for index in range(20)],
        ),
    ],
)
def test_project_tags_use_the_same_normalization_for_page_and_both_mcp_tools(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    tags: list,
    expected: list[str],
) -> None:
    project, headers = _create(test_client, test_token)
    for module in (wework_project_admin, wework_space):
        monkeypatch.setattr(module, "SessionLocal", lambda: nullcontext(test_db))
    request = {
        "version": project["version"],
        "operation_id": "normalize-tags",
        "tags": tags,
    }

    page = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}", headers=headers, json=request
    )
    assert page.status_code == 200, page.text
    receipt = page.json()["project_admin_result"]
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    dedicated = wework_project_admin.update_project_tags(token, request, project["id"])
    generic = wework_space.update_space(token, request, project["id"])

    assert dedicated == receipt
    assert generic["project_admin_result"] == receipt
    assert generic["tags"] == receipt["after"]["tags"] == expected
    stored = test_db.get(CloudProject, project["id"])
    assert stored.tags == expected
    assert len(stored.metadata_json["project_admin_operations"]) == 1


@pytest.mark.parametrize("tags", [["x" * 33], [f"tag-{index}" for index in range(21)]])
def test_project_tag_limits_are_rejected_by_page_and_both_mcp_tools(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    tags: list[str],
) -> None:
    project, headers = _create(test_client, test_token)
    for module in (wework_project_admin, wework_space):
        monkeypatch.setattr(module, "SessionLocal", lambda: nullcontext(test_db))
    request = {"version": project["version"], "tags": tags}

    page = test_client.patch(
        f"/api/v1/cloud-projects/{project['id']}", headers=headers, json=request
    )
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    dedicated = wework_project_admin.update_project_tags(token, request, project["id"])
    generic = wework_space.update_space(token, request, project["id"])

    assert page.status_code == 422, page.text
    assert (
        page.json()["reason_code"]
        == dedicated["error"]["reason_code"]
        == generic["error"]["reason_code"]
        == "invalid_config"
    )
    stored = test_db.get(CloudProject, project["id"])
    assert stored.tags == []
    assert stored.version == project["version"]
    assert "project_admin_operations" not in stored.metadata_json


def test_preview_and_validation_do_not_write_or_echo_input(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    project, headers = _create(test_client, test_token)
    path = f"/api/v1/cloud-projects/{project['id']}"
    preview = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "name": "Preview",
            "dry_run": True,
        },
    )
    assert preview.status_code == 200
    assert preview.json()["name"] == project["name"]
    assert preview.json()["project_admin_result"]["after"]["name"] == "Preview"
    assert preview.json()["project_admin_result"]["auditId"] is None
    invalid = test_client.patch(
        path,
        headers=headers,
        json={
            "version": project["version"],
            "unsupported": "private-input-sentinel",
        },
    )
    assert invalid.status_code == 422
    assert invalid.json()["reason_code"] == "unsupported_field"
    assert invalid.json()["fields"][0]["path"] == ["body", "unsupported"]
    assert "private-input-sentinel" not in json.dumps(invalid.json())
    stored = test_db.get(CloudProject, project["id"])
    assert stored.version == project["version"]
    assert "project_admin_operations" not in stored.metadata_json


def test_first_policy_update_advances_the_published_default_and_keeps_issue_snapshots(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project, headers = _create(test_client, test_token)
    project_path = f"/api/v1/cloud-projects/{project['id']}"
    read_path = f"/api/v1/projects/{project['id']}"
    initial = test_client.get(read_path, headers=headers).json()
    default_policy = {"content": "", "revision": 1}
    assert initial["collaboration_policy"] == default_policy
    assert (
        initial["project_admin_config"]["configuration"]["collaboration_policy"]
        == default_policy
    )
    assert (
        "collaboration_policy"
        not in test_db.get(CloudProject, project["id"]).metadata_json
    )
    old_issue_response = test_client.post(
        f"{project_path}/loop-items",
        headers=headers,
        json={"title": "Before explicit policy", "notify_assignee": False},
    )
    assert old_issue_response.status_code == 201, old_issue_response.text
    old_issue = old_issue_response.json()
    request = {
        "version": project["version"],
        "operation_id": "first-policy-update",
        "collaboration_policy": {"content": "Policy two"},
    }
    updated = test_client.patch(project_path, headers=headers, json=request)
    assert updated.status_code == 200, updated.text
    current = test_client.get(read_path, headers=headers).json()
    new_issue_response = test_client.post(
        f"{project_path}/loop-items",
        headers=headers,
        json={"title": "After explicit policy", "notify_assignee": False},
    )
    assert new_issue_response.status_code == 201, new_issue_response.text
    old_read = test_client.get(
        f"/api/v1/loop-items/{old_issue['id']}", headers=headers
    ).json()
    policy = current["project_admin_config"]["configuration"]["collaboration_policy"]

    assert policy == {"content": "Policy two", "revision": 2}, {
        "published_default": default_policy,
        "updated_policy": policy,
        "old_snapshot": old_issue["collaboration_policy_snapshot"],
        "new_snapshot": new_issue_response.json()["collaboration_policy_snapshot"],
    }
    assert current["collaboration_policy"] == policy
    assert (
        old_read["collaboration_policy_snapshot"]
        == old_issue["collaboration_policy_snapshot"]
    )
    assert new_issue_response.json()["collaboration_policy_snapshot"] == policy
    monkeypatch.setattr(
        wework_project_admin, "SessionLocal", lambda: nullcontext(test_db)
    )
    token = MCPAuthInfo(
        user_id=test_user.id, user_name=test_user.user_name, auth_type="user"
    )
    replay = wework_project_admin.update_project_strategy(token, request, project["id"])
    assert replay == updated.json()["project_admin_result"]
    stored = test_db.get(CloudProject, project["id"])
    assert stored.metadata_json["collaboration_policy"] == policy
    assert stored.version == updated.json()["version"]
    assert len(stored.metadata_json["project_admin_operations"]) == 1


def test_project_detail_accepts_existing_task_auth_without_granting_write(
    test_client: TestClient,
    test_token: str,
    test_task_token: str,
) -> None:
    project, _headers = _create(test_client, test_token)
    read = test_client.get(
        f"/api/v1/projects/{project['id']}",
        headers={"Authorization": f"Bearer {test_task_token}"},
    )
    assert read.status_code == 200
    assert read.json()["project_admin_config"]["projectVersion"] == project["version"]

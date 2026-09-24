# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused API contracts for Workspace resources and Issue capabilities."""

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.delivery import (
    LoopItem,
    LoopItemComment,
    ProjectAutomationRule,
    ProjectChatAgent,
)
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.models.wework_notification import WeworkNotification
from app.services.workspaces.execution_environments import (
    WorkspaceExecutionEnvironmentService,
)
from tests.utils.agent_resources import create_runnable_wegent_team


@pytest.fixture(autouse=True)
def device_online_infos(monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    infos: dict[str, object] = {}
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise",
        AsyncMock(
            side_effect=lambda keys: {key: infos[key] for key in keys if key in infos}
        ),
    )
    return infos


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_workspace_persists_shared_execution_environment_defaults(
    test_client: TestClient,
    test_token: str,
) -> None:
    created = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Environment Workspace {uuid.uuid4().hex[:6]}"},
    )
    assert created.status_code == 201
    workspace = created.json()

    updated = test_client.patch(
        f"/api/v1/workspaces/{workspace['id']}",
        headers=_auth(test_token),
        json={
            "version": workspace["version"],
            "execution_environment": {
                "repositories": [
                    {
                        "name": "Wegent",
                        "url": "https://github.com/wecode-ai/Wegent.git",
                        "ref": "main",
                        "path": "wegent",
                        "primary": True,
                    },
                    {
                        "name": "SDK",
                        "url": "https://github.com/example/sdk.git",
                        "ref": "v2",
                        "path": "deps/sdk",
                        "primary": False,
                    },
                ],
                "setup_steps": [
                    {"command": "corepack enable", "working_directory": "wegent"},
                    {"command": "pnpm install", "working_directory": "wegent"},
                ],
            },
        },
    )

    assert updated.status_code == 200
    environment = updated.json()["execution_environment"]
    assert environment == {
        "repositories": [
            {
                "name": "Wegent",
                "url": "https://github.com/wecode-ai/Wegent.git",
                "ref": "main",
                "path": "wegent",
                "primary": True,
            },
            {
                "name": "SDK",
                "url": "https://github.com/example/sdk.git",
                "ref": "v2",
                "path": "deps/sdk",
                "primary": False,
            },
        ],
        "setup_steps": [
            {"command": "corepack enable", "working_directory": "wegent"},
            {"command": "pnpm install", "working_directory": "wegent"},
        ],
        "fingerprint": environment["fingerprint"],
        "devices": {},
    }
    assert len(environment["fingerprint"]) == 64


def test_workspace_inherits_personal_or_group_resource_namespace(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    group_name = f"workspace-owner-{uuid.uuid4().hex[:8]}"
    group_response = test_client.post(
        "/api/groups",
        headers=_auth(test_token),
        json={
            "name": group_name,
            "display_name": "Workspace Owner Group",
            "visibility": "private",
        },
    )
    assert group_response.status_code == 201

    group_workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={
            "name": f"Group Workspace {uuid.uuid4().hex[:6]}",
            "namespace": group_name,
            "is_default": True,
        },
    )
    assert group_workspace_response.status_code == 201
    group_workspace = group_workspace_response.json()
    assert group_workspace["namespace"] == group_name
    assert group_workspace["is_default"] is False
    stored_workspace = test_db.get(Kind, int(group_workspace["id"]))
    assert stored_workspace is not None
    assert stored_workspace.namespace == group_name
    assert stored_workspace.json["metadata"]["namespace"] == group_name

    personal_workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Personal Workspace {uuid.uuid4().hex[:6]}"},
    )
    assert personal_workspace_response.status_code == 201
    assert personal_workspace_response.json()["namespace"] == "default"

    outsider, outsider_token = _user(
        test_db, f"workspace-outsider-{uuid.uuid4().hex[:8]}"
    )
    denied_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(outsider_token),
        json={
            "name": f"Denied Workspace {outsider.id}",
            "namespace": group_name,
        },
    )
    assert denied_response.status_code == 403


def test_workspace_execution_environment_initialize_preserves_namespace(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    group_name = f"environment-owner-{uuid.uuid4().hex[:8]}"
    group_response = test_client.post(
        "/api/groups",
        headers=_auth(test_token),
        json={
            "name": group_name,
            "display_name": "Environment Owner Group",
            "visibility": "private",
        },
    )
    assert group_response.status_code == 201
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={
            "name": f"Initialized Workspace {uuid.uuid4().hex[:6]}",
            "namespace": group_name,
        },
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    device = Kind(
        kind="Device",
        name=f"initialize-device-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {"deviceType": "local"}},
    )
    test_db.add(device)
    test_db.commit()
    test_db.refresh(device)
    binding_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/execution-environments",
        headers=_auth(test_token),
        json={"device_id": device.id},
    )
    assert binding_response.status_code == 201
    initialized_state = {
        "status": "ready",
        "workspace_path": "/workspace/initialized",
        "prepared_at": None,
        "error": "",
    }
    initialize = AsyncMock(return_value=initialized_state)
    monkeypatch.setattr(
        "app.services.workspaces.execution_environments.initialize_execution_environment",
        initialize,
    )

    initialize_response = test_client.post(
        (f"/api/v1/workspaces/{workspace['id']}" "/execution-environment/initialize"),
        headers=_auth(test_token),
        json={"device_id": device.id, "version": workspace["version"]},
    )

    assert initialize_response.status_code == 200
    initialized_workspace = initialize_response.json()
    assert initialized_workspace["namespace"] == group_name
    assert initialized_workspace["execution_environment"] == {
        "repositories": [],
        "setup_steps": [],
        "fingerprint": "",
        "devices": {device.name: initialized_state},
    }
    stored_workspace = test_db.get(Kind, int(workspace["id"]))
    assert stored_workspace is not None
    assert stored_workspace.namespace == group_name
    assert stored_workspace.json["metadata"]["namespace"] == group_name
    initialize.assert_awaited_once()


def test_workspace_can_be_archived_after_its_projects_are_archived(
    test_client: TestClient,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"归档测试空间 {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={"name": f"归档测试项目 {uuid.uuid4().hex[:6]}"},
    )
    assert project_response.status_code == 201
    project = project_response.json()

    blocked_response = test_client.delete(
        f"/api/v1/workspaces/{workspace['id']}?version={workspace['version']}",
        headers=_auth(test_token),
    )
    assert blocked_response.status_code == 409

    project_archive_response = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}?version={project['version']}",
        headers=_auth(test_token),
    )
    assert project_archive_response.status_code == 204

    workspace_archive_response = test_client.delete(
        f"/api/v1/workspaces/{workspace['id']}?version={workspace['version']}",
        headers=_auth(test_token),
    )
    assert workspace_archive_response.status_code == 204


def _assignment_comments(db: Session, issue_id: str) -> list[LoopItemComment]:
    return [
        comment
        for comment in (
            db.query(LoopItemComment)
            .filter(LoopItemComment.loop_item_id == issue_id)
            .order_by(LoopItemComment.created_at, LoopItemComment.id)
            .all()
        )
        if isinstance(comment.metadata_json, dict)
        and comment.metadata_json.get("event_type") == "assignment"
    ]


def _user(db: Session, name: str) -> tuple[User, str]:
    user = User(
        user_name=name,
        password_hash="unused",
        email=f"{name}@example.com",
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user, create_access_token(data={"sub": user.user_name})


def _workspace_project_with_maintainer(
    test_client: TestClient,
    test_db: Session,
    owner_token: str,
) -> tuple[dict[str, object], dict[str, object], User, str]:
    maintainer, maintainer_token = _user(
        test_db, f"agent-maintainer-{uuid.uuid4().hex[:8]}"
    )
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(owner_token),
        json={"name": f"Agent 分配空间 {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(owner_token),
        json={"name": f"Agent 分配项目 {uuid.uuid4().hex[:6]}"},
    )
    assert project_response.status_code == 201
    project = project_response.json()
    member_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(owner_token),
        json={"user_id": maintainer.id, "role": "Maintainer"},
    )
    assert member_response.status_code == 201
    return workspace, project, maintainer, maintainer_token


def _wegent_team(test_db: Session, owner: User) -> Kind:
    suffix = uuid.uuid4().hex[:8]
    ghost_name = f"assignment-ghost-{suffix}"
    shell_name = f"assignment-shell-{suffix}"
    model_name = f"assignment-model-{suffix}"
    bot_name = f"assignment-bot-{suffix}"
    team_name = f"assignment-team-{suffix}"
    ghost = Kind(
        kind="Ghost",
        name=ghost_name,
        namespace="default",
        user_id=owner.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": ghost_name, "namespace": "default"},
            "spec": {"systemPrompt": "Complete the assigned work."},
        },
    )
    shell = Kind(
        kind="Shell",
        name=shell_name,
        namespace="default",
        user_id=owner.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {"name": shell_name, "namespace": "default"},
            "spec": {"shellType": "Chat", "baseImage": "assignment:test"},
            "status": {"state": "Available"},
        },
    )
    model = Kind(
        kind="Model",
        name=model_name,
        namespace="default",
        user_id=owner.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": model_name, "namespace": "default"},
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "test",
                        "model_id": "assignment-model",
                        "api_key": "test-key",
                        "base_url": "https://gateway.example.test",
                    }
                }
            },
        },
    )
    test_db.add_all([ghost, shell, model])
    test_db.flush()
    bot = Kind(
        kind="Bot",
        name=bot_name,
        namespace="default",
        user_id=owner.id,
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
    )
    test_db.add(bot)
    test_db.flush()
    team = Kind(
        kind="Team",
        name=team_name,
        namespace="default",
        user_id=owner.id,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": team_name, "namespace": "default"},
            "spec": {
                "collaborationModel": "solo",
                "members": [
                    {
                        "botRef": {"name": bot_name, "namespace": "default"},
                        "role": "leader",
                    }
                ],
            },
            "status": {"state": "Available"},
        },
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def test_workspace_collaboration_group_supports_human_or_agent_leader(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"协作组空间 {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={"name": f"协作组项目 {uuid.uuid4().hex[:6]}"},
    )
    assert project_response.status_code == 201
    project = project_response.json()
    team = _wegent_team(test_db, test_user)
    agent_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert agent_response.status_code == 201

    create_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/collaboration-groups",
        headers=_auth(test_token),
        json={
            "name": "交付协作组",
            "description": "人与智能体共同交付",
            "instructions": "实现工作应该 @智能体 来完成，完成后由负责人验收",
            "leader": {
                "kind": "human",
                "id": str(test_user.id),
                "responsibility": "确认目标并验收",
            },
            "members": [
                {
                    "kind": "human",
                    "id": str(test_user.id),
                    "responsibility": "确认目标并验收",
                },
                {
                    "kind": "agent",
                    "id": str(team.id),
                    "responsibility": "实现并提交结果",
                },
            ],
            "coordination_mode": "manager",
            "stages": [
                {
                    "id": "implement",
                    "name": "实现",
                    "description": "完成需求实现",
                    "assignee": {
                        "kind": "agent",
                        "id": str(team.id),
                        "responsibility": "实现并提交结果",
                    },
                }
            ],
            "execution_requirements": {"required_tags": ["macos", "workspace-ready"]},
        },
    )
    assert create_response.status_code == 201
    group = create_response.json()
    assert group["owner_type"] == "workspace"
    assert group["owner_id"] == str(workspace["id"])
    assert group["leader"] == {
        "kind": "human",
        "id": str(test_user.id),
        "responsibility": "确认目标并验收",
    }
    assert group["members"] == [
        {
            "kind": "human",
            "id": str(test_user.id),
            "responsibility": "确认目标并验收",
        },
        {
            "kind": "agent",
            "id": str(team.id),
            "responsibility": "实现并提交结果",
        },
    ]
    assert group["stages"][0]["name"] == "实现"
    assert group["instructions"] == "实现工作应该 @智能体 来完成，完成后由负责人验收"
    assert group["execution_requirements"] == {
        "required_tags": ["macos", "workspace-ready"]
    }

    enable_response = test_client.post(
        (
            f"/api/v1/cloud-projects/{project['id']}/collaboration-groups/"
            f"{group['id']}"
        ),
        headers=_auth(test_token),
    )
    assert enable_response.status_code == 201
    assert enable_response.json()["id"] == group["id"]
    assert test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/collaboration-groups",
        headers=_auth(test_token),
    ).json()["items"] == [group]

    project_only_team = _wegent_team(test_db, test_user)
    _project_agent(
        test_db,
        project_id=str(project["id"]),
        team_id=project_only_team.id,
        owner=test_user,
    )
    project_group_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/collaboration-groups",
        headers=_auth(test_token),
        json={
            "name": "项目专属协作组",
            "leader": {"kind": "human", "id": str(test_user.id)},
            "members": [
                {"kind": "human", "id": str(test_user.id)},
                {"kind": "agent", "id": str(project_only_team.id)},
            ],
            "coordination_mode": "manager",
        },
    )
    assert project_group_response.status_code == 201
    project_group = project_group_response.json()
    assert project_group["owner_type"] == "project"
    assert project_group["owner_id"] == str(project["id"])

    codex_agent = ProjectChatAgent(
        id=str(9_000_000_000_000_000_000 + int(uuid.uuid4().hex[:12], 16)),
        cloud_project_id=str(project["id"]),
        title="项目 Codex Agent",
        name="项目 Codex Agent",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={
            "runtime": "codex",
            "capability_description": "负责实现与验收",
        },
    )
    test_db.add(codex_agent)
    test_db.commit()
    project_codex_group_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/collaboration-groups",
        headers=_auth(test_token),
        json={
            "name": "项目 Codex 协作组",
            "leader": {"kind": "agent", "id": codex_agent.id},
            "members": [{"kind": "agent", "id": codex_agent.id}],
            "coordination_mode": "manager",
        },
    )
    assert project_codex_group_response.status_code == 201
    project_codex_group = project_codex_group_response.json()
    assert project_codex_group["leader"] == {
        "kind": "agent",
        "id": codex_agent.id,
        "responsibility": "",
    }
    assert project_codex_group["members"] == [
        {"kind": "agent", "id": codex_agent.id, "responsibility": ""}
    ]
    assert not any(
        isinstance(rule.metadata_json, dict)
        and rule.metadata_json.get("collaboration_group_id")
        == int(project_codex_group["id"])
        for rule in test_db.query(ProjectAutomationRule).all()
    )
    assert test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/collaboration-groups",
        headers=_auth(test_token),
    ).json()["items"] == [group, project_codex_group, project_group]

    update_response = test_client.patch(
        (
            f"/api/v1/workspaces/{workspace['id']}/collaboration-groups/"
            f"{group['id']}"
        ),
        headers=_auth(test_token),
        json={
            "version": group["version"],
            "leader": {
                "kind": "agent",
                "id": str(team.id),
                "responsibility": "负责拆解和收敛",
            },
            "coordination_mode": "manager",
            "stages": [],
        },
    )
    assert update_response.status_code == 200
    updated = update_response.json()
    assert updated["leader"] == {
        "kind": "agent",
        "id": str(team.id),
        "responsibility": "负责拆解和收敛",
    }
    assert updated["coordination_mode"] == "manager"
    assert updated["stages"] == []
    assert updated["version"] == group["version"] + 1

    project_update_response = test_client.patch(
        (
            f"/api/v1/cloud-projects/{project['id']}/collaboration-groups/"
            f"{project_group['id']}"
        ),
        headers=_auth(test_token),
        json={
            "version": project_group["version"],
            "description": "项目内维护的人机协作组织",
            "members": [
                {
                    "kind": "human",
                    "id": str(test_user.id),
                    "responsibility": "项目负责人",
                },
                {
                    "kind": "agent",
                    "id": str(project_only_team.id),
                    "responsibility": "执行任务",
                },
            ],
        },
    )
    assert project_update_response.status_code == 200
    assert project_update_response.json()["description"] == "项目内维护的人机协作组织"

    list_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/collaboration-groups",
        headers=_auth(test_token),
    )
    assert list_response.status_code == 200
    assert list_response.json()["items"] == [updated]

    disable_response = test_client.delete(
        (
            f"/api/v1/cloud-projects/{project['id']}/collaboration-groups/"
            f"{group['id']}"
        ),
        headers=_auth(test_token),
    )
    assert disable_response.status_code == 204

    delete_project_group_response = test_client.delete(
        (
            f"/api/v1/cloud-projects/{project['id']}/collaboration-groups/"
            f"{project_group['id']}"
        ),
        headers=_auth(test_token),
    )
    assert delete_project_group_response.status_code == 204

    delete_project_codex_group_response = test_client.delete(
        (
            f"/api/v1/cloud-projects/{project['id']}/collaboration-groups/"
            f"{project_codex_group['id']}"
        ),
        headers=_auth(test_token),
    )
    assert delete_project_codex_group_response.status_code == 204

    delete_response = test_client.delete(
        (
            f"/api/v1/workspaces/{workspace['id']}/collaboration-groups/"
            f"{group['id']}"
        ),
        headers=_auth(test_token),
    )
    assert delete_response.status_code == 204
    assert (
        test_client.get(
            f"/api/v1/workspaces/{workspace['id']}/collaboration-groups",
            headers=_auth(test_token),
        ).json()["items"]
        == []
    )


def test_collaboration_group_rejects_stage_assignee_outside_members(
    test_client: TestClient,
    test_token: str,
    test_user: User,
) -> None:
    workspace = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"阶段成员校验 {uuid.uuid4().hex[:6]}"},
    ).json()

    response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/collaboration-groups",
        headers=_auth(test_token),
        json={
            "name": "无效阶段成员",
            "leader": {"kind": "human", "id": str(test_user.id)},
            "members": [{"kind": "human", "id": str(test_user.id)}],
            "stages": [
                {
                    "id": "review",
                    "name": "评审",
                    "assignee": {"kind": "human", "id": str(test_user.id + 1)},
                }
            ],
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Collaboration group stage assignee must be a group member"
    )


def _project_agent(
    test_db: Session,
    *,
    project_id: str,
    team_id: int,
    owner: User,
) -> ProjectChatAgent:
    agent = ProjectChatAgent(
        id=f"A{uuid.uuid4().hex[:12]}",
        cloud_project_id=project_id,
        title="Wegent 研发 Agent",
        name="Wegent 研发 Agent",
        status="active",
        created_by_user_id=owner.id,
        metadata_json={
            "runtime": "wegent",
            "wegent_team_id": team_id,
            "visibility": "public",
        },
    )
    test_db.add(agent)
    test_db.commit()
    test_db.refresh(agent)
    return agent


def test_workspace_resources_and_project_scope_are_separate(
    device_online_infos: dict[str, object],
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": "研发空间", "description": "共享研发资源"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()

    team = create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        name_prefix="workspace",
    )
    device = Kind(
        kind="Device",
        name=f"workspace-device-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "displayName": "我的 Mac",
                "deviceType": "local",
                "status": "online",
            },
        },
    )
    unavailable_team = create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        name_prefix="workspace-stale-model",
    )
    unavailable_team.json = {
        **unavailable_team.json,
        "status": {"state": "Available"},
    }
    bot_name = unavailable_team.json["spec"]["members"][0]["botRef"]["name"]
    bot = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Bot",
            Kind.user_id == test_user.id,
            Kind.name == bot_name,
        )
        .one()
    )
    model_name = bot.json["spec"]["modelRef"]["name"]
    model = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Model",
            Kind.user_id == test_user.id,
            Kind.name == model_name,
        )
        .one()
    )
    model.is_active = False
    offline_cloud_device = Kind(
        kind="Device",
        name=f"workspace-cloud-device-{uuid.uuid4().hex[:8]}",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={
            "spec": {
                "displayName": "离线云主机",
                "deviceType": "cloud",
            },
        },
    )
    test_db.add_all([device, offline_cloud_device])
    test_db.commit()
    test_db.refresh(team)
    test_db.refresh(unavailable_team)
    test_db.refresh(device)
    test_db.refresh(offline_cloud_device)
    device_online_infos[f"device:online:{test_user.id}:{device.name}"] = {
        "status": "online"
    }

    resources = test_client.get(
        "/api/v1/resources",
        headers=_auth(test_token),
    )
    assert resources.status_code == 200
    resource_body = resources.json()
    personal_agent = next(
        row for row in resource_body["agents"] if row["team_id"] == team.id
    )
    assert {
        key: value
        for key, value in personal_agent.items()
        if key != "execution_environment_ids"
    } == {
        "id": str(team.id),
        "name": team.name,
        "team_id": team.id,
        "owner_type": "user",
        "owner_id": str(test_user.id),
        "owner_name": test_user.user_name,
        "status": "available",
        "workspace_ids": [],
    }
    assert set(personal_agent["execution_environment_ids"]) == {
        str(device.id),
        str(offline_cloud_device.id),
    }
    unavailable_agent = next(
        row for row in resource_body["agents"] if row["team_id"] == unavailable_team.id
    )
    assert unavailable_agent["status"] == "unavailable"
    personal_environment = next(
        row
        for row in resource_body["execution_environments"]
        if row["id"] == str(device.id)
    )
    assert personal_environment["device_id"] == device.id
    assert personal_environment["device_key"]
    assert personal_environment["coding_tools"] == ["claude_code", "codex"]
    assert personal_environment["kind"] == "local_device"
    assert personal_environment["owner_type"] == "user"
    assert personal_environment["owner_id"] == str(test_user.id)
    assert personal_environment["owner_name"] == test_user.user_name
    assert personal_environment["status"] == "online"
    assert personal_environment["workspace_ids"] == []
    assert personal_environment["updated_at"]
    offline_environment = next(
        row
        for row in resource_body["execution_environments"]
        if row["id"] == str(offline_cloud_device.id)
    )
    assert offline_environment["kind"] == "cloud_host"
    assert offline_environment["status"] == "offline"

    agent_binding = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert agent_binding.status_code == 201
    environment_binding = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/execution-environments",
        headers=_auth(test_token),
        json={"device_id": device.id},
    )
    assert environment_binding.status_code == 201
    workspace_agents = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
    ).json()["items"]
    assert len(workspace_agents) == 1
    workspace_agent = workspace_agents[0]
    assert workspace_agent["id"] == str(team.id)
    assert workspace_agent["team_id"] == team.id
    assert workspace_agent["owner_type"] == "user"
    assert workspace_agent["owner_id"] == str(test_user.id)
    assert workspace_agent["owner_name"] == test_user.user_name
    assert workspace_agent["status"] == "available"
    assert workspace_agent["execution_environment_ids"] == [
        environment_binding.json()["id"]
    ]

    workspace_environments = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/execution-environments",
        headers=_auth(test_token),
    ).json()["items"]
    assert len(workspace_environments) == 1
    workspace_environment = workspace_environments[0]
    assert workspace_environment["id"] == str(device.id)
    assert workspace_environment["device_id"] == device.id
    assert workspace_environment["coding_tools"] == ["claude_code", "codex"]
    assert workspace_environment["kind"] == "local_device"
    assert workspace_environment["owner_type"] == "user"
    assert workspace_environment["owner_id"] == str(test_user.id)
    assert workspace_environment["owner_name"] == test_user.user_name
    assert workspace_environment["status"] == "online"
    assert workspace_environment["updated_at"]

    project_ids: list[str] = []
    for name in ("项目 A", "项目 B"):
        response = test_client.post(
            f"/api/v1/workspaces/{workspace['id']}/projects",
            headers=_auth(test_token),
            json={"name": name},
        )
        assert response.status_code == 201
        assert response.json()["workspace_id"] == workspace["id"]
        project_ids.append(response.json()["id"])

    project_environment = test_client.post(
        f"/api/v1/cloud-projects/{project_ids[0]}/execution-environments",
        headers=_auth(test_token),
        json={"device_id": device.id},
    )
    assert project_environment.status_code == 201
    assert project_environment.json()["workspace_id"] == workspace["id"]
    assert project_environment.json()["device_id"] == device.id

    first_project_environments = test_client.get(
        f"/api/v1/cloud-projects/{project_ids[0]}/execution-environments",
        headers=_auth(test_token),
    )
    assert first_project_environments.status_code == 200
    assert [
        item["device_id"] for item in first_project_environments.json()["items"]
    ] == [device.id]

    second_project_environments = test_client.get(
        f"/api/v1/cloud-projects/{project_ids[1]}/execution-environments",
        headers=_auth(test_token),
    )
    assert second_project_environments.status_code == 200
    assert second_project_environments.json()["items"] == []

    direct_project_environment = test_client.post(
        f"/api/v1/cloud-projects/{project_ids[1]}/execution-environments",
        headers=_auth(test_token),
        json={"device_id": offline_cloud_device.id},
    )
    assert direct_project_environment.status_code == 201
    assert direct_project_environment.json()["device_id"] == offline_cloud_device.id

    removed_environment = test_client.delete(
        f"/api/v1/cloud-projects/{project_ids[0]}/execution-environments/{device.id}",
        headers=_auth(test_token),
    )
    assert removed_environment.status_code == 204

    for project_id in project_ids:
        test_db.add(
            ProjectChatAgent(
                id=f"A{uuid.uuid4().hex[:12]}",
                cloud_project_id=project_id,
                title="共享 Team",
                name="共享 Team",
                status="active",
                created_by_user_id=test_user.id,
                metadata_json={"runtime": "wegent", "wegent_team_id": team.id},
            )
        )
    test_db.commit()
    project_agents = (
        test_db.query(ProjectChatAgent)
        .filter(ProjectChatAgent.cloud_project_id.in_(project_ids))
        .all()
    )
    assert len(project_agents) == 2
    assert {int(agent.metadata_json["wegent_team_id"]) for agent in project_agents} == {
        team.id
    }


def test_issue_actions_are_authorized_independently(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    reporter, reporter_token = _user(test_db, f"reporter-{uuid.uuid4().hex[:8]}")
    maintainer, maintainer_token = _user(test_db, f"maintainer-{uuid.uuid4().hex[:8]}")
    workspace = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": "权限测试空间"},
    ).json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={"name": "权限测试项目"},
    )
    assert project_response.status_code == 201
    project = project_response.json()
    for user, role in ((reporter, "Developer"), (maintainer, "Maintainer")):
        response = test_client.post(
            f"/api/v1/cloud-projects/{project['id']}/members",
            headers=_auth(test_token),
            json={"user_id": user.id, "role": role},
        )
        assert response.status_code == 201

    issue_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "实现权限分离", "status": "inbox"},
    )
    assert issue_response.status_code == 201
    issue = issue_response.json()

    reporter_view = test_client.get(
        f"/api/v1/loop-items/{issue['id']}",
        headers=_auth(reporter_token),
    )
    assert reporter_view.status_code == 200
    assert reporter_view.json()["permissions"] == {
        "edit_content": True,
        "comment": True,
        "assign": False,
        "execute": True,
    }
    assert (
        test_client.post(
            f"/api/v1/loop-items/{issue['id']}/comments",
            headers=_auth(reporter_token),
            json={"body": "Developer 可以评论"},
        ).status_code
        == 201
    )
    assert (
        test_client.patch(
            f"/api/v1/loop-items/{issue['id']}",
            headers=_auth(reporter_token),
            json={"version": issue["version"], "title": "允许修改"},
        ).status_code
        == 200
    )
    assert (
        test_client.post(
            f"/api/v1/loop-items/{issue['id']}/assignments",
            headers=_auth(reporter_token),
            json={
                "target_type": "human",
                "target_id": str(reporter.id),
                "workflow_step": "开发",
            },
        ).status_code
        == 403
    )
    task_binding = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/tasks",
        headers=_auth(reporter_token),
        json={"deviceId": "reporter-device", "taskId": "local-task-1"},
    )
    assert task_binding.status_code == 201

    assigned = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(maintainer_token),
        json={
            "target_type": "human",
            "target_id": str(reporter.id),
            "workflow_step": "开发",
            "comment_body": "请处理开发步骤",
            "notify_target": False,
        },
    )
    assert assigned.status_code == 201
    assignment = assigned.json()["assignment"]
    assert assignment["workflow_step"] == "开发"
    assert assignment["comment_id"] is not None

    listed = test_client.get(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(reporter_token),
    )
    assert listed.status_code == 200
    assert {row["target_id"] for row in listed.json()["items"]} >= {
        str(test_user.id),
        str(reporter.id),
    }

    removed = test_client.delete(
        f"/api/v1/loop-items/{issue['id']}/assignments/{assignment['id']}",
        headers=_auth(maintainer_token),
    )
    assert removed.status_code == 204
    remaining = test_client.get(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(reporter_token),
    ).json()["items"]
    assert str(reporter.id) not in {row["target_id"] for row in remaining}
    assert str(test_user.id) in {row["target_id"] for row in remaining}


def test_project_maintainer_can_add_project_member_without_workspace_membership(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client,
        test_db,
        test_token,
    )
    target, _ = _user(test_db, f"project-member-{uuid.uuid4().hex[:8]}")

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(maintainer_token),
        json={"user_id": target.id, "role": "Viewer"},
    )

    assert response.status_code == 201
    workspace_members = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/members",
        headers=_auth(test_token),
    )
    assert workspace_members.status_code == 200
    assert target.id not in {
        member["user_id"] for member in workspace_members.json()["items"]
    }


def test_project_member_can_read_minimal_parent_workspace_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client,
        test_db,
        test_token,
    )
    target, target_token = _user(
        test_db, f"project-workspace-viewer-{uuid.uuid4().hex[:8]}"
    )
    member_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(maintainer_token),
        json={"user_id": target.id, "role": "Viewer"},
    )
    assert member_response.status_code == 201

    workspace_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}",
        headers=_auth(target_token),
    )
    assert workspace_response.status_code == 404

    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(target_token),
    )
    assert navigation_response.status_code == 200
    assert navigation_response.json() == {
        "id": workspace["id"],
        "public_id": workspace["public_id"],
        "name": workspace["name"],
    }
    listed_workspace_ids = {
        item["id"]
        for item in test_client.get(
            "/api/v1/workspaces",
            headers=_auth(target_token),
        ).json()["items"]
    }
    assert workspace["id"] not in listed_workspace_ids

    for resource in ("members", "agents", "execution-environments"):
        response = test_client.get(
            f"/api/v1/workspaces/{workspace['id']}/{resource}",
            headers=_auth(target_token),
        )
        assert response.status_code == 404


def test_invalid_project_member_role_cannot_read_project_or_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client,
        test_db,
        test_token,
    )
    target, target_token = _user(
        test_db, f"invalid-project-role-{uuid.uuid4().hex[:8]}"
    )
    member_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(maintainer_token),
        json={"user_id": target.id, "role": "Viewer"},
    )
    assert member_response.status_code == 201
    membership = test_db.get(ResourceMember, member_response.json()["id"])
    assert membership is not None
    membership.role = "CorruptedRole"
    test_db.commit()

    project_response = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}",
        headers=_auth(target_token),
    )
    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(target_token),
    )

    assert project_response.status_code == 404
    assert navigation_response.status_code == 404


def test_invalid_workspace_member_role_cannot_read_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Invalid role space {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    target, target_token = _user(
        test_db, f"invalid-workspace-role-{uuid.uuid4().hex[:8]}"
    )
    member_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/members",
        headers=_auth(test_token),
        json={"user_id": target.id, "role": "Reporter"},
    )
    assert member_response.status_code == 201
    membership = test_db.get(ResourceMember, member_response.json()["id"])
    assert membership is not None
    membership.role = "CorruptedRole"
    test_db.commit()

    workspace_read_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}",
        headers=_auth(target_token),
    )
    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(target_token),
    )

    assert workspace_read_response.status_code == 403
    assert navigation_response.status_code == 404


def test_public_project_visitor_can_read_parent_workspace_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Public project space {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={
            "name": f"Public project {uuid.uuid4().hex[:6]}",
            "visibility": "public",
        },
    )
    assert project_response.status_code == 201
    _, visitor_token = _user(test_db, f"public-project-visitor-{uuid.uuid4().hex[:8]}")

    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(visitor_token),
    )
    assert navigation_response.status_code == 200
    assert navigation_response.json() == {
        "id": workspace["id"],
        "public_id": workspace["public_id"],
        "name": workspace["name"],
    }
    assert (
        test_client.get(
            f"/api/v1/workspaces/{workspace['id']}",
            headers=_auth(visitor_token),
        ).status_code
        == 404
    )
    for resource in ("members", "agents", "execution-environments"):
        response = test_client.get(
            f"/api/v1/workspaces/{workspace['id']}/{resource}",
            headers=_auth(visitor_token),
        )
        assert response.status_code == 404


def test_private_project_does_not_grant_parent_workspace_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Private project space {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={
            "name": f"Private project {uuid.uuid4().hex[:6]}",
            "visibility": "private",
        },
    )
    assert project_response.status_code == 201
    _, visitor_token = _user(test_db, f"private-project-visitor-{uuid.uuid4().hex[:8]}")

    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(visitor_token),
    )

    assert navigation_response.status_code == 404


def test_archived_project_does_not_grant_parent_workspace_navigation_context(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
) -> None:
    workspace_response = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"Archived project space {uuid.uuid4().hex[:6]}"},
    )
    assert workspace_response.status_code == 201
    workspace = workspace_response.json()
    project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={
            "name": f"Archived public project {uuid.uuid4().hex[:6]}",
            "visibility": "public",
        },
    )
    assert project_response.status_code == 201
    project = project_response.json()
    _, visitor_token = _user(
        test_db, f"archived-project-visitor-{uuid.uuid4().hex[:8]}"
    )
    archive_response = test_client.delete(
        f"/api/v1/cloud-projects/{project['id']}?version={project['version']}",
        headers=_auth(test_token),
    )
    assert archive_response.status_code == 204

    navigation_response = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/navigation-context",
        headers=_auth(visitor_token),
    )

    assert navigation_response.status_code == 404


def test_personal_execution_environment_uses_owned_device_identity(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
) -> None:
    workspace = test_client.post(
        "/api/v1/workspaces",
        headers=_auth(test_token),
        json={"name": f"同名执行环境 {uuid.uuid4().hex[:6]}"},
    ).json()
    other_user, _ = _user(test_db, f"device-owner-{uuid.uuid4().hex[:8]}")
    shared_name = f"duplicate-device-{uuid.uuid4().hex[:8]}"
    owner_device = Kind(
        kind="Device",
        name=shared_name,
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={},
    )
    other_device = Kind(
        kind="Device",
        name=shared_name,
        namespace="default",
        user_id=other_user.id,
        is_active=True,
        json={},
    )
    test_db.add_all([owner_device, other_device])
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="Device",
            resource_id=other_device.id,
            entity_type="workspace",
            entity_id=str(workspace["id"]),
            role="Developer",
            status="approved",
            invited_by_user_id=test_user.id,
        )
    )
    test_db.commit()

    binding = WorkspaceExecutionEnvironmentService().ensure_owned_execution_environment_authorized(
        test_db,
        workspace_id=workspace["id"],
        user_id=test_user.id,
        execution_device_id=shared_name,
    )

    assert binding.resource_id == owner_device.id
    assert binding.resource_id != other_device.id


def test_maintainer_assigns_workflow_step_to_authorized_workspace_agent(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import board_team_execution
    from app.tasks import robot_queue_tasks

    workspace, project, maintainer, maintainer_token = (
        _workspace_project_with_maintainer(test_client, test_db, test_token)
    )
    team = _wegent_team(test_db, test_user)
    authorization = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert authorization.status_code == 201
    agent = _project_agent(
        test_db,
        project_id=str(project["id"]),
        team_id=team.id,
        owner=test_user,
    )
    issue_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "实现 Agent 分配契约", "status": "inbox"},
    )
    assert issue_response.status_code == 201
    issue = issue_response.json()

    dispatch = AsyncMock(return_value=None)
    consume_queues = AsyncMock(return_value=None)
    monkeypatch.setattr(
        board_team_execution,
        "dispatch_board_team_assignment",
        dispatch,
    )
    monkeypatch.setattr(
        robot_queue_tasks,
        "consume_queues_background",
        consume_queues,
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(maintainer_token),
        json={
            "target_type": "agent",
            "target_id": agent.id,
            "workflow_step": "后端开发",
            "comment_body": "请完成 Workspace Agent 分配能力",
            "notify_target": True,
            "trigger": "workflow",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["assignment"]["target_type"] == "agent"
    assert body["assignment"]["target_id"] == agent.id
    assert body["assignment"]["target_name"] == agent.title
    assert body["assignment"]["workflow_step"] == "后端开发"
    assert body["assignment"]["body"] == "请完成 Workspace Agent 分配能力"
    assert body["assignment"]["created_by_user_id"] == maintainer.id
    assert body["assignment"]["status"] == "active"
    assert body["assignment"]["comment_id"] is not None
    assert body["issue"]["assignee_agent_id"] == agent.id

    assignment = test_db.get(LoopItemComment, body["assignment"]["id"])
    assert assignment is not None
    assert assignment.cloud_project_id == str(project["id"])
    assert assignment.created_by_user_id == maintainer.id
    assert assignment.metadata_json["target_type"] == "agent"
    assert assignment.metadata_json["target_id"] == agent.id
    assert assignment.metadata_json["workflow_step"] == "后端开发"
    assert assignment.metadata_json["notify"] is True
    assert assignment.metadata_json["trigger"] == "workflow"

    execution = (
        test_db.query(LoopItemExecution)
        .filter(
            LoopItemExecution.loop_item_id == issue["id"],
            LoopItemExecution.agent_id == agent.id,
        )
        .one()
    )
    assert execution.cloud_project_id == str(project["id"])
    assert execution.team_id == team.id
    assert execution.assigner_user_id == maintainer.id
    assert execution.execution_environment == "wegent"
    assert execution.status == "queued"

    dispatch.assert_awaited_once()
    dispatched_item = dispatch.await_args.kwargs["item"]
    assert isinstance(dispatched_item, LoopItem)
    assert dispatched_item.id == issue["id"]
    assert dispatched_item.assignee_agent_id == agent.id
    assert dispatch.await_args.kwargs["user"].id == maintainer.id
    consume_queues.assert_awaited_once_with()


def test_internal_agent_assignment_commits_comment_projection_and_run_once(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import board_team_execution
    from app.tasks import robot_queue_tasks

    workspace, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    team = _wegent_team(test_db, test_user)
    authorization = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert authorization.status_code == 201
    agent = _project_agent(
        test_db,
        project_id=str(project["id"]),
        team_id=team.id,
        owner=test_user,
    )
    issue = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "验证单事务分配", "status": "inbox"},
    ).json()
    initial_assignment_ids = {
        comment.id for comment in _assignment_comments(test_db, issue["id"])
    }

    committed = False
    commit_calls = 0
    original_commit = test_db.commit

    def commit_once() -> None:
        nonlocal committed, commit_calls
        commit_calls += 1
        assignment = next(
            comment
            for comment in _assignment_comments(test_db, issue["id"])
            if comment.id not in initial_assignment_ids
        )
        assert assignment.metadata_json["target_id"] == agent.id
        projected = test_db.get(LoopItem, issue["id"])
        assert projected is not None
        assert projected.assignee_agent_id == agent.id
        assert (
            test_db.query(LoopItemExecution)
            .filter(LoopItemExecution.loop_item_id == issue["id"])
            .count()
            == 1
        )
        original_commit()
        committed = True

    async def dispatch_after_commit(*_args: object, **_kwargs: object) -> None:
        assert committed is True

    monkeypatch.setattr(test_db, "commit", commit_once)
    dispatch = AsyncMock(side_effect=dispatch_after_commit)
    monkeypatch.setattr(
        board_team_execution,
        "dispatch_board_team_assignment",
        dispatch,
    )
    monkeypatch.setattr(
        robot_queue_tasks,
        "consume_queues_background",
        AsyncMock(return_value=None),
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(maintainer_token),
        json={
            "target_type": "agent",
            "target_id": agent.id,
            "workflow_step": "实现",
            "comment_body": "一次提交完成",
        },
    )

    assert response.status_code == 201
    assert commit_calls == 1
    assert response.json()["assignment"]["comment_id"] is not None
    dispatch.assert_awaited_once()


def test_internal_assignment_failure_rolls_back_comment_assignment_and_notification(
    test_client: TestClient,
    test_db: Session,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, project, maintainer, maintainer_token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    target, _ = _user(test_db, f"rollback-target-{uuid.uuid4().hex[:8]}")
    member_response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/members",
        headers=_auth(test_token),
        json={"user_id": target.id, "role": "Viewer"},
    )
    assert member_response.status_code == 201
    issue = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "验证失败回滚", "status": "inbox"},
    ).json()
    original_version = issue["version"]
    original_comment_ids = {
        comment.id
        for comment in test_db.query(LoopItemComment)
        .filter(LoopItemComment.loop_item_id == issue["id"])
        .all()
    }

    def fail_commit() -> None:
        raise RuntimeError("commit failed")

    monkeypatch.setattr(test_db, "commit", fail_commit)
    with pytest.raises(RuntimeError, match="commit failed"):
        test_client.post(
            f"/api/v1/loop-items/{issue['id']}/assignments",
            headers=_auth(maintainer_token),
            json={
                "target_type": "human",
                "target_id": str(target.id),
                "workflow_step": "实现",
                "comment_body": "这条评论必须回滚",
                "notify_target": True,
            },
        )

    monkeypatch.undo()
    test_db.expire_all()
    persisted = test_db.get(LoopItem, issue["id"])
    assert persisted is not None
    assert persisted.version == original_version
    assert persisted.assignee_user_id != target.id
    assert {
        comment.id
        for comment in test_db.query(LoopItemComment)
        .filter(LoopItemComment.loop_item_id == issue["id"])
        .all()
    } == original_comment_ids
    assert (
        test_db.query(WeworkNotification)
        .filter(
            WeworkNotification.user_id == target.id,
            WeworkNotification.actor_user_id == maintainer.id,
            WeworkNotification.kind == "assignment",
        )
        .count()
        == 0
    )


def test_agent_assignment_uses_project_agent_without_workspace_authorization(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import board_team_execution

    _, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    team = _wegent_team(test_db, test_user)
    agent = _project_agent(
        test_db,
        project_id=str(project["id"]),
        team_id=team.id,
        owner=test_user,
    )
    issue = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "拒绝未授权 Team", "status": "inbox"},
    ).json()
    original_assignment_ids = {
        comment.id for comment in _assignment_comments(test_db, issue["id"])
    }
    dispatch = AsyncMock(return_value=None)
    monkeypatch.setattr(
        board_team_execution,
        "dispatch_board_team_assignment",
        dispatch,
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(maintainer_token),
        json={
            "target_type": "agent",
            "target_id": agent.id,
            "workflow_step": "开发",
        },
    )

    assert response.status_code == 201
    assert {
        comment.id for comment in _assignment_comments(test_db, issue["id"])
    } != original_assignment_ids
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue["id"])
        .count()
        == 1
    )
    dispatch.assert_awaited_once()


def test_agent_assignment_rejects_agent_from_another_project(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import board_team_execution

    workspace, project, _, maintainer_token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    other_project_response = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/projects",
        headers=_auth(test_token),
        json={"name": f"其他项目 {uuid.uuid4().hex[:6]}"},
    )
    assert other_project_response.status_code == 201
    other_project = other_project_response.json()
    team = _wegent_team(test_db, test_user)
    authorization = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert authorization.status_code == 201
    other_project_agent = _project_agent(
        test_db,
        project_id=str(other_project["id"]),
        team_id=team.id,
        owner=test_user,
    )
    issue = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/loop-items",
        headers=_auth(test_token),
        json={"title": "拒绝跨项目 Agent", "status": "inbox"},
    ).json()
    original_assignment_ids = {
        comment.id for comment in _assignment_comments(test_db, issue["id"])
    }
    dispatch = AsyncMock(return_value=None)
    monkeypatch.setattr(
        board_team_execution,
        "dispatch_board_team_assignment",
        dispatch,
    )

    response = test_client.post(
        f"/api/v1/loop-items/{issue['id']}/assignments",
        headers=_auth(maintainer_token),
        json={
            "target_type": "agent",
            "target_id": other_project_agent.id,
            "workflow_step": "开发",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "Agent is not active in this Project"
    assert {
        comment.id for comment in _assignment_comments(test_db, issue["id"])
    } == original_assignment_ids
    assert (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.loop_item_id == issue["id"])
        .count()
        == 0
    )
    dispatch.assert_not_awaited()

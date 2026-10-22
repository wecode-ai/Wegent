"""Exercise the desktop Agent definition and project binding creation flow."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from tests.api.test_collaboration_permission_contract import invite
from tests.api.test_collaboration_permission_contract import scope as scope
from tests.api.test_workspace_shared_agents import _native_team


@pytest.mark.parametrize("existing_share", [False, True])
def test_project_agent_creation_from_bot_and_team_apis(
    test_client: TestClient, test_db: Session, scope: dict, existing_share: bool
) -> None:
    shell = Kind(
        kind="Shell",
        name="Codex",
        namespace="default",
        user_id=0,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {"name": "Codex", "namespace": "default"},
            "spec": {"shellType": "Codex", "baseImage": "codex:test"},
        },
    )
    test_db.add(shell)
    test_db.commit()
    bot = test_client.post(
        "/api/bots",
        headers=scope["owner"],
        json={
            "name": "project-agent-bot",
            "shell_name": "Codex",
            "agent_config": {},
            "execution_policy": {"mode": "project_pool"},
            "model_policy": {"mode": "user_select"},
            "capability_mode": "follow_device",
            "system_prompt": "Complete the assigned work.",
            "namespace": "default",
        },
    )
    assert bot.status_code == 201, bot.text
    team = test_client.post(
        "/api/teams",
        headers=scope["owner"],
        json={
            "name": "project-agent",
            "displayName": "Project Agent",
            "workflow": {"mode": "solo", "leader_bot_id": bot.json()["id"]},
            "bots": [{"bot_id": bot.json()["id"], "role": "leader"}],
            "namespace": "default",
            "bind_mode": ["code", "task"],
            "requires_workspace": True,
        },
    )
    assert team.status_code == 201, team.text
    if existing_share:
        shared = test_client.post(
            f"/api/v1/workspaces/{scope['space']['id']}/agents",
            headers=scope["owner"],
            json={"team_id": team.json()["id"]},
        )
        assert shared.status_code == 201, shared.text
        members_path = f"/api/share/Team/{team.json()['id']}/members"
        members = test_client.get(members_path, headers=scope["owner"])
        assert members.status_code == 200, members.text
        grant = next(
            member
            for member in members.json()["members"]
            if member["entity_type"] == "workspace"
        )
        downgraded = test_client.put(
            f"{members_path}/{grant['id']}",
            headers=scope["owner"],
            json={"role": "Reporter"},
        )
        assert downgraded.status_code == 200, downgraded.text
    created = test_client.post(
        f"/api/v1/cloud-projects/{scope['project']['id']}/chat-agents",
        headers=scope["owner"],
        json={
            "name": team.json()["displayName"],
            "runtime": "wegent",
            "wegent_team_id": team.json()["id"],
            "share_with_workspace": True,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["canUse"] is True
    assert created.json()["wegentTeamId"] == team.json()["id"]
    assert (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Team",
            resource_id=team.json()["id"],
            entity_type="workspace",
            entity_id=scope["space"]["id"],
            status="approved",
            role="Developer",
        )
        .count()
        == 1
    )


@pytest.mark.parametrize(
    "role,grant_status",
    [
        ("Viewer", "approved"),
        ("Reporter", "approved"),
        ("Unknown", "approved"),
        ("Developer", "pending"),
        ("Developer", "rejected"),
    ],
)
@pytest.mark.parametrize("entry_point", ["project", "workspace"])
def test_cp11_explicit_sharing_reauthorizes_an_unusable_team_grant(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    scope: dict,
    role: str,
    grant_status: str,
    entry_point: str,
) -> None:
    team = _native_team(test_db, test_user)
    grant = ResourceMember.create(
        resource_type="Team",
        resource_id=team.id,
        entity_type="workspace",
        entity_id=scope["space"]["id"],
        role=role,
        status=grant_status,
        invited_by_user_id=test_user.id,
    )
    test_db.add(grant)
    test_db.commit()
    endpoint = (
        f"/api/v1/workspaces/{scope['space']['id']}/agents"
        if entry_point == "workspace"
        else f"/api/v1/cloud-projects/{scope['project']['id']}/chat-agents"
    )
    payload = (
        {"team_id": team.id}
        if entry_point == "workspace"
        else {
            "name": "Reauthorized Agent",
            "runtime": "wegent",
            "wegentTeamId": team.id,
            "shareWithWorkspace": True,
        }
    )
    created = test_client.post(
        endpoint,
        headers=scope["owner"],
        json=payload,
    )
    assert created.status_code == 201, created.text
    if entry_point == "project":
        assert created.json()["canUse"] is True
    test_db.refresh(grant)
    assert grant.role == "Developer"
    assert grant.status == "approved"


@pytest.mark.parametrize("consent", [False, True])
@pytest.mark.parametrize("grant_status", ["approved", "pending", "rejected"])
def test_cp05_cp10_cp11_reauthorization_requires_consent_and_source_permission(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    scope: dict,
    consent: bool,
    grant_status: str,
) -> None:
    team = _native_team(test_db, test_user)
    grant = ResourceMember.create(
        resource_type="Team",
        resource_id=team.id,
        entity_type="workspace",
        entity_id=scope["space"]["id"],
        role="Reporter",
        status=grant_status,
        invited_by_user_id=test_user.id,
    )
    test_db.add(grant)
    invite(test_client, scope, "Developer")
    invite(test_client, scope, "Maintainer", project=True)
    shared_read = ResourceMember.create(
        resource_type="Team",
        resource_id=team.id,
        entity_id=str(scope["user"].id),
        role="Reporter",
        status="approved",
    )
    test_db.add(shared_read)
    test_db.commit()
    created = test_client.post(
        f"/api/v1/cloud-projects/{scope['project']['id']}/chat-agents",
        headers=scope["member"] if consent else scope["owner"],
        json={
            "name": "Unauthorized Agent",
            "runtime": "wegent",
            "wegentTeamId": team.id,
            "shareWithWorkspace": consent,
        },
    )
    assert created.status_code == (403 if consent else 422), created.text
    test_db.refresh(grant)
    assert grant.role == "Reporter"
    assert grant.status == grant_status

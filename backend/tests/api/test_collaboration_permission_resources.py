"""CP invariants for resources, alternative entry points, and revocation."""

from datetime import datetime
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from app.models.delivery import CloudProject, LoopItem, ProjectChatAgent
from app.models.kind import Kind
from app.models.loop_item_execution import LoopItemExecution
from app.models.resource_member import ResourceMember
from app.schemas.cloud_project import CloudProjectMemberResponse
from app.services.cloud_projects.service import cloud_project_service
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.collaboration_revocation import (
    execution_authorized,
    sweep_revoked_work,
)
from app.services.loop_item_executions.service import loop_item_execution_service
from tests.api.test_collaboration_permission_contract import invite
from tests.api.test_collaboration_permission_contract import scope as scope
from tests.api.test_workspace_shared_agents import _native_team
from tests.service_results import service_result
from tests.utils.collaboration import authorize_project_agent, authorize_resource


def test_cp09_cp10_private_agent_remains_creator_only_for_project_admins(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer", project=True)
    pid = scope["project"]["id"]
    response = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents",
        headers=scope["owner"],
        json={"name": "Private definition", "visibility": "private"},
    )
    assert response.status_code == 201
    private = response.json()
    owner_rows = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["owner"]
    ).json()
    other_admin_rows = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["member"]
    ).json()
    assert private["id"] in {row["id"] for row in owner_rows}
    assert private["id"] not in {row["id"] for row in other_admin_rows}
    assigned = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Private assignment", "assignee_agent_id": private["id"]},
    )
    assert assigned.status_code == 403
    from app.schemas.project_chat import ProjectChatAgentStart
    from app.services.project_chat.service import project_chat_service

    with pytest.raises(HTTPException) as denied:
        project_chat_service.start_agent_response(
            test_db,
            user_id=scope["user"].id,
            request=ProjectChatAgentStart(
                project_id=str(pid),
                agent_id=private["id"],
                runtime_device_id="unstarted-device",
                runtime_task_id="unstarted-task",
            ),
        )
    assert denied.value.status_code == 403
    published = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/chat-agents/{private['id']}",
        headers=scope["member"],
        json={"version": private["version"], "visibility": "public"},
    )
    assert published.status_code == 403


@pytest.mark.parametrize(
    "role,status",
    [
        ("Developer", "pending"),
        ("Maintainer", "rejected"),
        ("Unknown", "approved"),
    ],
)
@pytest.mark.parametrize("kind", ["Workspace", "CloudProject"])
def test_cp05_invalid_grants_never_authorize(test_db, scope, role, status, kind):
    resource_id = int(scope["space" if kind == "Workspace" else "project"]["id"])
    test_db.add(
        ResourceMember.create(
            resource_type=kind,
            resource_id=resource_id,
            entity_id=str(scope["user"].id),
            role=role,
            status=status,
        )
    )
    test_db.flush()
    decision = collaboration_permission_service.check(
        test_db, scope["user"].id, "read", scope["project"]["id"]
    )
    assert not decision.allowed
    assert decision.reason == "not_accessible"


def test_cp01_cp05_archived_parent_denies_direct_and_public_access(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer", project=True)
    project = test_db.get(CloudProject, scope["project"]["id"])
    parent = test_db.get(Kind, project.workspace_id)
    parent.is_active = False
    test_db.commit()
    for headers in (scope["owner"], scope["member"]):
        assert (
            test_client.get(
                f"/api/v1/projects/{project.id}", headers=headers
            ).status_code
            == 404
        )


def test_cp05_public_read_does_not_create_participants(test_db, test_client, scope):
    pid = scope["project"]["id"]
    result = test_client.patch(
        f"/api/v1/cloud-projects/{pid}",
        headers=scope["owner"],
        json={"version": scope["project"]["version"], "visibility": "public"},
    )
    assert result.status_code == 200, result.text
    detail = test_client.get(f"/api/v1/projects/{pid}", headers=scope["member"])
    assert detail.status_code == 200
    assert detail.json()["access_role"] == "Viewer"
    assert detail.json()["permission_sources"] == [{"type": "public", "role": "Viewer"}]
    roster = service_result(
        cloud_project_service.list_members,
        test_db,
        int(pid),
        scope["user"].id,
        response_model=list[CloudProjectMemberResponse],
    ).json()
    assert scope["user"].id not in {row["user_id"] for row in roster}
    legacy_update = test_client.patch(
        f"/api/v1/cloud-projects/{pid}",
        headers=scope["owner"],
        json={
            "version": result.json()["version"],
            "public_access": {"role": "Developer"},
        },
    )
    assert legacy_update.status_code == 200
    assert legacy_update.json()["public_access"] == {"role": "Viewer"}


def test_cp10_cp11_hosted_team_creation_shares_only_with_explicit_consent(
    test_client, test_db, test_user, scope
):
    team = _native_team(test_db, test_user)
    project_id = scope["project"]["id"]
    request = {
        "name": "New shared agent",
        "runtime": "wegent",
        "wegent_team_id": team.id,
    }
    denied = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/chat-agents",
        headers=scope["owner"],
        json=request,
    )
    assert denied.status_code == 422
    assert (
        not test_db.query(ResourceMember)
        .filter_by(
            resource_type="Team",
            resource_id=team.id,
            entity_type="workspace",
            entity_id=str(scope["space"]["id"]),
            status="approved",
        )
        .count()
    )

    created = test_client.post(
        f"/api/v1/cloud-projects/{project_id}/chat-agents",
        headers=scope["owner"],
        json={**request, "share_with_workspace": True},
    )
    assert created.status_code == 201, created.text
    assert (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Team",
            resource_id=team.id,
            entity_type="workspace",
            entity_id=str(scope["space"]["id"]),
            status="approved",
        )
        .count()
        == 1
    )
    assert (
        collaboration_permission_service.require_project_team(
            test_db, project_id, team.id
        ).id
        == team.id
    )


def test_cp10_cp11_cp13_resource_use_requires_space_share_and_project_binding(
    test_client, test_db, test_user, scope
):
    invite(test_client, scope, "Developer")
    team = _native_team(test_db, test_user)
    pid, wid = scope["project"]["id"], scope["space"]["id"]
    body = {"name": "Scoped agent", "runtime": "wegent", "wegent_team_id": team.id}
    denied = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["owner"], json=body
    )
    assert denied.status_code == 422
    share = test_client.post(
        f"/api/v1/workspaces/{wid}/agents",
        headers=scope["owner"],
        json={"team_id": team.id},
    )
    assert share.status_code == 201, share.text
    with pytest.raises(HTTPException, match="not enabled"):
        collaboration_permission_service.require_project_team(test_db, pid, team.id)
    member_binding = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents",
        headers=scope["member"],
        json={**body, "share_with_workspace": True},
    )
    assert member_binding.status_code == 403
    unbound_issue = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Shared Agent still requires a project binding"},
    ).json()
    unbound_assignment = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items/{unbound_issue['id']}/assign",
        headers=scope["member"],
        json={
            "version": unbound_issue["version"],
            "assignee_type": "team",
            "assignee_id": str(team.id),
        },
    )
    assert unbound_assignment.status_code == 422
    enabled = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["owner"], json=body
    )
    assert enabled.status_code == 201, enabled.text
    assert (
        collaboration_permission_service.require_project_team(test_db, pid, team.id).id
        == team.id
    )
    assert (
        test_client.get(f"/api/teams/{team.id}", headers=scope["member"]).status_code
        == 404
    )
    assert (
        test_client.delete(
            f"/api/v1/workspaces/{wid}/agents/{team.id}", headers=scope["owner"]
        ).status_code
        == 204
    )
    visible = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["member"]
    ).json()
    assert visible[0]["canUse"] is False
    assert visible[0]["unavailableReason"]
    plain = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={"title": "Issue"},
    ).json()
    for method, url, data in [
        (
            "post",
            f"/api/v1/cloud-projects/{pid}/loop-items",
            {"title": "Bad create", "assignee_agent_id": enabled.json()["id"]},
        ),
        (
            "patch",
            f"/api/v1/loop-items/{plain['id']}",
            {"version": plain["version"], "assignee_agent_id": enabled.json()["id"]},
        ),
        (
            "post",
            f"/api/v1/cloud-projects/{pid}/loop-items/{plain['id']}/assign",
            {
                "version": plain["version"],
                "assignee_type": "team",
                "assignee_id": str(team.id),
            },
        ),
    ]:
        assert (
            getattr(test_client, method)(
                url, headers=scope["member"], json=data
            ).status_code
            == 422
        )


def test_cp14_issue_read_requires_project_then_relation(test_client, scope):
    invite(test_client, scope, "Viewer")
    pid = scope["project"]["id"]
    settings = test_client.patch(
        f"/api/v1/cloud-projects/{pid}",
        headers=scope["owner"],
        json={
            "version": scope["project"]["version"],
            "default_issue_security": "related",
        },
    )
    assert settings.status_code == 200
    item = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["owner"],
        json={"title": "Related issue"},
    ).json()
    assert (
        test_client.get(
            f"/api/v1/loop-items/{item['id']}", headers=scope["member"]
        ).status_code
        == 404
    )
    assert (
        test_client.get(
            f"/api/v1/loop-items/{item['id']}", headers=scope["owner"]
        ).status_code
        == 200
    )
    assert (
        test_client.delete(
            f"/api/v1/workspaces/{scope['space']['id']}/members/{scope['user'].id}",
            headers=scope["owner"],
        ).status_code
        == 204
    )
    assert (
        test_client.get(
            f"/api/v1/loop-items/{item['id']}", headers=scope["member"]
        ).status_code
        == 404
    )


def make_execution(test_db, scope, status):
    project = test_db.get(CloudProject, scope["project"]["id"])
    runner = Kind(
        kind="Device",
        name="contract-runner",
        namespace="default",
        user_id=project.created_by_user_id,
        is_active=True,
        json={"spec": {"deviceType": "local"}},
    )
    test_db.add(runner)
    test_db.flush()
    authorize_resource(test_db, project, runner)
    issue = LoopItem(
        cloud_project_id=project.id,
        title="Revocation",
        status="inbox",
        created_by_user_id=project.created_by_user_id,
        metadata_json={},
    )
    agent = ProjectChatAgent(
        cloud_project_id=project.id,
        name="Contract agent",
        status="active",
        created_by_user_id=project.created_by_user_id,
        metadata_json={"runtime": "codex"},
    )
    authorize_project_agent(test_db, agent)
    test_db.add_all([issue, agent])
    test_db.flush()
    run = LoopItemExecution(
        cloud_project_id=project.id,
        loop_item_id=issue.id,
        agent_id=agent.id,
        executor_owner_user_id=runner.user_id,
        assigner_user_id=scope["user"].id,
        execution_environment="local",
        execution_device_id=runner.name,
        runtime_device_id=runner.name if status == "running" else "",
        runtime_task_id="contract-task" if status == "running" else "",
        status=status,
    )
    if status == "running":
        run.start_requested_at = datetime.now()
        run.started_at = datetime.now()
    test_db.add(run)
    test_db.commit()
    return run, agent, runner


@pytest.mark.parametrize(
    "initial", ["pending_approval", "waiting_runtime", "queued", "claimed", "running"]
)
def test_cp15_cp16_cp17_revocation_cancels_work_and_waits_for_runtime(
    test_client, test_db, scope, monkeypatch, initial
):
    invite(test_client, scope, "Developer")
    invite(test_client, scope, "Developer", project=True)
    publisher = Mock()
    monkeypatch.setattr(
        "app.services.loop_item_executions.cancellation.request_execution_cancellations",
        publisher,
    )
    run, _, _ = make_execution(test_db, scope, initial)
    assert execution_authorized(test_db, run)
    response = test_client.delete(
        f"/api/v1/workspaces/{scope['space']['id']}/members/{scope['user'].id}",
        headers=scope["owner"],
    )
    assert response.status_code == 204, response.text
    test_db.refresh(run)
    assert not execution_authorized(test_db, run)
    assert run.status == ("cancel_requested" if initial == "running" else "cancelled")
    assert (
        not test_db.query(ResourceMember.id)
        .filter_by(
            resource_type="CloudProject",
            resource_id=int(scope["project"]["id"]),
            entity_id=str(scope["user"].id),
        )
        .all()
    )
    if initial == "running":
        publisher.assert_called_once()
        reconciled = loop_item_execution_service.reconcile_runtime_snapshot(
            test_db, execution_id=run.id, runtime_status="cancelled", running=False
        )
        assert reconciled.status == "cancelled"


@pytest.mark.asyncio
async def test_cp15_cp18_resource_revocation_and_periodic_sweep(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    run, agent, runner = make_execution(test_db, scope, "queued")
    parent_grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Device", resource_id=runner.id, entity_type="workspace"
        )
        .one()
    )
    test_db.delete(parent_grant)
    test_db.flush()
    assert not execution_authorized(test_db, run)
    sweep_revoked_work(test_db)
    test_db.refresh(run)
    assert run.status == "cancelled"
    from app.services.cloud_projects.service import cloud_project_service

    rows = await cloud_project_service.list_execution_environments(
        test_db, int(scope["project"]["id"]), scope["project"]["created_by_user_id"]
    )
    assert rows[0]["can_use"] is False
    assert rows[0]["unavailable_reason"] == "resource_authorization_revoked"


def test_cp15_cross_project_agent_and_issue_injection_is_rejected(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    run, agent, _ = make_execution(test_db, scope, "queued")
    other = test_client.post(
        f"/api/v1/workspaces/{scope['space']['id']}/projects",
        headers=scope["owner"],
        json={"name": "Other"},
    ).json()
    agent.cloud_project_id = other["id"]
    test_db.flush()
    assert not execution_authorized(test_db, run)
    agent.cloud_project_id = scope["project"]["id"]
    run.cloud_project_id = other["id"]
    test_db.flush()
    assert not execution_authorized(test_db, run)


def test_cp19_ownership_transfer_versions_and_owner_api_validation(test_client, scope):
    wid = scope["space"]["id"]
    for url in (
        f"/api/v1/workspaces/{wid}/members",
        f"/api/v1/cloud-projects/{scope['project']['id']}/members",
    ):
        result = test_client.post(
            url,
            headers=scope["owner"],
            json={"user_id": scope["user"].id, "role": "Owner"},
        )
        assert result.status_code == 201
        assert result.json()["role"] == "Maintainer"
    body = {"user_id": scope["user"].id, "version": scope["space"]["version"] + 1}
    assert (
        test_client.post(
            f"/api/v1/workspaces/{wid}/transfer-ownership",
            headers=scope["owner"],
            json=body,
        ).status_code
        == 409
    )
    body["version"] = scope["space"]["version"]
    first = test_client.post(
        f"/api/v1/workspaces/{wid}/transfer-ownership",
        headers=scope["owner"],
        json=body,
    )
    assert first.status_code == 200
    assert (
        test_client.post(
            f"/api/v1/workspaces/{wid}/transfer-ownership",
            headers=scope["owner"],
            json=body,
        ).status_code
        == 403
    )


@pytest.mark.parametrize("revoke", ["group_binding", "group_member", "agent_binding"])
def test_cp15_cp16_group_snapshots_do_not_preserve_revoked_authority(
    test_client, test_db, scope, revoke
):
    import json

    invite(test_client, scope, "Developer")
    run, leader, _ = make_execution(test_db, scope, "queued")
    member = ProjectChatAgent(
        cloud_project_id=run.cloud_project_id,
        name="Member agent",
        status="active",
        metadata_json={"runtime": "codex"},
    )
    authorize_project_agent(test_db, member)
    test_db.add(member)
    test_db.flush()
    snapshot = {
        "leader": {"kind": "agent", "id": leader.id},
        "members": [{"kind": "agent", "id": member.id}],
    }
    group = Kind(
        kind="CollaborationGroup",
        name="Revocation group",
        namespace=f"projects/{run.cloud_project_id}",
        user_id=scope["user"].id,
        is_active=True,
        json={"spec": snapshot},
    )
    test_db.add(group)
    test_db.flush()
    snapshot = {**snapshot, "id": str(group.id)}
    grant = ResourceMember.create(
        resource_type="CollaborationGroup",
        resource_id=group.id,
        entity_type="project",
        entity_id=run.cloud_project_id,
        role="Developer",
        status="approved",
    )
    test_db.add(grant)
    run.execution_payload = json.dumps(
        {"origin_context": {"collaboration_group": snapshot}}
    )
    test_db.flush()
    assert execution_authorized(test_db, run)
    if revoke == "group_binding":
        test_db.delete(grant)
    elif revoke == "group_member":
        group.json = {"spec": {**snapshot, "members": []}}
    else:
        member.status = "archived"
    test_db.flush()
    assert not execution_authorized(test_db, run)
    sweep_revoked_work(test_db)
    test_db.refresh(run)
    assert run.status == "cancelled"


def test_cp07_viewers_cannot_be_assignees(test_client, scope):
    invite(test_client, scope, "Viewer")
    pid = scope["project"]["id"]
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["owner"],
        json={"title": "Cannot assign to viewer"},
    )
    assert created.status_code == 201
    item = created.json()
    response = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items/{item['id']}/assign",
        headers=scope["owner"],
        json={
            "version": item["version"],
            "assignee_type": "user",
            "assignee_id": str(scope["user"].id),
        },
    )
    assert response.status_code == 422


def test_cp05_inactive_initiator_cannot_keep_queued_execution_authority(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    run, _, _ = make_execution(test_db, scope, "queued")
    scope["user"].is_active = False
    test_db.commit()
    assert not execution_authorized(test_db, run)
    assert not collaboration_permission_service.check(
        test_db, scope["user"].id, "execute", run.cloud_project_id
    ).allowed
    sweep_revoked_work(test_db)
    test_db.refresh(run)
    assert run.status == "cancelled"


@pytest.mark.parametrize(
    "role,status",
    [
        ("Developer", "pending"),
        ("Developer", "rejected"),
        ("Unknown", "approved"),
        ("Viewer", "approved"),
    ],
)
def test_cp05_cp11_inline_definition_grants_cannot_bypass_resource_authority(
    test_client, test_db, scope, role, status
):
    invite(test_client, scope, "Developer")
    run, agent, _ = make_execution(test_db, scope, "queued")
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=int(scope["space"]["id"]),
            entity_type="project_agent",
            entity_id=agent.id,
        )
        .one()
    )
    grant.role, grant.status = role, status
    test_db.commit()
    assert not execution_authorized(test_db, run)
    response = test_client.post(
        f"/api/v1/cloud-projects/{run.cloud_project_id}/loop-items",
        headers=scope["member"],
        json={"title": "Rejected", "assignee_agent_id": agent.id},
    )
    assert response.status_code == 422
    assert (
        test_client.get(
            f"/api/v1/cloud-projects/{run.cloud_project_id}/chat-agents",
            headers=scope["member"],
        ).json()[0]["canUse"]
        is False
    )


def test_cp04_project_guest_reads_bindings_without_space_catalog_permission(
    test_client, scope
):
    invite(test_client, scope, "Maintainer", project=True)
    pid = scope["project"]["id"]
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/chat-agents",
        headers=scope["owner"],
        json={"name": "Visible binding"},
    )
    assert created.status_code == 201
    detail = test_client.get(f"/api/v1/projects/{pid}", headers=scope["member"])
    assert detail.status_code == 200
    assert detail.json()["workspace_access_role"] is None
    visible = test_client.get(
        f"/api/v1/cloud-projects/{pid}/chat-agents", headers=scope["member"]
    )
    assert visible.status_code == 200
    assert created.json()["id"] in {agent["id"] for agent in visible.json()}


@pytest.mark.parametrize("source", ["snapshot", "agent_default"])
@pytest.mark.parametrize("invalid", ["archived", "deleted", "missing"])
def test_cp15_runtime_profile_snapshot_requires_current_configuration(
    test_client, test_db, scope, source, invalid
):
    import json

    from app.models.delivery import RuntimeProfile

    invite(test_client, scope, "Developer")
    run, agent, _ = make_execution(test_db, scope, "queued")
    profile = RuntimeProfile(
        name="Current profile",
        status="active",
        created_by_user_id=agent.created_by_user_id,
    )
    test_db.add(profile)
    test_db.flush()
    if source == "snapshot":
        run.execution_payload = json.dumps(
            {"runtime_selection": {"runtime_profile_id": profile.id}}
        )
    else:
        agent.metadata_json = {
            **agent.metadata_json,
            "default_runtime_profile_id": profile.id,
        }
    test_db.commit()
    assert execution_authorized(test_db, run)
    if invalid == "archived":
        profile.status = "archived"
    elif invalid == "deleted":
        profile.deleted_at = datetime.now()
    else:
        test_db.delete(profile)
    test_db.commit()
    assert not execution_authorized(test_db, run)
    sweep_revoked_work(test_db)
    test_db.refresh(run)
    assert run.status == "cancelled"


def test_cp11_inline_source_revocation_and_explicit_reactivation(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    run, agent, _ = make_execution(test_db, scope, "queued")
    pid = run.cloud_project_id
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Workspace",
            resource_id=int(scope["space"]["id"]),
            entity_type="project_agent",
            entity_id=agent.id,
        )
        .one()
    )
    test_db.delete(grant)
    agent.status = "archived"
    agent.metadata_json = {
        **agent.metadata_json,
        "permission_migration_reason": "resource_sharing_required",
    }
    test_db.commit()
    request = {"version": agent.version, "status": "active"}
    denied = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/chat-agents/{agent.id}",
        headers=scope["owner"],
        json=request,
    )
    assert denied.status_code == 422
    assert not execution_authorized(test_db, run)
    recovered = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/chat-agents/{agent.id}",
        headers=scope["owner"],
        json={**request, "share_with_workspace": True},
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["canUse"] is True
    test_db.refresh(agent)
    assert "permission_migration_reason" not in agent.metadata_json
    assert execution_authorized(test_db, run)


def test_cp04_project_guest_can_reenable_already_shared_inline_binding(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer", project=True)
    run, agent, _ = make_execution(test_db, scope, "queued")
    agent.status = "archived"
    test_db.commit()
    recovered = test_client.patch(
        f"/api/v1/cloud-projects/{run.cloud_project_id}/chat-agents/{agent.id}",
        headers=scope["member"],
        json={
            "version": agent.version,
            "status": "active",
            "share_with_workspace": True,
        },
    )
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["canUse"] is True


@pytest.mark.parametrize(
    "role,status,visible",
    [
        ("Developer", "approved", True),
        ("Viewer", "approved", True),
        ("Owner", "approved", True),
        ("Unknown", "approved", False),
        ("Developer", "pending", False),
    ],
)
def test_cp05_runner_catalog_uses_valid_space_membership(
    test_client, test_db, scope, role, status, visible
):
    from app.services.runner_routing import visible_environment_ids

    _, _, runner = make_execution(test_db, scope, "queued")
    test_db.add(
        ResourceMember.create(
            resource_type="Workspace",
            resource_id=int(scope["space"]["id"]),
            entity_id=str(scope["user"].id),
            role=role,
            status=status,
        )
    )
    test_db.commit()
    assert (runner.id in visible_environment_ids(test_db, scope["user"].id)) is visible
    assert runner.id in visible_environment_ids(test_db, runner.user_id)


@pytest.mark.parametrize("role,expected", [("Developer", 201), ("Viewer", 403)])
def test_cp11_cp12_cp15_personal_issue_task_needs_no_project_device_binding(
    test_client, scope, role, expected
):
    invite(test_client, scope, role)
    pid = scope["project"]["id"]
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["owner"],
        json={"title": "Personal execution without project preparation"},
    )
    assert created.status_code == 201, created.text
    response = test_client.post(
        f"/api/v1/loop-items/{created.json()['id']}/tasks",
        headers=scope["member"],
        json={"deviceId": "personal-executor", "taskId": "personal-task"},
    )
    assert response.status_code == expected, response.text

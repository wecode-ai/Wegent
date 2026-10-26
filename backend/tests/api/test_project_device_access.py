"""Device-owner scopes extend the CP10/11/13/15/16 resource contract."""

import json
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.delivery import CloudProject
from app.models.resource_member import ResourceMember
from app.schemas.project_device_access import ProjectDeviceAccess
from app.services.collaboration_revocation import execution_authorized
from app.services.project_device_access import device_access, set_device_access
from app.services.runner_routing import execution_environment_ids
from tests.api.test_collaboration_permission_contract import invite
from tests.api.test_collaboration_permission_contract import scope as scope
from tests.api.test_collaboration_permission_resources import make_execution


def change(client, db, context, device, *, preview=False, token=None, **policy):
    project = db.get(CloudProject, context["project"]["id"])
    return client.patch(
        f"/api/v1/cloud-projects/{project.id}",
        headers=context["owner"],
        json={
            "version": project.version,
            "device_access_change": {
                "device_id": device.id,
                "preview_only": preview,
                "confirmation_token": token,
                **policy,
            },
        },
    )


@pytest.mark.parametrize(
    "policy_scope,allowed", [("owner", False), ("members", True), ("project", True)]
)
def test_cp10_cp11_cp15_member_scopes_constrain_resource_consent(
    test_client, test_db, scope, policy_scope, allowed
):
    invite(test_client, scope, "Developer")
    run, _, device = make_execution(test_db, scope, "queued")
    project = test_db.get(CloudProject, run.cloud_project_id)
    set_device_access(
        project,
        device.id,
        ProjectDeviceAccess(
            scope=policy_scope,
            member_ids=[scope["user"].id] if policy_scope == "members" else [],
        ),
    )
    test_db.commit()
    assert execution_authorized(test_db, run) is allowed
    assert (
        device.id
        in execution_environment_ids(
            test_db, project.id, run.agent_id, user_id=scope["user"].id
        )
    ) is allowed
    # Device ownership never replaces the existing space/project grants.
    grant = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Device", resource_id=device.id, entity_type="workspace"
        )
        .one()
    )
    grant.status = "rejected"
    test_db.commit()
    assert not execution_environment_ids(
        test_db, project.id, run.agent_id, user_id=device.user_id
    )


@pytest.mark.parametrize(
    "initial", ["pending_approval", "waiting_runtime", "queued", "claimed", "running"]
)
def test_cp13_cp16_preview_and_commit_reuse_runtime_cancellation(
    test_client, test_db, scope, monkeypatch, initial
):
    invite(test_client, scope, "Developer")
    run, _, device = make_execution(test_db, scope, initial)
    publisher = Mock()
    monkeypatch.setattr("app.tasks.robot_queue_tasks.emit_runtime_cancels", publisher)
    project = test_db.get(CloudProject, run.cloud_project_id)
    version = project.version
    preview = change(test_client, test_db, scope, device, scope="owner", preview=True)
    assert preview.status_code == 200, preview.text
    plan = preview.json()["device_access_preview"]
    assert plan["affected_execution_count"] == 1
    assert plan["affected_agent_count"] == 1
    assert set(plan) == {
        "affected_execution_count",
        "affected_agent_count",
        "confirmation_token",
    }
    test_db.refresh(project)
    test_db.refresh(run)
    assert project.version == version
    assert device_access(project, device.id).scope == "project"
    assert run.status == initial
    assert not publisher.called

    applied = change(
        test_client,
        test_db,
        scope,
        device,
        scope="owner",
        token=plan["confirmation_token"],
    )
    assert applied.status_code == 200, applied.text
    test_db.refresh(project)
    test_db.refresh(run)
    assert project.version == version + 1
    assert device_access(project, device.id).scope == "owner"
    assert run.status == ("cancel_requested" if initial == "running" else "cancelled")
    if initial == "running":
        assert publisher.call_args.args[0][0].id == run.id
        assert run.observed_state != "cancelled"


def test_cp10_admin_cannot_change_another_owners_device_scope(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer")
    _, _, device = make_execution(test_db, scope, "queued")
    response = test_client.patch(
        f"/api/v1/cloud-projects/{scope['project']['id']}",
        headers=scope["member"],
        json={
            "version": scope["project"]["version"],
            "device_access_change": {
                "device_id": device.id,
                "scope": "project",
                "preview_only": True,
            },
        },
    )
    assert response.status_code == 403, response.text


def test_cp07_viewer_owner_cannot_change_or_use_device_scope(
    test_client, test_db, scope
):
    invite(test_client, scope, "Viewer")
    run, _, device = make_execution(test_db, scope, "queued")
    device.user_id = scope["user"].id
    test_db.commit()
    response = test_client.patch(
        f"/api/v1/cloud-projects/{scope['project']['id']}",
        headers=scope["member"],
        json={
            "version": scope["project"]["version"],
            "device_access_change": {
                "device_id": device.id,
                "scope": "project",
                "preview_only": True,
            },
        },
    )
    assert response.status_code == 403, response.text
    assert not execution_authorized(test_db, run)


def test_cp15_changed_impact_requires_fresh_confirmation(test_client, test_db, scope):
    invite(test_client, scope, "Developer")
    run, _, device = make_execution(test_db, scope, "queued")
    preview = change(test_client, test_db, scope, device, scope="owner", preview=True)
    run.version += 1
    test_db.commit()
    response = change(
        test_client,
        test_db,
        scope,
        device,
        scope="owner",
        token=preview.json()["device_access_preview"]["confirmation_token"],
    )
    assert response.status_code == 409, response.text
    test_db.refresh(run)
    assert run.status == "queued"
    project = test_db.get(CloudProject, run.cloud_project_id)
    assert device_access(project, device.id).scope == "project"


@pytest.mark.parametrize(
    "policy",
    [
        {"scope": "unknown"},
        {"scope": "members", "member_ids": []},
        {"scope": "owner", "member_ids": [1]},
        {"scope": "members", "member_ids": [True]},
        {"scope": "members", "member_ids": [-1]},
    ],
)
def test_invalid_device_policies_are_rejected(test_client, test_db, scope, policy):
    _, _, device = make_execution(test_db, scope, "queued")
    response = change(test_client, test_db, scope, device, preview=True, **policy)
    assert response.status_code == 422, response.text


def test_cp05_recipients_must_be_current_executable_members(
    test_client, test_db, scope
):
    invite(test_client, scope, "Viewer")
    _, _, device = make_execution(test_db, scope, "queued")
    response = change(
        test_client,
        test_db,
        scope,
        device,
        preview=True,
        scope="members",
        member_ids=[scope["user"].id],
    )
    assert response.status_code == 422, response.text


def test_permission_changes_cannot_smuggle_project_configuration(
    test_client, test_db, scope
):
    _, _, device = make_execution(test_db, scope, "queued")
    response = test_client.patch(
        f"/api/v1/cloud-projects/{scope['project']['id']}",
        headers=scope["owner"],
        json={
            "version": scope["project"]["version"],
            "name": "Unintended edit",
            "device_access_change": {
                "device_id": device.id,
                "scope": "owner",
                "preview_only": True,
            },
        },
    )
    assert response.status_code == 422, response.text


def test_cp10_developer_can_manage_their_own_device(test_client, test_db, scope):
    invite(test_client, scope, "Developer")
    _, _, device = make_execution(test_db, scope, "queued")
    device.user_id = scope["user"].id
    test_db.commit()
    response = change(
        test_client,
        test_db,
        {**scope, "owner": scope["member"]},
        device,
        scope="owner",
        preview=True,
    )
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("role,expected", [("Maintainer", 200), ("Developer", 403)])
def test_cp02_space_owned_devices_use_space_management_authority(
    test_client, test_db, scope, role, expected
):
    invite(test_client, scope, role)
    _, _, device = make_execution(test_db, scope, "queued")
    device.json = {**device.json, "spec": {"workspaceOwnerId": scope["space"]["id"]}}
    test_db.commit()
    response = change(
        test_client,
        test_db,
        {**scope, "owner": scope["member"]},
        device,
        scope="owner",
        preview=True,
    )
    assert response.status_code == expected, response.text


def test_apply_requires_preview_and_preserves_sibling_project(
    test_client, test_db, scope
):
    _, _, device = make_execution(test_db, scope, "queued")
    sibling = test_client.post(
        f"/api/v1/workspaces/{scope['space']['id']}/projects",
        headers=scope["owner"],
        json={"name": "Sibling"},
    )
    assert sibling.status_code == 201, sibling.text
    other = test_db.get(CloudProject, sibling.json()["id"])
    before = dict(other.metadata_json)
    rejected = change(test_client, test_db, scope, device, scope="owner")
    assert rejected.status_code == 409, rejected.text
    preview = change(test_client, test_db, scope, device, scope="owner", preview=True)
    applied = change(
        test_client,
        test_db,
        scope,
        device,
        scope="owner",
        token=preview.json()["device_access_preview"]["confirmation_token"],
    )
    assert applied.status_code == 200, applied.text
    test_db.refresh(other)
    assert other.metadata_json == before


def test_new_binding_is_private_and_rebinding_does_not_broaden_consent(
    test_client, test_db, scope
):
    invite(test_client, scope, "Maintainer")
    _, _, device = make_execution(test_db, scope, "queued")
    test_db.query(ResourceMember).filter_by(
        resource_type="Device", resource_id=device.id, entity_type="project"
    ).delete()
    test_db.commit()
    path = f"/api/v1/cloud-projects/{scope['project']['id']}/execution-environments"
    response = test_client.post(
        path, headers=scope["member"], json={"device_id": device.id}
    )
    assert response.status_code == 201, response.text
    row = response.json()
    assert row["use_access"] == {"scope": "owner", "member_ids": []}
    assert not row["can_use"]
    assert not row["can_manage_access"]
    assert row["unavailable_reason"] == "device_use_not_allowed"
    project = test_db.get(CloudProject, scope["project"]["id"])
    assert row["project_version"] == project.version
    assert (
        test_client.delete(f"{path}/{device.id}", headers=scope["owner"]).status_code
        == 204
    )
    restored = test_client.post(
        path, headers=scope["owner"], json={"device_id": device.id}
    )
    assert restored.status_code == 201, restored.text
    assert restored.json()["use_access"] == row["use_access"]


@pytest.mark.parametrize("has_other_runner", [False, True])
def test_queued_pool_is_cancelled_only_when_revocation_removes_its_last_runner(
    test_client, test_db, scope, has_other_runner
):
    invite(test_client, scope, "Developer")
    run, _, device = make_execution(test_db, scope, "queued")
    run.execution_device_id = ""
    run.runtime_device_id = ""
    run.execution_payload = json.dumps(
        {
            "runtime_selection": {
                "runner_routing": {
                    "execution_policy": {"mode": "project_pool"},
                    "model": {
                        "runtime": "codex",
                        "provider": "openai",
                        "model_id": "model-x",
                    },
                }
            }
        }
    )
    if has_other_runner:
        from app.models.kind import Kind
        from tests.utils.collaboration import authorize_resource

        other = Kind(
            kind="Device",
            name="second-runner",
            namespace="default",
            user_id=device.user_id,
            is_active=True,
            json={},
        )
        test_db.add(other)
        test_db.flush()
        authorize_resource(
            test_db, test_db.get(CloudProject, run.cloud_project_id), other
        )
    test_db.commit()
    preview = change(test_client, test_db, scope, device, scope="owner", preview=True)
    assert preview.status_code == 200, preview.text
    plan = preview.json()["device_access_preview"]
    assert plan["affected_execution_count"] == (0 if has_other_runner else 1)
    response = change(
        test_client,
        test_db,
        scope,
        device,
        scope="owner",
        token=plan["confirmation_token"],
    )
    assert response.status_code == 200, response.text
    test_db.refresh(run)
    assert run.status == ("queued" if has_other_runner else "cancelled")


@pytest.mark.parametrize(
    "stored", [None, [], "invalid", {"scope": "project", "member_ids": [1]}]
)
def test_invalid_stored_policies_never_broaden_consent(test_db, scope, stored):
    from app.services.project_device_access import can_use_device

    _, _, device = make_execution(test_db, scope, "queued")
    project = test_db.get(CloudProject, scope["project"]["id"])
    project.metadata_json = {
        **project.metadata_json,
        "execution_device_access": {
            str(device.id): stored,
        },
    }
    assert not can_use_device(test_db, project, device, scope["user"].id)
    project.metadata_json = {**project.metadata_json, "execution_device_access": stored}
    if not isinstance(stored, dict):
        assert not can_use_device(test_db, project, device, scope["user"].id)


def test_confirmation_does_not_cancel_unrelated_unauthorized_work(
    test_client, test_db, scope
):
    from app.models.kind import Kind
    from app.models.loop_item_execution import LoopItemExecution
    from tests.utils.collaboration import authorize_resource

    invite(test_client, scope, "Developer")
    run, agent, device = make_execution(test_db, scope, "queued")
    project = test_db.get(CloudProject, scope["project"]["id"])
    other = Kind(
        kind="Device",
        name="unrelated-runner",
        namespace="default",
        user_id=device.user_id,
        is_active=True,
        json={},
    )
    test_db.add(other)
    test_db.flush()
    authorize_resource(test_db, project, other)
    set_device_access(project, other.id, ProjectDeviceAccess())
    unrelated = LoopItemExecution(
        cloud_project_id=project.id,
        loop_item_id=run.loop_item_id,
        agent_id=agent.id,
        executor_owner_user_id=other.user_id,
        assigner_user_id=scope["user"].id,
        execution_environment="local",
        execution_device_id=other.name,
        status="queued",
    )
    test_db.add(unrelated)
    test_db.commit()
    preview = change(test_client, test_db, scope, device, scope="owner", preview=True)
    assert preview.status_code == 200, preview.text
    plan = preview.json()["device_access_preview"]
    assert plan["affected_execution_count"] == 1
    response = change(
        test_client,
        test_db,
        scope,
        device,
        scope="owner",
        token=plan["confirmation_token"],
    )
    assert response.status_code == 200, response.text
    test_db.refresh(unrelated)
    assert unrelated.status == "queued"


def test_cp15_claim_filter_refreshes_policy_changed_by_another_session(test_db, scope):
    from sqlalchemy.orm import Session

    run, _, device = make_execution(test_db, scope, "queued")
    project = test_db.get(CloudProject, run.cloud_project_id)
    assert device_access(project, device.id).scope == "project"
    with Session(test_db.get_bind()) as writer:
        current = writer.get(CloudProject, project.id)
        set_device_access(current, device.id, ProjectDeviceAccess())
        writer.commit()
    assert device_access(project, device.id).scope == "project"
    assert not execution_environment_ids(
        test_db, project.id, run.agent_id, user_id=scope["user"].id
    )


@pytest.mark.parametrize("policy_scope,expected", [("owner", 403), ("project", 200)])
def test_project_preparation_enforces_device_use_scope(
    test_client, test_db, scope, monkeypatch, policy_scope, expected
):
    invite(test_client, scope, "Maintainer")
    run, _, device = make_execution(test_db, scope, "queued")
    project = test_db.get(CloudProject, run.cloud_project_id)
    set_device_access(project, device.id, ProjectDeviceAccess(scope=policy_scope))
    test_db.commit()
    prepare = AsyncMock(return_value={"status": "ready"})
    monkeypatch.setattr(
        "app.services.cloud_projects.service.initialize_execution_environment", prepare
    )
    response = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/execution-environment/initialize",
        headers=scope["member"],
        json={"version": project.version, "device_id": device.id},
    )
    assert response.status_code == expected, response.text
    assert prepare.await_count == (1 if expected == 200 else 0)

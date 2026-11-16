"""Project overrides preserve space administration and durable revocation."""

from unittest.mock import Mock

import pytest

from app.models.cloud_project import CloudProject
from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.schemas.cloud_project import CloudProjectMemberResponse
from app.services.cloud_project_visibility import project_participant_ids
from app.services.cloud_projects.service import cloud_project_service
from app.services.collaboration_permissions import collaboration_permission_service
from app.services.collaboration_revocation import execution_authorized
from tests.api import test_collaboration_permission_contract as permission_contract
from tests.api.test_collaboration_permission_resources import make_execution
from tests.service_results import service_result

invite = permission_contract.invite
scope = permission_contract.scope


def _direct_grant(db, scope):
    return (
        db.query(ResourceMember)
        .filter_by(
            resource_type="CloudProject",
            resource_id=int(scope["project"]["id"]),
            entity_type="user",
            entity_id=str(scope["user"].id),
        )
        .one_or_none()
    )


def _pending_grant(db, scope, status, role="Maintainer"):
    grant = ResourceMember.create(
        resource_type="CloudProject",
        resource_id=int(scope["project"]["id"]),
        entity_id=str(scope["user"].id),
        role=role,
        status=status,
    )
    db.add(grant)
    db.commit()
    return grant


@pytest.mark.parametrize("status", [None, "pending", "rejected"])
def test_capability_only_update_never_creates_or_activates_direct_grant(
    test_client, test_db, scope, status
):
    invite(test_client, scope, "Developer")
    if status:
        _pending_grant(test_db, scope, status)
    pid, uid = scope["project"]["id"], scope["user"].id
    endpoint = f"/api/v1/cloud-projects/{pid}/members/{uid}"
    updated = test_client.patch(
        endpoint,
        headers=scope["owner"],
        json={"capability_description": "  Release checks  "},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["role"] == "Developer"
    assert updated.json()["direct_role"] is None
    assert updated.json()["inherited_role"] == "Developer"
    assert updated.json()["capability_description"] == "Release checks"
    grant = _direct_grant(test_db, scope)
    if status:
        assert grant.status == status
        assert grant.role == "Maintainer"
    else:
        assert grant is None
    # A later explicit role change preserves capability metadata.
    changed = test_client.patch(
        endpoint, headers=scope["owner"], json={"role": "Viewer"}
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["role"] == "Viewer"
    assert changed.json()["capability_description"] == "Release checks"
    assert _direct_grant(test_db, scope).status == "approved"


@pytest.mark.parametrize("status", ["pending", "rejected"])
def test_explicit_role_update_activates_existing_grant_for_inherited_user(
    test_client, test_db, scope, status
):
    invite(test_client, scope, "Viewer")
    grant = _pending_grant(test_db, scope, status)
    pid = scope["project"]["id"]
    response = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
        json={"role": "Developer"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["role"] == "Developer"
    assert response.json()["direct_role"] == "Developer"
    assert response.json()["inherited_role"] == "Viewer"
    assert response.json()["id"] == grant.id
    test_db.refresh(grant)
    assert grant.status == "approved"
    assert grant.role == "Developer"


@pytest.mark.parametrize(
    "space_role,direct_role", [("Viewer", "Maintainer"), ("Developer", "Viewer")]
)
def test_deleting_override_restores_inheritance_and_effective_eligibility(
    test_client, test_db, scope, space_role, direct_role
):
    invite(test_client, scope, space_role)
    invite(test_client, scope, direct_role, project=True)
    pid = scope["project"]["id"]
    removed = test_client.delete(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
    )
    assert removed.status_code == 204, removed.text
    assert _direct_grant(test_db, scope) is None
    project = test_db.get(CloudProject, pid)
    decision = collaboration_permission_service.check(
        test_db, scope["user"].id, "read", pid
    )
    assert decision.role.value == space_role
    roster = service_result(
        cloud_project_service.list_members,
        test_db,
        int(pid),
        scope["space"]["owner_user_id"],
        response_model=list[CloudProjectMemberResponse],
    )
    assert roster.status_code == 200, roster.text
    row = next(row for row in roster.json() if row["user_id"] == scope["user"].id)
    assert row["role"] == space_role
    assert row["direct_role"] is None
    assert row["inherited_role"] == space_role
    assert (
        scope["user"].id
        in project_participant_ids(test_db, project, required_role=BaseRole.Developer)
    ) == (space_role == "Developer")


@pytest.mark.parametrize("status", [None, "pending", "rejected"])
@pytest.mark.parametrize("public", [False, True])
def test_patch_cannot_invite_nonmember_or_public_visitor(
    test_client, test_db, scope, status, public
):
    pid = scope["project"]["id"]
    if status:
        _pending_grant(test_db, scope, status)
    if public:
        exposed = test_client.patch(
            f"/api/v1/cloud-projects/{pid}",
            headers=scope["owner"],
            json={"version": scope["project"]["version"], "visibility": "public"},
        )
        assert exposed.status_code == 200, exposed.text
    response = test_client.patch(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
        json={"role": "Maintainer"},
    )
    assert response.status_code == 404, response.text
    grant = _direct_grant(test_db, scope)
    assert (grant.status if grant else None) == status


def test_inherited_developer_cannot_promote_themselves(test_client, scope):
    invite(test_client, scope, "Developer")
    response = test_client.patch(
        f"/api/v1/cloud-projects/{scope['project']['id']}/members/{scope['user'].id}",
        headers=scope["member"],
        json={"role": "Maintainer"},
    )
    assert response.status_code == 403, response.text


def test_direct_viewer_downgrade_blocks_actual_assignment_and_creator_mutations(
    test_client, test_db, scope
):
    invite(test_client, scope, "Developer")
    pid = scope["project"]["id"]
    created = test_client.post(
        f"/api/v1/cloud-projects/{pid}/loop-items",
        headers=scope["member"],
        json={
            "title": "Creator does not bypass a Viewer override",
            "notify_assignee": False,
        },
    )
    assert created.status_code == 201, created.text
    issue = created.json()
    invite(test_client, scope, "Viewer", project=True)
    edited = test_client.patch(
        f"/api/v1/loop-items/{issue['id']}",
        headers=scope["member"],
        json={"version": issue["version"], "title": "Forbidden edit"},
    )
    assert edited.status_code == 403, edited.text
    endpoint = f"/api/v1/cloud-projects/{pid}/loop-items/{issue['id']}/assign"
    assignment = {
        "version": issue["version"],
        "assignee_type": "user",
        "assignee_id": str(scope["user"].id),
        "notify_assignee": False,
    }
    denied = test_client.post(endpoint, headers=scope["owner"], json=assignment)
    assert denied.status_code == 422, denied.text
    removed = test_client.delete(
        f"/api/v1/cloud-projects/{pid}/members/{scope['user'].id}",
        headers=scope["owner"],
    )
    assert removed.status_code == 204, removed.text
    accepted = test_client.post(endpoint, headers=scope["owner"], json=assignment)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["assignee_user_id"] == scope["user"].id


@pytest.mark.parametrize("initial", ["queued", "running"])
def test_direct_viewer_downgrade_revokes_work_without_faking_runtime_completion(
    test_client, test_db, scope, monkeypatch, initial
):
    invite(test_client, scope, "Developer")
    run, _, _ = make_execution(test_db, scope, initial)
    assert execution_authorized(test_db, run)
    cancellation = Mock()
    monkeypatch.setattr(
        "app.services.loop_item_executions.cancellation.request_execution_cancellations",
        cancellation,
    )
    response = test_client.patch(
        f"/api/v1/cloud-projects/{scope['project']['id']}/members/{scope['user'].id}",
        headers=scope["owner"],
        json={"role": "Viewer"},
    )
    assert response.status_code == 200, response.text
    test_db.refresh(run)
    assert not execution_authorized(test_db, run)
    assert run.status == ("cancel_requested" if initial == "running" else "cancelled")
    cancellation.assert_called_once()

"""Workspace credentials remain independent of the administrator's account."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.user import User
from app.services.workspaces.runner_registration import (
    register_runner,
    revoke_runner,
    verify_runner_token,
)


def test_workspace_machine_identity_and_revocation(test_db, test_user, monkeypatch):
    workspace = Kind(
        kind="CollaborationWorkspace",
        name="runner-space",
        namespace="default",
        user_id=test_user.id,
        is_active=True,
        json={"spec": {}, "metadata": {"name": "runner-space"}},
    )
    test_db.add(workspace)
    test_db.flush()
    from app.models.resource_member import ResourceMember

    test_db.add(
        ResourceMember(
            resource_type="Workspace",
            resource_id=workspace.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role="Owner",
            status="approved",
        )
    )
    test_db.commit()
    first = register_runner(test_db, workspace.id, test_user.id, "server-a")
    second = register_runner(test_db, workspace.id, test_user.id, "server-b")
    device = verify_runner_token(test_db, first["token"])
    assert device.user_id != test_user.id
    assert device.user_id == verify_runner_token(test_db, second["token"]).user_id
    assert first["token"] not in str(device.json)
    machine = test_db.get(User, device.user_id)
    assert machine.auth_source == "runner" and not machine.is_active
    assert verify_runner_token(test_db, first["token"] + "tampered") is None
    revoke_runner(test_db, workspace.id, test_user.id, device.id)
    assert verify_runner_token(test_db, first["token"]) is None
    assert verify_runner_token(test_db, second["token"]) is not None


def test_workspace_registration_requires_admin(test_db, test_user, monkeypatch):
    def forbidden(*args):
        raise HTTPException(403, "Maintainer required")

    monkeypatch.setattr(
        "app.services.workspaces.runner_registration.require_workspace_role", forbidden
    )
    with pytest.raises(HTTPException) as error:
        register_runner(test_db, 77, test_user.id, "server")
    assert error.value.status_code == 403

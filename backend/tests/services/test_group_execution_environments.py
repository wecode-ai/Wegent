"""Group Device consent requires both group management and device ownership."""

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.cloud_projects.service import cloud_project_service
from tests.services.test_thread_participation import make_group, person


def device(db, user, name="owned-device"):
    row = Kind(
        user_id=user.id,
        kind="Device",
        name=name,
        namespace="default",
        is_active=True,
        json={"spec": {"deviceType": "app", "appDeviceId": name}},
    )
    db.add(row)
    db.flush()
    return row


@pytest.fixture(autouse=True)
def online(monkeypatch):
    monkeypatch.setattr(
        "app.services.group_execution_environments.execution_environment_statuses",
        AsyncMock(side_effect=lambda devices: {row.id: "online" for row in devices}),
    )


def grants(db):
    return db.query(ResourceMember).filter_by(resource_type="Device").all()


@pytest.mark.asyncio
async def test_group_device_add_is_explicit_scoped_and_does_not_create_project_grants(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    owned = device(test_db, test_user)
    assert grants(test_db) == []
    result = await cloud_project_service.add_execution_environment(
        test_db, int(group.id), owned.id, test_user.id
    )
    assert result["device_id"] == owned.id
    assert result["workspace_id"] == group.id
    assert result["can_use"] is True
    assert result["device_key"] == f"app-record-{owned.id}"
    assert [(row.entity_type, row.entity_id, row.role) for row in grants(test_db)] == [
        ("chat_group", group.id, "Developer")
    ]
    with pytest.raises(HTTPException) as duplicate:
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), owned.id, test_user.id
        )
    assert duplicate.value.status_code == 409
    assert len(grants(test_db)) == 1


@pytest.mark.asyncio
async def test_group_admin_cannot_share_another_users_device(test_db, test_user):
    other = person(test_db, "foreign-device-owner")
    group = make_group(test_db, test_user, [])
    foreign = device(test_db, other)
    with pytest.raises(HTTPException) as denied:
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), foreign.id, test_user.id
        )
    assert denied.value.status_code == 404
    assert grants(test_db) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["Developer", "Viewer"])
async def test_device_ownership_does_not_grant_group_administration(
    test_db, test_user, role
):
    member = person(test_db, "device-member")
    group = make_group(test_db, test_user, [(member, role)])
    owned = device(test_db, member)
    with pytest.raises(HTTPException) as denied:
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), owned.id, member.id
        )
    assert denied.value.status_code == 403
    assert grants(test_db) == []


@pytest.mark.asyncio
async def test_group_revocation_is_exact_and_preserves_other_group_consent(
    test_db, test_user
):
    first = make_group(test_db, test_user, [])
    first.project_key = "FIRST"
    test_db.flush()
    second = make_group(test_db, test_user, [])
    owned = device(test_db, test_user)
    for group in (first, second):
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), owned.id, test_user.id
        )
    cloud_project_service.remove_execution_environment(
        test_db, int(first.id), owned.id, test_user.id
    )
    assert [row.entity_id for row in grants(test_db)] == [second.id]
    assert test_db.get(Kind, owned.id).is_active is True
    with pytest.raises(HTTPException) as missing:
        cloud_project_service.remove_execution_environment(
            test_db, int(first.id), owned.id, test_user.id
        )
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_archived_group_and_inactive_device_cannot_be_authorized(
    test_db, test_user
):
    group = make_group(test_db, test_user, [])
    owned = device(test_db, test_user)
    group.status = "archived"
    test_db.flush()
    with pytest.raises(HTTPException) as archived:
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), owned.id, test_user.id
        )
    assert archived.value.status_code == 409
    group.status = "active"
    owned.is_active = False
    test_db.flush()
    with pytest.raises(HTTPException) as inactive:
        await cloud_project_service.add_execution_environment(
            test_db, int(group.id), owned.id, test_user.id
        )
    assert inactive.value.status_code == 404
    assert grants(test_db) == []

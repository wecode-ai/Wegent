# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(test_db: Session, username: str, email: str) -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-password"),
        email=email,
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_group(test_db: Session, owner: User, name: str = "test-group") -> Namespace:
    group = Namespace(
        name=name,
        display_name="Test Group",
        owner_user_id=owner.id,
        visibility="internal",
        description="test",
        level="group",
        is_active=True,
    )
    test_db.add(group)
    test_db.commit()
    test_db.refresh(group)
    return group


def _add_member(
    test_db: Session, group: Namespace, user: User, role: str
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        user_id=user.id,
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=group.owner_user_id,
        share_link_id=0,
        reviewed_by_user_id=group.owner_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def test_batch_update_group_member_roles_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user)
    _add_member(test_db, group, test_user, "Owner")
    developer = _create_user(test_db, "developer", "developer@example.com")
    reporter = _create_user(test_db, "reporter", "reporter@example.com")
    _add_member(test_db, group, developer, "Developer")
    _add_member(test_db, group, reporter, "Reporter")

    response = test_client.put(
        f"/api/groups/{group.name}/members/batch/roles",
        headers=_auth_header(test_token),
        json={
            "updates": [
                {"user_id": developer.id, "role": "Maintainer"},
                {"user_id": reporter.id, "role": "Developer"},
            ]
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_updated"] == 2
    assert payload["total_failed"] == 0
    assert [item["role"] for item in payload["updated_members"]] == [
        "Maintainer",
        "Developer",
    ]

    refreshed_developer = test_db.get(User, developer.id)
    refreshed_reporter = test_db.get(User, reporter.id)
    developer_member = next(
        member
        for member in refreshed_developer.resource_members
        if member.resource_id == group.id
    )
    reporter_member = next(
        member
        for member in refreshed_reporter.resource_members
        if member.resource_id == group.id
    )
    assert developer_member.role == "Maintainer"
    assert reporter_member.role == "Developer"


def test_update_group_member_role_rejects_demoting_current_group_owner(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="owner-role-guard-group")
    _add_member(test_db, group, test_user, "Owner")
    maintainer = _create_user(test_db, "maintainer", "maintainer@example.com")
    _add_member(test_db, group, maintainer, "Maintainer")

    response = test_client.put(
        f"/api/groups/{group.name}/members/{test_user.id}",
        headers=_auth_header(test_token),
        json={"role": "Maintainer"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Cannot change role of the current group owner. Transfer ownership first."
    )
    assert response.json()["error_code"] == "GROUP_OWNER_ROLE_CHANGE_REQUIRES_TRANSFER"

    test_db.refresh(group)
    owner_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=test_user.id,
        )
        .one()
    )
    promoted_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=maintainer.id,
        )
        .one()
    )
    assert group.owner_user_id == test_user.id
    assert owner_member.role == "Owner"
    assert promoted_member.role == "Maintainer"


def test_batch_update_group_member_roles_rejects_demoting_current_group_owner(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="owner-transition-group")
    _add_member(test_db, group, test_user, "Owner")
    maintainer = _create_user(
        test_db, "batch-maintainer", "batch-maintainer@example.com"
    )
    _add_member(test_db, group, maintainer, "Maintainer")

    response = test_client.put(
        f"/api/groups/{group.name}/members/batch/roles",
        headers=_auth_header(test_token),
        json={
            "updates": [
                {"user_id": test_user.id, "role": "Maintainer"},
                {"user_id": maintainer.id, "role": "Owner"},
            ]
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_updated"] == 1
    assert payload["total_failed"] == 1
    assert payload["updated_members"][0]["user_id"] == maintainer.id
    assert payload["updated_members"][0]["role"] == "Owner"
    assert payload["failed_updates"] == [
        {
            "user_id": test_user.id,
            "role": "Maintainer",
            "error": "Cannot change role of the current group owner. Transfer ownership first.",
            "error_code": "GROUP_OWNER_ROLE_CHANGE_REQUIRES_TRANSFER",
        }
    ]

    test_db.refresh(group)
    owner_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=test_user.id,
        )
        .one()
    )
    promoted_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=maintainer.id,
        )
        .one()
    )
    assert group.owner_user_id == test_user.id
    assert owner_member.role == "Owner"
    assert promoted_member.role == "Owner"


def test_batch_update_group_member_roles_returns_partial_failures(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="partial-failure-group")
    _add_member(test_db, group, test_user, "Owner")
    developer = _create_user(test_db, "partial-dev", "partial-dev@example.com")
    _add_member(test_db, group, developer, "Developer")

    response = test_client.put(
        f"/api/groups/{group.name}/members/batch/roles",
        headers=_auth_header(test_token),
        json={
            "updates": [
                {"user_id": developer.id, "role": "Maintainer"},
                {"user_id": 999999, "role": "Reporter"},
                {"user_id": test_user.id, "role": "Maintainer"},
            ]
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total_updated"] == 1
    assert payload["total_failed"] == 2
    assert payload["updated_members"][0]["user_id"] == developer.id
    assert payload["failed_updates"][0]["user_id"] == 999999
    assert payload["failed_updates"][0]["error"] == "Member not found"
    assert payload["failed_updates"][0]["error_code"] is None
    assert payload["failed_updates"][1]["user_id"] == test_user.id
    assert (
        payload["failed_updates"][1]["error"]
        == "Cannot change role of the current group owner. Transfer ownership first."
    )
    assert (
        payload["failed_updates"][1]["error_code"]
        == "GROUP_OWNER_ROLE_CHANGE_REQUIRES_TRANSFER"
    )

    developer_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=developer.id,
        )
        .one()
    )
    owner_member = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Namespace",
            resource_id=group.id,
            user_id=test_user.id,
        )
        .one()
    )
    assert developer_member.role == "Maintainer"
    assert owner_member.role == "Owner"

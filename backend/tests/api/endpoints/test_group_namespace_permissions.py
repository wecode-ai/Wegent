# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(test_db: Session, username: str, role: str = "user") -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-password"),
        email=f"{username}@example.com",
        is_active=True,
        git_info=None,
        role=role,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_group(
    test_db: Session, owner: User, name: str = "ns-owner-group"
) -> Namespace:
    group = Namespace(
        name=name,
        display_name="Namespace Owner Group",
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


def test_maintainer_cannot_update_group_information(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user")
    maintainer = _create_user(test_db, "maintainer-user")
    group = _create_group(test_db, owner, "owner-only-settings-group")
    _add_member(test_db, group, owner, "Owner")
    _add_member(test_db, group, maintainer, "Maintainer")
    maintainer_token = create_access_token(data={"sub": maintainer.user_name})

    response = test_client.put(
        f"/api/groups/{group.name}",
        headers=_auth_header(maintainer_token),
        json={"description": "updated by maintainer"},
    )

    assert response.status_code == 403


def test_maintainer_cannot_add_group_member(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-2")
    maintainer = _create_user(test_db, "maintainer-user-2")
    target = _create_user(test_db, "target-user")
    group = _create_group(test_db, owner, "owner-only-member-group")
    _add_member(test_db, group, owner, "Owner")
    _add_member(test_db, group, maintainer, "Maintainer")
    maintainer_token = create_access_token(data={"sub": maintainer.user_name})

    response = test_client.post(
        f"/api/groups/{group.name}/members",
        headers=_auth_header(maintainer_token),
        json={"user_id": target.id, "role": "Developer"},
    )

    assert response.status_code == 403


def test_admin_can_update_group_information_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-3")
    admin = _create_user(test_db, "admin-user", role="admin")
    group = _create_group(test_db, owner, "admin-override-group")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.put(
        f"/api/groups/{group.name}",
        headers=_auth_header(admin_token),
        json={"description": "updated by admin"},
    )

    assert response.status_code == 200
    assert response.json()["description"] == "updated by admin"


def test_admin_can_delete_group_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-delete")
    admin = _create_user(test_db, "admin-user-delete", role="admin")
    group = _create_group(test_db, owner, "admin-delete-group")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.delete(
        f"/api/groups/{group.name}",
        headers=_auth_header(admin_token),
    )

    assert response.status_code == 204
    assert (
        test_db.query(Namespace)
        .filter(Namespace.name == group.name, Namespace.is_active == True)
        .first()
        is None
    )


def test_admin_transfer_ownership_demotes_previous_owner(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-transfer")
    admin = _create_user(test_db, "admin-user-transfer", role="admin")
    maintainer = _create_user(test_db, "maintainer-user-transfer")
    group = _create_group(test_db, owner, "admin-transfer-group")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    _add_member(test_db, group, maintainer, "Maintainer")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.post(
        f"/api/groups/{group.name}/transfer-ownership",
        headers=_auth_header(admin_token),
        params={"new_owner_user_id": maintainer.id},
    )

    assert response.status_code == 200

    test_db.refresh(group)
    assert group.owner_user_id == maintainer.id

    previous_owner_member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == group.id,
            ResourceMember.user_id == owner.id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )
    assert previous_owner_member is not None
    assert previous_owner_member.role == "Maintainer"

    new_owner_member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == group.id,
            ResourceMember.user_id == maintainer.id,
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .first()
    )
    assert new_owner_member is not None
    assert new_owner_member.role == "Owner"


def test_admin_cannot_update_regular_group_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-regular-update")
    admin = _create_user(test_db, "admin-user-regular-update", role="admin")
    group = _create_group(test_db, owner, "regular-admin-update-group")
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.put(
        f"/api/groups/{group.name}",
        headers=_auth_header(admin_token),
        json={"description": "updated by admin"},
    )

    assert response.status_code == 403


def test_admin_cannot_delete_regular_group_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "owner-user-regular-delete")
    admin = _create_user(test_db, "admin-user-regular-delete", role="admin")
    group = _create_group(test_db, owner, "regular-admin-delete-group")
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.delete(
        f"/api/groups/{group.name}",
        headers=_auth_header(admin_token),
    )

    assert response.status_code == 403


def test_non_admin_member_can_list_organization_group(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "org-owner")
    developer = _create_user(test_db, "org-developer")
    group = _create_group(test_db, owner, "company-namespace")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    _add_member(test_db, group, developer, "Developer")
    developer_token = create_access_token(data={"sub": developer.user_name})

    response = test_client.get(
        "/api/groups?page=1&limit=100",
        headers=_auth_header(developer_token),
    )

    assert response.status_code == 200
    assert any(item["name"] == group.name for item in response.json()["items"])


def test_admin_can_list_organization_group_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "org-owner-admin-visible")
    admin = _create_user(test_db, "org-admin-visible", role="admin")
    group = _create_group(test_db, owner, "company-visible-admin")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.get(
        "/api/groups?page=1&limit=100",
        headers=_auth_header(admin_token),
    )

    assert response.status_code == 200
    matching_group = next(
        item for item in response.json()["items"] if item["name"] == group.name
    )
    assert matching_group["my_role"] == "Owner"


def test_admin_can_get_organization_group_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "org-owner-admin-detail")
    admin = _create_user(test_db, "org-admin-detail", role="admin")
    group = _create_group(test_db, owner, "company-detail-admin")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.get(
        f"/api/groups/{group.name}",
        headers=_auth_header(admin_token),
    )

    assert response.status_code == 200
    assert response.json()["name"] == group.name
    assert response.json()["my_role"] == "Owner"


def test_admin_can_list_organization_group_members_without_membership(
    test_client: TestClient, test_db: Session
) -> None:
    owner = _create_user(test_db, "org-owner-admin-members")
    developer = _create_user(test_db, "org-dev-admin-members")
    admin = _create_user(test_db, "org-admin-members", role="admin")
    group = _create_group(test_db, owner, "company-members-admin")
    group.level = "organization"
    test_db.commit()
    _add_member(test_db, group, owner, "Owner")
    _add_member(test_db, group, developer, "Developer")
    admin_token = create_access_token(data={"sub": admin.user_name})

    response = test_client.get(
        f"/api/groups/{group.name}/members",
        headers=_auth_header(admin_token),
    )

    assert response.status_code == 200
    member_user_ids = {item["user_id"] for item in response.json()}
    assert member_user_ids == {owner.id, developer.id}

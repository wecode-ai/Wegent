# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
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
        entity_type="user",
        entity_id=str(user.id),
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

    developer_member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == group.id,
            ResourceMember.entity_id == str(developer.id),
        )
        .first()
    )
    reporter_member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == group.id,
            ResourceMember.entity_id == str(reporter.id),
        )
        .first()
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


def test_list_members_excludes_entity_rows(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-filter-group")
    _add_member(test_db, group, test_user, "Owner")

    # Add entity-type member directly to DB
    entity_member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="org_department",
        entity_id="dept_123",
        role="Maintainer",
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(entity_member)
    test_db.commit()

    response = test_client.get(
        f"/api/groups/{group.name}/members",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    user_ids = [m["user_id"] for m in payload]
    assert test_user.id in user_ids
    assert 0 not in user_ids  # entity members have user_id=0
    assert len(payload) == 1  # only the owner, no entity rows


def test_list_entity_members_returns_entity_rows(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-list-group")
    _add_member(test_db, group, test_user, "Owner")

    entity_member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="org_department",
        entity_id="dept_456",
        role="Developer",
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
        entity_display_name="Engineering",
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(entity_member)
    test_db.commit()

    response = test_client.get(
        f"/api/groups/{group.name}/entity-members",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 1
    assert payload[0]["entity_type"] == "org_department"
    assert payload[0]["entity_id"] == "dept_456"
    assert payload[0]["role"] == "Developer"
    assert payload[0]["entity_display_name"] == "Engineering"


def test_add_entity_member_requires_owner(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-auth-group")
    _add_member(test_db, group, test_user, "Owner")
    developer = _create_user(test_db, "developer", "dev@example.com")
    _add_member(test_db, group, developer, "Developer")
    dev_token = create_access_token(data={"sub": developer.user_name})

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"org_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(dev_token),
            json={
                "entity_type": "org_department",
                "entity_id": "dept_1",
                "role": "Reporter",
            },
        )

    assert response.status_code == 403
    assert "Only Owners can add entity members" in response.json()["detail"]


def test_add_entity_member_rejects_unregistered_entity_type(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-type-group")
    _add_member(test_db, group, test_user, "Owner")

    with patch(
        "app.api.endpoints.groups.get_all_entity_types", return_value={"org_department"}
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(test_token),
            json={
                "entity_type": "unknown_type",
                "entity_id": "dept_1",
                "role": "Reporter",
            },
        )

    assert response.status_code == 400
    assert "Unknown or unsupported entity type" in response.json()["detail"]


def test_add_entity_member_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-add-group")
    _add_member(test_db, group, test_user, "Owner")

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"org_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(test_token),
            json={
                "entity_type": "org_department",
                "entity_id": "dept_789",
                "role": "Maintainer",
                "entity_display_name": "Product Team",
            },
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["entity_type"] == "org_department"
    assert payload["entity_id"] == "dept_789"
    assert payload["role"] == "Maintainer"
    assert payload["entity_display_name"] == "Product Team"
    assert payload["invited_by_user_id"] == test_user.id


def test_delete_entity_member_requires_owner(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-del-auth-group")
    _add_member(test_db, group, test_user, "Owner")
    developer = _create_user(test_db, "dev-del", "devdel@example.com")
    _add_member(test_db, group, developer, "Developer")
    dev_token = create_access_token(data={"sub": developer.user_name})

    response = test_client.delete(
        f"/api/groups/{group.name}/entity-members/org_department/dept_1",
        headers=_auth_header(dev_token),
    )

    assert response.status_code == 403
    assert "Only Owners can remove entity members" in response.json()["detail"]


def test_delete_entity_member_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-del-group")
    _add_member(test_db, group, test_user, "Owner")

    entity_member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="org_department",
        entity_id="dept_to_delete",
        role="Reporter",
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(entity_member)
    test_db.commit()

    response = test_client.delete(
        f"/api/groups/{group.name}/entity-members/org_department/dept_to_delete",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 204

    remaining = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == group.id,
            ResourceMember.entity_type == "org_department",
            ResourceMember.entity_id == "dept_to_delete",
        )
        .first()
    )
    assert remaining is None


def test_delete_entity_member_rejects_user_entity_type(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-del-user-group")
    _add_member(test_db, group, test_user, "Owner")

    # Attempt to delete a user member via entity-members endpoint
    response = test_client.delete(
        f"/api/groups/{group.name}/entity-members/user/{test_user.id}",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 400
    assert "user or namespace members" in response.json()["detail"]


def test_add_entity_member_rejects_duplicate(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-dup-group")
    _add_member(test_db, group, test_user, "Owner")

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"org_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        # First add succeeds
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(test_token),
            json={
                "entity_type": "org_department",
                "entity_id": "dept_dup",
                "role": "Maintainer",
            },
        )
        assert response.status_code == 201

        # Second add with same entity should fail with 409
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(test_token),
            json={
                "entity_type": "org_department",
                "entity_id": "dept_dup",
                "role": "Developer",
            },
        )
        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]


def test_update_entity_member_role_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-update-group")
    _add_member(test_db, group, test_user, "Owner")

    entity_member = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="org_department",
        entity_id="dept_to_update",
        role="Reporter",
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(entity_member)
    test_db.commit()

    response = test_client.put(
        f"/api/groups/{group.name}/entity-members/org_department/dept_to_update",
        headers=_auth_header(test_token),
        json={"role": "Maintainer"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["entity_type"] == "org_department"
    assert data["entity_id"] == "dept_to_update"
    assert data["role"] == "Maintainer"


def test_update_entity_member_role_requires_owner(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-update-auth-group")
    _add_member(test_db, group, test_user, "Owner")
    developer = _create_user(test_db, "dev-update", "devupdate@example.com")
    _add_member(test_db, group, developer, "Developer")
    dev_token = create_access_token(data={"sub": developer.user_name})

    response = test_client.put(
        f"/api/groups/{group.name}/entity-members/org_department/dept_1",
        headers=_auth_header(dev_token),
        json={"role": "Maintainer"},
    )

    assert response.status_code == 403
    assert "Only Owners can update entity member roles" in response.json()["detail"]


def test_update_entity_member_role_not_found(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    group = _create_group(test_db, test_user, name="entity-update-nf-group")
    _add_member(test_db, group, test_user, "Owner")

    response = test_client.put(
        f"/api/groups/{group.name}/entity-members/org_department/nonexistent",
        headers=_auth_header(test_token),
        json={"role": "Maintainer"},
    )

    assert response.status_code == 404
    assert "Entity member not found" in response.json()["detail"]


def test_batch_add_entity_members_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test successful batch addition of entity members."""
    group = _create_group(test_db, test_user, name="batch-add-group")
    _add_member(test_db, group, test_user, "Owner")

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"mock_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members/batch",
            headers=_auth_header(test_token),
            json={
                "members": [
                    {
                        "entity_type": "mock_department",
                        "entity_id": "dept_1",
                        "role": "Reporter",
                    },
                    {
                        "entity_type": "mock_department",
                        "entity_id": "dept_2",
                        "role": "Developer",
                    },
                ]
            },
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["total"] == 2
    assert payload["success_count"] == 2
    assert payload["failed_count"] == 0
    assert len(payload["succeeded"]) == 2


def test_batch_add_entity_members_partial_failure(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test batch addition with some already existing members."""
    group = _create_group(test_db, test_user, name="batch-partial-group")
    _add_member(test_db, group, test_user, "Owner")

    # Pre-add one entity member
    existing = ResourceMember(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="mock_department",
        entity_id="dept_1",
        role="Viewer",
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=test_user.id,
    )
    test_db.add(existing)
    test_db.commit()

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"mock_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members/batch",
            headers=_auth_header(test_token),
            json={
                "members": [
                    {
                        "entity_type": "mock_department",
                        "entity_id": "dept_1",
                        "role": "Reporter",
                    },
                    {
                        "entity_type": "mock_department",
                        "entity_id": "dept_2",
                        "role": "Developer",
                    },
                ]
            },
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["total"] == 2
    assert payload["success_count"] == 1
    assert payload["failed_count"] == 1
    assert len(payload["succeeded"]) == 1
    assert len(payload["failed"]) == 1
    assert payload["failed"][0]["entity_id"] == "dept_1"


def test_batch_add_entity_members_exceed_limit(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test batch addition exceeding group entity member limit."""
    group = _create_group(test_db, test_user, name="batch-limit-group")
    _add_member(test_db, group, test_user, "Owner")

    # Add 30 entity members to reach the limit
    for i in range(30):
        member = ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="mock_department",
            entity_id=f"dept_{i}",
            role="Viewer",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_user.id,
        )
        test_db.add(member)
    test_db.commit()

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"mock_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members/batch",
            headers=_auth_header(test_token),
            json={
                "members": [
                    {
                        "entity_type": "mock_department",
                        "entity_id": f"dept_new_{i}",
                        "role": "Reporter",
                    }
                    for i in range(5)
                ]
            },
        )

    assert response.status_code == 400
    assert "limit reached" in response.json()["detail"].lower()


def test_add_entity_member_exceed_limit(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test single addition when group entity member limit reached."""
    group = _create_group(test_db, test_user, name="single-limit-group")
    _add_member(test_db, group, test_user, "Owner")

    # Add 30 entity members to reach the limit
    for i in range(30):
        member = ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="mock_department",
            entity_id=f"dept_{i}",
            role="Viewer",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_user.id,
        )
        test_db.add(member)
    test_db.commit()

    with (
        patch(
            "app.api.endpoints.groups.get_all_entity_types",
            return_value={"mock_department"},
        ),
        patch(
            "app.api.endpoints.groups.get_entity_resolver",
            return_value=Mock(validate_entity_id=lambda db, eid: True),
        ),
    ):
        response = test_client.post(
            f"/api/groups/{group.name}/entity-members",
            headers=_auth_header(test_token),
            json={
                "entity_type": "mock_department",
                "entity_id": "dept_new",
                "role": "Reporter",
            },
        )

    assert response.status_code == 400
    assert "limit reached" in response.json()["detail"].lower()


def test_get_group_with_children_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test GET /groups/{name}/with-children returns group and its subgroups."""
    parent_group = _create_group(test_db, test_user, name="parent-group")
    _add_member(test_db, parent_group, test_user, "Owner")

    child_group = Namespace(
        name="parent-group/child",
        display_name="Child Group",
        owner_user_id=test_user.id,
        visibility="internal",
        description="child",
        level="group",
        is_active=True,
    )
    test_db.add(child_group)
    test_db.commit()
    _add_member(test_db, child_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "parent-group"
    assert payload["group"]["my_role"] == "Owner"
    assert len(payload["children"]) == 1
    assert payload["children"][0]["name"] == "parent-group/child"
    assert payload["children"][0]["my_role"] == "Owner"


def test_get_group_with_children_with_api_key_x_header(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test with-children endpoint supports X-API-Key header."""
    raw_key, _ = test_api_key
    parent_group = _create_group(test_db, test_user, name="apikey-parent")
    _add_member(test_db, parent_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "apikey-parent"


def test_get_group_with_children_with_api_key_bearer(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test with-children endpoint supports Authorization: Bearer API Key."""
    raw_key, _ = test_api_key
    parent_group = _create_group(test_db, test_user, name="apikey-bearer-parent")
    _add_member(test_db, parent_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers={"Authorization": f"Bearer {raw_key}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "apikey-bearer-parent"


def test_list_members_with_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test members endpoint supports API Key authentication."""
    raw_key, _ = test_api_key
    group = _create_group(test_db, test_user, name="apikey-members-group")
    _add_member(test_db, group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{group.name}/members",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert payload[0]["user_id"] == test_user.id
    assert payload[0]["role"] == "Owner"


def test_get_group_with_children_non_member_forbidden(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test non-member gets 403 on with-children endpoint."""
    other_user = _create_user(test_db, "other", "other@example.com")
    parent_group = _create_group(test_db, other_user, name="forbidden-parent")
    _add_member(test_db, parent_group, other_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not a member of this group"


def test_get_group_with_children_not_found(
    test_client: TestClient, test_user: User, test_token: str
):
    """Test 404 on with-children endpoint for non-existent group."""
    response = test_client.get(
        "/api/groups/non-existent-group/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Group not found"


def test_get_child_groups_sql_like_escape(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test SQL LIKE wildcard characters in parent_name are escaped."""
    parent_group = _create_group(test_db, test_user, name="test_underscore")
    _add_member(test_db, parent_group, test_user, "Owner")

    decoy_group = _create_group(test_db, test_user, name="testAunderscore")
    _add_member(test_db, decoy_group, test_user, "Owner")

    real_child = Namespace(
        name="test_underscore/child",
        display_name="Real Child",
        owner_user_id=test_user.id,
        visibility="internal",
        description="child",
        level="group",
        is_active=True,
    )
    test_db.add(real_child)
    test_db.commit()
    _add_member(test_db, real_child, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "test_underscore"
    children_names = [c["name"] for c in payload["children"]]
    assert "test_underscore/child" in children_names
    assert "testAunderscore" not in children_names


def test_get_group_with_children_success(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test GET /groups/{name}/with-children returns group and its subgroups."""
    parent_group = _create_group(test_db, test_user, name="parent-group")
    _add_member(test_db, parent_group, test_user, "Owner")

    child_group = Namespace(
        name="parent-group/child",
        display_name="Child Group",
        owner_user_id=test_user.id,
        visibility="internal",
        description="child",
        level="group",
        is_active=True,
    )
    test_db.add(child_group)
    test_db.commit()
    _add_member(test_db, child_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "parent-group"
    assert payload["group"]["my_role"] == "Owner"
    assert len(payload["children"]) == 1
    assert payload["children"][0]["name"] == "parent-group/child"
    assert payload["children"][0]["my_role"] == "Owner"


def test_get_group_with_children_with_api_key_x_header(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test with-children endpoint supports X-API-Key header."""
    raw_key, _ = test_api_key
    parent_group = _create_group(test_db, test_user, name="apikey-parent")
    _add_member(test_db, parent_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "apikey-parent"


def test_get_group_with_children_with_api_key_bearer(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test with-children endpoint supports Authorization: Bearer API Key."""
    raw_key, _ = test_api_key
    parent_group = _create_group(test_db, test_user, name="apikey-bearer-parent")
    _add_member(test_db, parent_group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers={"Authorization": f"Bearer {raw_key}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "apikey-bearer-parent"


def test_list_members_with_api_key(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_api_key: tuple[str, object],
):
    """Test members endpoint supports API Key authentication."""
    raw_key, _ = test_api_key
    group = _create_group(test_db, test_user, name="apikey-members-group")
    _add_member(test_db, group, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{group.name}/members",
        headers={"X-API-Key": raw_key},
    )

    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert payload[0]["user_id"] == test_user.id
    assert payload[0]["role"] == "Owner"


def test_get_group_with_children_non_member_forbidden(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test non-member gets 403 on with-children endpoint."""
    other_user = _create_user(test_db, "other", "other@example.com")
    parent_group = _create_group(test_db, other_user, name="forbidden-parent")
    _add_member(test_db, parent_group, other_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "You are not a member of this group"


def test_get_group_with_children_not_found(
    test_client: TestClient, test_user: User, test_token: str
):
    """Test 404 on with-children endpoint for non-existent group."""
    response = test_client.get(
        "/api/groups/non-existent-group/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Group not found"


def test_get_child_groups_sql_like_escape(
    test_client: TestClient, test_db: Session, test_user: User, test_token: str
):
    """Test SQL LIKE wildcard characters in parent_name are escaped."""
    parent_group = _create_group(test_db, test_user, name="test_underscore")
    _add_member(test_db, parent_group, test_user, "Owner")

    decoy_group = _create_group(test_db, test_user, name="testAunderscore")
    _add_member(test_db, decoy_group, test_user, "Owner")

    real_child = Namespace(
        name="test_underscore/child",
        display_name="Real Child",
        owner_user_id=test_user.id,
        visibility="internal",
        description="child",
        level="group",
        is_active=True,
    )
    test_db.add(real_child)
    test_db.commit()
    _add_member(test_db, real_child, test_user, "Owner")

    response = test_client.get(
        f"/api/groups/{parent_group.name}/with-children",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["group"]["name"] == "test_underscore"
    children_names = [c["name"] for c in payload["children"]]
    assert "test_underscore/child" in children_names
    assert "testAunderscore" not in children_names

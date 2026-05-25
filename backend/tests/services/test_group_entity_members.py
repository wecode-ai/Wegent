# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for group entity member functions and effective role resolution."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.namespace import GroupRole
from app.services.group_member_helper import (
    create_group_entity_member,
    delete_group_entity_member,
    get_group_all_members,
    get_group_entity_members,
    get_user_groups_with_roles,
    iter_user_groups_with_roles,
    update_group_entity_member_role,
)
from app.services.group_permission import (
    check_group_permission,
    get_effective_role_in_group,
    get_effective_roles_in_groups,
    get_restricted_analyst_groups,
    get_user_groups,
)
from app.services.share.external_entity_resolver import register_entity_resolver
from tests.utils.mock_resolver import MockDepartmentResolver, cleanup_resolvers


def _create_user(test_db: Session, username: str) -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-password"),
        email=f"{username}@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_group(test_db: Session, owner: User, name: str) -> Namespace:
    group = Namespace(
        name=name,
        display_name=name,
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


def _add_user_member(
    test_db: Session, group: Namespace, user: User, role: str
) -> ResourceMember:
    member = ResourceMember.create(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=group.owner_user_id,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


class TestCreateGroupEntityMember:
    """Tests for create_group_entity_member."""

    def test_creates_entity_member_with_correct_fields(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")

        member = create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
            entity_display_name="Engineering",
            invited_by_user_id=owner.id,
        )

        assert member is not None
        assert member.resource_type == "Namespace"
        assert member.resource_id == group.id
        assert member.entity_type == "org_department"
        assert member.entity_id == "dept_123"
        assert member.role == "Maintainer"
        assert member.entity_display_name == "Engineering"
        assert member.status == MemberStatus.APPROVED.value
        assert member.user_id == 0

    def test_returns_none_for_nonexistent_group(self, test_db: Session):
        result = create_group_entity_member(
            test_db,
            group_name="nonexistent",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
        )
        assert result is None


class TestGetGroupEntityMembers:
    """Tests for get_group_entity_members."""

    def test_returns_only_non_user_members(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        user_member = _create_user(test_db, "member")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, user_member, "Reporter")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
        )

        entity_members = get_group_entity_members(test_db, "test-group")

        assert len(entity_members) == 1
        assert entity_members[0].entity_type == "org_department"
        assert entity_members[0].entity_id == "dept_123"

    def test_returns_empty_list_for_group_with_no_entity_members(
        self, test_db: Session
    ):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")

        entity_members = get_group_entity_members(test_db, "test-group")

        assert entity_members == []

    def test_returns_empty_list_for_nonexistent_group(self, test_db: Session):
        entity_members = get_group_entity_members(test_db, "nonexistent")
        assert entity_members == []


class TestDeleteGroupEntityMember:
    """Tests for delete_group_entity_member."""

    def test_deletes_existing_entity_member(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
        )

        deleted = delete_group_entity_member(
            test_db, "test-group", "org_department", "dept_123"
        )

        assert deleted is True
        assert get_group_entity_members(test_db, "test-group") == []

    def test_returns_false_for_nonexistent_member(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")

        deleted = delete_group_entity_member(
            test_db, "test-group", "org_department", "dept_999"
        )

        assert deleted is False


class TestUpdateGroupEntityMemberRole:
    """Tests for update_group_entity_member_role."""

    def test_updates_existing_entity_member_role(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
        )

        updated = update_group_entity_member_role(
            test_db, "test-group", "org_department", "dept_123", "Developer"
        )

        assert updated is not None
        assert updated.role == "Developer"
        # Verify persisted
        members = get_group_entity_members(test_db, "test-group")
        assert len(members) == 1
        assert members[0].role == "Developer"

    def test_returns_none_for_nonexistent_member(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        _create_group(test_db, owner, "test-group")

        result = update_group_entity_member_role(
            test_db, "test-group", "org_department", "dept_999", "Developer"
        )

        assert result is None

    def test_returns_none_for_nonexistent_group(self, test_db: Session):
        result = update_group_entity_member_role(
            test_db, "nonexistent", "org_department", "dept_123", "Developer"
        )
        assert result is None


class TestGetGroupAllMembers:
    """Tests for get_group_all_members."""

    def test_returns_user_and_entity_members(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        user_member = _create_user(test_db, "member")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")
        _add_user_member(test_db, group, user_member, "Reporter")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_123",
            role="Maintainer",
        )

        all_members = get_group_all_members(test_db, "test-group")

        assert len(all_members) == 3
        entity_types = {m.entity_type for m in all_members}
        assert entity_types == {"user", "org_department"}


class TestIterUserGroupsWithRoles:
    """Tests for iter_user_groups_with_roles."""

    def test_returns_direct_user_memberships(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")

        result = iter_user_groups_with_roles(test_db, owner.id)

        assert len(result) == 1
        assert result[0][0] == "test-group"
        assert result[0][1] == "Owner"
        assert result[0][2] == "user"
        assert result[0][3] == str(owner.id)

    def test_returns_entity_derived_memberships(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        result = iter_user_groups_with_roles(test_db, employee.id)

        assert len(result) == 1
        assert result[0][0] == "test-group"
        assert result[0][1] == "Maintainer"
        assert result[0][2] == "mock_department"
        assert result[0][3] == "dept_1"

    def test_highest_role_wins_when_multiple_paths(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, employee, "Reporter")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        result = iter_user_groups_with_roles(test_db, employee.id)

        assert len(result) == 1
        assert result[0][0] == "test-group"
        assert result[0][1] == "Maintainer"

    def test_returns_empty_list_when_no_memberships(self, test_db: Session):
        user = _create_user(test_db, "lonely")
        result = iter_user_groups_with_roles(test_db, user.id)
        assert result == []


class TestGetUserGroupsWithRoles:
    """Tests for get_user_groups_with_roles backward-compatible format."""

    def test_returns_group_name_and_role_only(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")

        result = get_user_groups_with_roles(test_db, owner.id)

        assert len(result) == 1
        assert result[0] == ("test-group", "Owner")
        assert len(result[0]) == 2

    def test_includes_entity_paths(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        result = get_user_groups_with_roles(test_db, employee.id)

        assert len(result) == 1
        assert result[0] == ("test-group", "Developer")


class TestGetEffectiveRoleInGroup:
    """Tests for get_effective_role_in_group with entity paths."""

    def test_direct_user_role(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        member = _create_user(test_db, "member")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, member, "Developer")

        role = get_effective_role_in_group(test_db, member.id, "test-group")

        assert role == GroupRole.Developer

    def test_entity_derived_role(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        role = get_effective_role_in_group(test_db, employee.id, "test-group")

        assert role == GroupRole.Maintainer

    def test_highest_role_when_direct_and_entity_both_exist(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, employee, "Reporter")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        role = get_effective_role_in_group(test_db, employee.id, "test-group")

        assert role == GroupRole.Maintainer

    def test_returns_none_when_not_member(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        outsider = _create_user(test_db, "outsider")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")

        role = get_effective_role_in_group(test_db, outsider.id, "test-group")

        assert role is None

    def test_entity_role_expires_when_resolver_returns_empty(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver("mock_department", lambda: MockDepartmentResolver({}))

        role = get_effective_role_in_group(test_db, employee.id, "test-group")

        assert role is None

    def test_parent_group_inheritance_still_works(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        member = _create_user(test_db, "member")
        parent = _create_group(test_db, owner, "parent")
        child = _create_group(test_db, owner, "parent/child")
        _add_user_member(test_db, parent, member, "Developer")

        role = get_effective_role_in_group(test_db, member.id, "parent/child")

        assert role == GroupRole.Developer

    def test_parent_inheritance_plus_entity_takes_highest(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        parent = _create_group(test_db, owner, "parent")
        child = _create_group(test_db, owner, "parent/child")
        _add_user_member(test_db, parent, employee, "Reporter")
        create_group_entity_member(
            test_db,
            group_name="parent/child",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        role = get_effective_role_in_group(test_db, employee.id, "parent/child")

        assert role == GroupRole.Maintainer


class TestCheckGroupPermission:
    """Tests for check_group_permission with entity paths."""

    def test_entity_member_passes_permission_check(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        has_access = check_group_permission(
            test_db, employee.id, "test-group", GroupRole.Reporter
        )

        assert has_access is True

    def test_entity_member_fails_when_role_insufficient(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Reporter",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        has_access = check_group_permission(
            test_db, employee.id, "test-group", GroupRole.Maintainer
        )

        assert has_access is False

    def test_non_member_denied(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        outsider = _create_user(test_db, "outsider")
        group = _create_group(test_db, owner, "test-group")
        _add_user_member(test_db, group, owner, "Owner")

        has_access = check_group_permission(
            test_db, outsider.id, "test-group", GroupRole.Reporter
        )

        assert has_access is False


class TestGetUserGroups:
    """Tests for get_user_groups with entity paths."""

    def test_includes_entity_derived_groups(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group_a = _create_group(test_db, owner, "group-a")
        group_b = _create_group(test_db, owner, "group-b")
        create_group_entity_member(
            test_db,
            group_name="group-a",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        create_group_entity_member(
            test_db,
            group_name="group-b",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Reporter",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        groups = get_user_groups(test_db, employee.id)

        assert "group-a" in groups
        assert "group-b" in groups

    def test_includes_parent_inherited_groups(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        member = _create_user(test_db, "member")
        parent = _create_group(test_db, owner, "parent")
        child = _create_group(test_db, owner, "parent/child")
        _add_user_member(test_db, parent, member, "Developer")

        groups = get_user_groups(test_db, member.id)

        assert "parent" in groups
        assert "parent/child" in groups


class TestGetEffectiveRolesInGroups:
    """Tests for batched get_effective_roles_in_groups."""

    def test_returns_roles_for_multiple_groups(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group_a = _create_group(test_db, owner, "group-a")
        group_b = _create_group(test_db, owner, "group-b")
        create_group_entity_member(
            test_db,
            group_name="group-a",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        create_group_entity_member(
            test_db,
            group_name="group-b",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        roles = get_effective_roles_in_groups(
            test_db, employee.id, ["group-a", "group-b"]
        )

        assert roles["group-a"] == GroupRole.Developer
        assert roles["group-b"] == GroupRole.Maintainer

    def test_returns_empty_dict_for_empty_input(self, test_db: Session):
        roles = get_effective_roles_in_groups(test_db, 1, [])
        assert roles == {}


class TestGetRestrictedAnalystGroups:
    """Tests for get_restricted_analyst_groups."""

    def test_identifies_restricted_analyst_groups(self, test_db: Session):
        owner = _create_user(test_db, "owner")
        employee = _create_user(test_db, "employee")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="RestrictedAnalyst",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        restricted = get_restricted_analyst_groups(test_db, employee.id, ["test-group"])

        assert restricted == {"test-group"}


class TestListResourcesByEntityMatch:
    """Tests for list_resources_by_entity_match utility."""

    def test_returns_resource_ids_for_matched_entities(self, test_db: Session):
        from app.services.share.external_entity_resolver import (
            list_resources_by_entity_match,
        )

        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        # Create entity member for group
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_1",
            role="Maintainer",
        )

        result = list_resources_by_entity_match(
            test_db,
            resource_type="Namespace",
            entity_type="org_department",
            matched_entity_ids=["dept_1"],
        )

        assert group.id in result

    def test_returns_empty_list_for_no_matches(self, test_db: Session):
        from app.services.share.external_entity_resolver import (
            list_resources_by_entity_match,
        )

        result = list_resources_by_entity_match(
            test_db,
            resource_type="Namespace",
            entity_type="org_department",
            matched_entity_ids=["nonexistent"],
        )

        assert result == []

    def test_filters_by_resource_type(self, test_db: Session):
        from app.services.share.external_entity_resolver import (
            list_resources_by_entity_match,
        )

        owner = _create_user(test_db, "owner")
        group = _create_group(test_db, owner, "test-group")
        create_group_entity_member(
            test_db,
            group_name="test-group",
            entity_type="org_department",
            entity_id="dept_1",
            role="Maintainer",
        )

        result = list_resources_by_entity_match(
            test_db,
            resource_type="Team",
            entity_type="org_department",
            matched_entity_ids=["dept_1"],
        )

        assert result == []

    def test_returns_empty_list_for_empty_matched_ids(self, test_db: Session):
        from app.services.share.external_entity_resolver import (
            list_resources_by_entity_match,
        )

        result = list_resources_by_entity_match(
            test_db,
            resource_type="Namespace",
            entity_type="org_department",
            matched_entity_ids=[],
        )

        assert result == []


class TestCreateGroupEntityMembersBatch:
    """Tests for create_group_entity_members_batch."""

    def test_batch_create_succeeds(self, test_db: Session):
        """Test successful batch creation of entity members."""
        from app.schemas.group_entity_member import (
            GroupEntityMemberBatchCreate,
            GroupEntityMemberCreate,
        )
        from app.services.group_member_helper import (
            create_group_entity_members_batch,
        )

        owner = _create_user(test_db, "batch_owner")
        group = _create_group(test_db, owner, "batch-test-group")

        members = [
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id="dept_1",
                role="Reporter",
            ),
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id="dept_2",
                role="Developer",
            ),
        ]

        succeeded, failed = create_group_entity_members_batch(
            test_db,
            group_name="batch-test-group",
            members=members,
            invited_by_user_id=owner.id,
        )

        assert len(succeeded) == 2
        assert len(failed) == 0

    def test_batch_create_partial_failure(self, test_db: Session):
        """Test batch creation with some already existing members."""
        from app.schemas.group_entity_member import (
            GroupEntityMemberBatchCreate,
            GroupEntityMemberCreate,
        )
        from app.services.group_member_helper import (
            create_group_entity_members_batch,
        )

        owner = _create_user(test_db, "batch_partial_owner")
        group = _create_group(test_db, owner, "batch-partial-group")

        # Pre-add one entity member
        existing = ResourceMember.create(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="mock_department",
            entity_id="dept_1",
            role="Reporter",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=owner.id,
        )
        test_db.add(existing)
        test_db.commit()

        members = [
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id="dept_1",
                role="Reporter",
            ),
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id="dept_2",
                role="Developer",
            ),
        ]

        succeeded, failed = create_group_entity_members_batch(
            test_db,
            group_name="batch-partial-group",
            members=members,
            invited_by_user_id=owner.id,
        )

        assert len(succeeded) == 1
        assert len(failed) == 1
        assert failed[0].entity_id == "dept_1"

    def test_batch_create_exceed_limit(self, test_db: Session):
        """Test batch creation fails when exceeding group limit."""
        from app.schemas.group_entity_member import (
            GroupEntityMemberBatchCreate,
            GroupEntityMemberCreate,
        )
        from app.services.group_member_helper import (
            create_group_entity_members_batch,
        )

        owner = _create_user(test_db, "batch_limit_owner")
        group = _create_group(test_db, owner, "batch-limit-group")

        # Add 30 entity members to reach the limit
        for i in range(30):
            member = ResourceMember.create(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="mock_department",
                entity_id=f"dept_{i}",
                role="Reporter",
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=owner.id,
            )
            test_db.add(member)
        test_db.commit()

        members = [
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id=f"dept_new_{i}",
                role="Reporter",
            )
            for i in range(5)
        ]

        with pytest.raises(ValueError, match="limit reached"):
            create_group_entity_members_batch(
                test_db,
                group_name="batch-limit-group",
                members=members,
                invited_by_user_id=owner.id,
            )

    def test_batch_create_group_not_found(self, test_db: Session):
        """Test batch creation fails for non-existent group."""
        from app.schemas.group_entity_member import (
            GroupEntityMemberCreate,
        )
        from app.services.group_member_helper import (
            create_group_entity_members_batch,
        )

        owner = _create_user(test_db, "batch_nf_owner")

        members = [
            GroupEntityMemberCreate(
                entity_type="mock_department",
                entity_id="dept_1",
                role="Reporter",
            ),
        ]

        with pytest.raises(ValueError, match="Group not found"):
            create_group_entity_members_batch(
                test_db,
                group_name="nonexistent-group",
                members=members,
                invited_by_user_id=owner.id,
            )

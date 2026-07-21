# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for TeamShareService _get_resource entity fallback."""

from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.share import MemberRole
from app.services.external_entity_resolver import register_entity_resolver
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver
from app.services.share.team_share_service import TeamShareService
from tests.utils.mock_resolver import MockDepartmentResolver, cleanup_resolvers


def _create_user(test_db: Session, username: str) -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-pass"),
        email=f"{username}@example.com",
        is_active=True,
        role="user",
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_team(
    test_db: Session, owner: User | None, name: str, ns: str = "default"
) -> Kind:
    team = Kind(
        name=name,
        namespace=ns,
        kind="Team",
        user_id=owner.id if owner else 0,
        is_active=True,
        json={"spec": {"name": name}},
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _create_namespace(test_db: Session, owner: User, name: str) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="private",
        description="test namespace",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


def _add_namespace_user_member(
    test_db: Session, namespace: Namespace, user: User, role: str = "Reporter"
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=namespace.owner_user_id,
        share_link_id=0,
        reviewed_by_user_id=namespace.owner_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def _add_team_user_member(
    test_db: Session, team_id: int, user_id: int, role: str
) -> ResourceMember:
    member = ResourceMember(
        resource_type=ResourceType.TEAM.value,
        resource_id=team_id,
        entity_type="user",
        entity_id=str(user_id),
        role=role,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=0,
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


class TestTeamGetResource:
    """Tests for TeamShareService._get_resource entity fallback."""

    def test_returns_team_for_creator(self, test_db: Session):
        creator = _create_user(test_db, "creator")
        team = _create_team(test_db, creator, "creator-team")
        service = TeamShareService()

        result = service._get_resource(test_db, team.id, creator.id)

        assert result is not None
        assert result.id == team.id

    def test_returns_public_team_for_any_user(self, test_db: Session):
        user = _create_user(test_db, "public-team-user")
        team = _create_team(test_db, None, "public-team")
        service = TeamShareService()

        result = service._get_resource(test_db, team.id, user.id)

        assert result is not None
        assert result.id == team.id


class TestTeamChildNamespaceAuthorization:
    """Tests for explicit parent Team authorization to child namespaces."""

    def setup_method(self):
        register_entity_resolver("namespace", NamespaceEntityResolver)

    def test_add_child_namespace_authorization_grants_child_member_access(
        self, test_db: Session
    ):
        owner = _create_user(test_db, "parent-owner")
        child_member = _create_user(test_db, "child-member")
        _create_namespace(test_db, owner, "parent-group")
        child = _create_namespace(test_db, owner, "parent-group/child")
        _add_namespace_user_member(test_db, child, child_member)
        team = _create_team(test_db, owner, "parent-team", ns="parent-group")
        service = TeamShareService()

        response = service.add_member(
            test_db,
            resource_id=team.id,
            current_user_id=owner.id,
            target_user_id=0,
            role=MemberRole.Reporter,
            entity_type="namespace",
            entity_id=str(child.id),
        )

        assert response.entity_type == "namespace"
        assert response.entity_id == str(child.id)
        assert response.user_id is None
        stored_member = (
            test_db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.resource_id == team.id,
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id == str(child.id),
            )
            .first()
        )
        assert stored_member is not None
        assert stored_member.user_id == owner.id
        result = service._get_resource(test_db, team.id, child_member.id)
        assert result is not None
        assert result.id == team.id

    @pytest.mark.parametrize(
        ("team_namespace", "target_namespace", "role", "expected_detail"),
        [
            (
                "default",
                "parent-default/child",
                MemberRole.Reporter,
                "Only group teams",
            ),
            ("parent-self", "parent-self", MemberRole.Reporter, "own group"),
            ("parent-unrelated", "other-group", MemberRole.Reporter, "child groups"),
            ("parent-role", "parent-role/child", MemberRole.Developer, "Reporter"),
        ],
    )
    def test_rejects_invalid_namespace_authorization(
        self,
        test_db: Session,
        team_namespace: str,
        target_namespace: str,
        role: MemberRole,
        expected_detail: str,
    ):
        owner = _create_user(test_db, f"owner-{target_namespace.replace('/', '-')}")
        namespace_by_name = {}
        if team_namespace != "default":
            namespace_by_name[team_namespace] = _create_namespace(
                test_db, owner, team_namespace
            )
        target = namespace_by_name.get(target_namespace) or _create_namespace(
            test_db, owner, target_namespace
        )
        team = _create_team(test_db, owner, "team", ns=team_namespace)
        service = TeamShareService()

        with pytest.raises(HTTPException) as exc_info:
            service.add_member(
                test_db,
                resource_id=team.id,
                current_user_id=owner.id,
                target_user_id=0,
                role=role,
                entity_type="namespace",
                entity_id=str(target.id),
            )

        assert exc_info.value.status_code == 400
        assert expected_detail in str(exc_info.value.detail)

    def test_update_namespace_authorization_cannot_raise_above_reporter(
        self, test_db: Session
    ):
        owner = _create_user(test_db, "update-owner")
        _create_namespace(test_db, owner, "update-parent")
        child = _create_namespace(test_db, owner, "update-parent/child")
        team = _create_team(test_db, owner, "update-team", ns="update-parent")
        service = TeamShareService()
        response = service.add_member(
            test_db,
            resource_id=team.id,
            current_user_id=owner.id,
            target_user_id=0,
            role=MemberRole.Reporter,
            entity_type="namespace",
            entity_id=str(child.id),
        )

        with pytest.raises(HTTPException) as exc_info:
            service.update_member(
                test_db,
                resource_id=team.id,
                member_id=response.id,
                current_user_id=owner.id,
                role=MemberRole.Developer,
            )

        assert exc_info.value.status_code == 400
        assert "Reporter" in str(exc_info.value.detail)

    def test_parent_group_maintainer_can_authorize_child_namespace(
        self, test_db: Session
    ):
        owner = _create_user(test_db, "maintainer-owner")
        maintainer = _create_user(test_db, "parent-maintainer")
        parent = _create_namespace(test_db, owner, "maintainer-parent")
        child = _create_namespace(test_db, owner, "maintainer-parent/child")
        _add_namespace_user_member(test_db, parent, maintainer, "Maintainer")
        team = _create_team(test_db, owner, "maintainer-team", ns=parent.name)
        service = TeamShareService()

        response = service.add_member(
            test_db,
            resource_id=team.id,
            current_user_id=maintainer.id,
            target_user_id=0,
            role=MemberRole.Reporter,
            entity_type="namespace",
            entity_id=str(child.id),
        )

        assert response.entity_type == "namespace"
        assert response.entity_id == str(child.id)

    def test_returns_team_for_direct_user_member(self, test_db: Session):
        creator = _create_user(test_db, "creator")
        member = _create_user(test_db, "member")
        team = _create_team(test_db, creator, "member-team")
        _add_team_user_member(test_db, team.id, member.id, "Reporter")
        service = TeamShareService()

        result = service._get_resource(test_db, team.id, member.id)

        assert result is not None
        assert result.id == team.id

    def test_returns_team_for_entity_member_via_check_permission(
        self, test_db: Session
    ):
        creator = _create_user(test_db, "creator")
        employee = _create_user(test_db, "employee")
        team = _create_team(test_db, creator, "entity-team")

        # Add mock_department entity binding to team
        entity_member = ResourceMember(
            resource_type=ResourceType.TEAM.value,
            resource_id=team.id,
            entity_type="mock_department",
            entity_id="dept_1",
            role="Reporter",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=0,
            share_link_id=0,
            reviewed_by_user_id=0,
            copied_resource_id=0,
        )
        test_db.add(entity_member)
        test_db.commit()

        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        service = TeamShareService()
        result = service._get_resource(test_db, team.id, employee.id)

        assert result is not None
        assert result.id == team.id

    def test_returns_none_for_non_member(self, test_db: Session):
        creator = _create_user(test_db, "creator")
        outsider = _create_user(test_db, "outsider")
        team = _create_team(test_db, creator, "private-team")
        service = TeamShareService()

        result = service._get_resource(test_db, team.id, outsider.id)

        assert result is None

    def test_returns_none_for_team_not_found(self, test_db: Session):
        user = _create_user(test_db, "user")
        service = TeamShareService()

        result = service._get_resource(test_db, 99999, user.id)

        assert result is None

    def test_entity_member_with_insufficient_role(self, test_db: Session):
        creator = _create_user(test_db, "creator")
        employee = _create_user(test_db, "employee")
        team = _create_team(test_db, creator, "restricted-team")

        entity_member = ResourceMember(
            resource_type=ResourceType.TEAM.value,
            resource_id=team.id,
            entity_type="mock_department",
            entity_id="dept_1",
            role="Reporter",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=0,
            share_link_id=0,
            reviewed_by_user_id=0,
            copied_resource_id=0,
        )
        test_db.add(entity_member)
        test_db.commit()

        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        service = TeamShareService()
        # Even though role is Reporter, _get_resource should return the team
        # because check_permission with Reporter requirement passes
        result = service._get_resource(test_db, team.id, employee.id)

        assert result is not None
        assert result.id == team.id

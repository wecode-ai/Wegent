# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for TeamShareService _get_resource entity fallback."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.share import MemberRole
from app.services.share.external_entity_resolver import register_entity_resolver
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


def _create_team(test_db: Session, owner: User, name: str, ns: str = "default") -> Kind:
    team = Kind(
        name=name,
        namespace=ns,
        kind="Team",
        user_id=owner.id,
        is_active=True,
        json={"spec": {"name": name}},
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


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

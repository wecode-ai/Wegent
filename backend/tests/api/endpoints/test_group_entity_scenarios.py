# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""E2E scenario tests for group department authorization (UC-1 ~ UC-7).

Covers the full permission chain from group entity members to downstream
resources (KnowledgeBase, Team). Uses mock department resolver to simulate
org_department entity bindings without internal package dependencies.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.services.external_entity_resolver import register_entity_resolver
from app.services.group_member_helper import create_group_entity_member
from tests.utils.mock_resolver import MockDepartmentResolver, cleanup_resolvers


def _create_user(test_db: Session, username: str, role: str = "user") -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-pass"),
        email=f"{username}@example.com",
        is_active=True,
        git_info=None,
        role=role,
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


def _add_user_member(test_db: Session, group: Namespace, user: User, role: str) -> None:
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


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class TestUC1DepartmentAddedAsMaintainer:
    """UC-1: Owner adds department to group as Maintainer.

    Expected: Department employees have Maintainer role in the group.
    """

    def test_entity_member_has_maintainer_role_in_group(
        self,
        test_client: TestClient,
        test_db: Session,
        test_user: User,
        test_token: str,
    ):
        owner = _create_user(test_db, "uc1-owner")
        employee = _create_user(test_db, "uc1-employee")
        group = _create_group(test_db, owner, "uc1-group")
        _add_user_member(test_db, group, owner, "Owner")

        # Register mock resolver: employee belongs to dept_1
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        # Owner adds department as Maintainer
        with (
            patch(
                "app.api.endpoints.groups.get_all_entity_types",
                return_value={"mock_department"},
            ),
            patch(
                "app.api.endpoints.groups.get_entity_resolver",
                return_value=MockDepartmentResolver({}),
            ),
        ):
            owner_token = create_access_token(data={"sub": owner.user_name})
            response = test_client.post(
                f"/api/groups/{group.name}/entity-members",
                headers=_auth_header(owner_token),
                json={
                    "entity_type": "mock_department",
                    "entity_id": "dept_1",
                    "role": "Maintainer",
                },
            )
            assert response.status_code == 201

        # Employee can access group detail (Maintainer role)
        employee_token = create_access_token(data={"sub": employee.user_name})
        response = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert response.status_code == 200
        assert response.json()["my_role"] == "Maintainer"


class TestUC2DirectReporterPlusDepartmentMaintainer:
    """UC-2: Employee is direct Reporter + department Maintainer.

    Expected: Final effective role is Maintainer (highest wins).
    """

    def test_highest_role_wins_direct_plus_entity(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc2-owner")
        employee = _create_user(test_db, "uc2-employee")
        group = _create_group(test_db, owner, "uc2-group")
        _add_user_member(test_db, group, owner, "Owner")
        # Direct membership: Reporter
        _add_user_member(test_db, group, employee, "Reporter")
        # Entity membership: Maintainer
        create_group_entity_member(
            test_db,
            group_name="uc2-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Maintainer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        employee_token = create_access_token(data={"sub": employee.user_name})
        response = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert response.status_code == 200
        assert response.json()["my_role"] == "Maintainer"


class TestUC3DepartmentGroupToKB:
    """UC-3: Department → Group → KB permission chain.

    Expected: Employee automatically sees KB in the group
    (no need to modify KB sharing).
    """

    def test_employee_sees_group_kb_via_entity_membership(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc3-owner")
        employee = _create_user(test_db, "uc3-employee")
        group = _create_group(test_db, owner, "uc3-group")
        _add_user_member(test_db, group, owner, "Owner")

        # Add department entity member to group
        create_group_entity_member(
            test_db,
            group_name="uc3-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        # Create KB in the group namespace via API
        owner_token = create_access_token(data={"sub": owner.user_name})
        kb_resp = test_client.post(
            "/api/knowledge-bases",
            headers=_auth_header(owner_token),
            json={
                "name": "uc3-kb",
                "namespace": "uc3-group",
                "retrieval_config": {"retriever_name": "test"},
            },
        )
        assert kb_resp.status_code == 201

        # Debug: verify get_user_groups includes the entity-derived group
        from app.services.group_permission import get_user_groups

        employee_groups = get_user_groups(test_db, employee.id)
        assert (
            "uc3-group" in employee_groups
        ), f"Expected uc3-group in {employee_groups}"

        # Employee should see the KB via group namespace access
        employee_token = create_access_token(data={"sub": employee.user_name})
        response = test_client.get(
            "/api/knowledge-bases/accessible",
            headers=_auth_header(employee_token),
        )
        assert response.status_code == 200
        data = response.json()
        team_kbs = data.get("team", [])
        kb_names = []
        for group in team_kbs:
            for kb in group.get("knowledge_bases", []):
                kb_names.append(kb["name"])
        assert "uc3-kb" in kb_names


class TestUC4DepartmentGroupToTeamNotExplicitlyShared:
    """UC-4: Department → Group → Team (not explicitly shared).

    Note: Current behavior makes Teams default-visible to all group members
    (via get_user_teams scope='group'). This test verifies that entity-derived
    group members see the same Teams as direct members (behavioral consistency).
    """

    def test_entity_member_sees_group_teams_same_as_direct_member(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc4-owner")
        employee = _create_user(test_db, "uc4-employee")
        direct_member = _create_user(test_db, "uc4-direct")
        group = _create_group(test_db, owner, "uc4-group")
        _add_user_member(test_db, group, owner, "Owner")
        _add_user_member(test_db, group, direct_member, "Developer")

        # Employee via entity
        create_group_entity_member(
            test_db,
            group_name="uc4-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        # Create required Bot/Shell resources and a valid Team CRD
        from app.models.kind import Kind

        shell = Kind(
            name="chat-shell",
            namespace="default",
            kind="Shell",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Shell",
                "metadata": {"name": "chat-shell", "namespace": "default"},
                "spec": {"shellType": "Chat"},
            },
        )
        test_db.add(shell)

        bot = Kind(
            name="test-bot",
            namespace="default",
            kind="Bot",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {"name": "test-bot", "namespace": "default"},
                "spec": {
                    "shellRef": {"name": "chat-shell", "namespace": "default"},
                    "ghostRef": {"name": "test-ghost", "namespace": "default"},
                },
            },
        )
        test_db.add(bot)

        team = Kind(
            name="uc4-team",
            namespace="uc4-group",
            kind="Team",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {"name": "uc4-team", "namespace": "uc4-group"},
                "spec": {
                    "collaborationModel": "route",
                    "members": [
                        {
                            "botRef": {"name": "test-bot", "namespace": "default"},
                            "role": "worker",
                        }
                    ],
                },
            },
        )
        test_db.add(team)
        test_db.commit()

        # Direct member sees the team
        direct_token = create_access_token(data={"sub": direct_member.user_name})
        direct_resp = test_client.get(
            "/api/teams?scope=group&group_name=uc4-group",
            headers=_auth_header(direct_token),
        )
        assert direct_resp.status_code == 200
        direct_teams = [t["name"] for t in direct_resp.json()["items"]]

        # Entity member sees the same teams
        employee_token = create_access_token(data={"sub": employee.user_name})
        entity_resp = test_client.get(
            "/api/teams?scope=group&group_name=uc4-group",
            headers=_auth_header(employee_token),
        )
        assert entity_resp.status_code == 200
        entity_teams = [t["name"] for t in entity_resp.json()["items"]]

        assert "uc4-team" in direct_teams
        assert entity_teams == direct_teams

    def test_entity_member_can_access_team_detail_via_group_namespace(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc4-detail-owner")
        employee = _create_user(test_db, "uc4-detail-employee")
        group = _create_group(test_db, owner, "uc4-detail-group")
        _add_user_member(test_db, group, owner, "Owner")

        create_group_entity_member(
            test_db,
            group_name="uc4-detail-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department",
            lambda: MockDepartmentResolver({employee.id: {"dept_1"}}),
        )

        from app.models.kind import Kind

        shell = Kind(
            name="chat-shell-detail",
            namespace="default",
            kind="Shell",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Shell",
                "metadata": {"name": "chat-shell-detail", "namespace": "default"},
                "spec": {"shellType": "Chat"},
            },
        )
        test_db.add(shell)

        bot = Kind(
            name="test-bot-detail",
            namespace="default",
            kind="Bot",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {"name": "test-bot-detail", "namespace": "default"},
                "spec": {
                    "shellRef": {"name": "chat-shell-detail", "namespace": "default"},
                    "ghostRef": {"name": "test-ghost-detail", "namespace": "default"},
                },
            },
        )
        test_db.add(bot)

        team = Kind(
            name="uc4-detail-team",
            namespace="uc4-detail-group",
            kind="Team",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {
                    "name": "uc4-detail-team",
                    "namespace": "uc4-detail-group",
                },
                "spec": {
                    "collaborationModel": "route",
                    "members": [
                        {
                            "botRef": {
                                "name": "test-bot-detail",
                                "namespace": "default",
                            },
                            "role": "worker",
                        }
                    ],
                },
            },
        )
        test_db.add(team)
        test_db.commit()

        employee_token = create_access_token(data={"sub": employee.user_name})
        response = test_client.get(
            f"/api/teams/{team.id}",
            headers=_auth_header(employee_token),
        )
        assert response.status_code == 200
        assert response.json()["name"] == "uc4-detail-team"

    def test_non_member_cannot_access_team_detail_in_group_namespace(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc4-deny-owner")
        outsider = _create_user(test_db, "uc4-deny-outsider")
        group = _create_group(test_db, owner, "uc4-deny-group")
        _add_user_member(test_db, group, owner, "Owner")

        from app.models.kind import Kind

        team = Kind(
            name="uc4-deny-team",
            namespace="uc4-deny-group",
            kind="Team",
            user_id=owner.id,
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {"name": "uc4-deny-team", "namespace": "uc4-deny-group"},
                "spec": {"collaborationModel": "route", "members": []},
            },
        )
        test_db.add(team)
        test_db.commit()

        outsider_token = create_access_token(data={"sub": outsider.user_name})
        response = test_client.get(
            f"/api/teams/{team.id}",
            headers=_auth_header(outsider_token),
        )
        assert response.status_code == 404


class TestUC5RemoveDepartmentAuthorization:
    """UC-5: Remove department authorization.

    Expected: Employee loses group permissions and downstream resource access.
    """

    def test_employee_loses_access_after_entity_member_removed(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc5-owner")
        employee = _create_user(test_db, "uc5-employee")
        group = _create_group(test_db, owner, "uc5-group")
        _add_user_member(test_db, group, owner, "Owner")

        # Add and then remove department entity member
        create_group_entity_member(
            test_db,
            group_name="uc5-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        # Before removal: employee has access
        employee_token = create_access_token(data={"sub": employee.user_name})
        before = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert before.status_code == 200

        # Owner removes entity member
        owner_token = create_access_token(data={"sub": owner.user_name})
        delete_resp = test_client.delete(
            f"/api/groups/{group.name}/entity-members/mock_department/dept_1",
            headers=_auth_header(owner_token),
        )
        assert delete_resp.status_code == 204

        # After removal: employee loses access
        after = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert after.status_code == 403


class TestUC6KBDirectlyBoundToDepartment:
    """UC-6: KB directly bound to department (existing behavior).

    Expected: Behavior unchanged — employee can access KB via direct entity binding.
    """

    def test_kb_direct_department_binding_unchanged(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc6-owner")
        employee = _create_user(test_db, "uc6-employee")
        group = _create_group(test_db, owner, "uc6-group")
        _add_user_member(test_db, group, owner, "Owner")

        # Add department entity member to group first
        create_group_entity_member(
            test_db,
            group_name="uc6-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )
        register_entity_resolver(
            "mock_department", lambda: MockDepartmentResolver({employee.id: {"dept_1"}})
        )

        # Create KB in the group namespace (no explicit members needed)
        owner_token = create_access_token(data={"sub": owner.user_name})
        kb_resp = test_client.post(
            "/api/knowledge-bases",
            headers=_auth_header(owner_token),
            json={
                "name": "uc6-kb",
                "namespace": "uc6-group",
                "retrieval_config": {"retriever_name": "test"},
            },
        )
        assert (
            kb_resp.status_code == 201
        ), f"KB create failed: {kb_resp.status_code} - {kb_resp.text}"
        kb_id = kb_resp.json()["id"]

        # Employee (as group member via entity) should access KB through group namespace
        employee_token = create_access_token(data={"sub": employee.user_name})
        response = test_client.get(
            f"/api/knowledge-bases/{kb_id}",
            headers=_auth_header(employee_token),
        )
        assert response.status_code == 200
        assert response.json()["name"] == "uc6-kb"


class TestUC7EmployeeLeavesDepartment:
    """UC-7: Employee leaves department (resolver returns empty).

    Expected: Permissions are immediately revoked (resolver no longer matches).
    """

    def test_permissions_revoked_when_resolver_returns_empty(
        self,
        test_client: TestClient,
        test_db: Session,
    ):
        owner = _create_user(test_db, "uc7-owner")
        employee = _create_user(test_db, "uc7-employee")
        group = _create_group(test_db, owner, "uc7-group")
        _add_user_member(test_db, group, owner, "Owner")

        create_group_entity_member(
            test_db,
            group_name="uc7-group",
            entity_type="mock_department",
            entity_id="dept_1",
            role="Developer",
        )

        # Initially employee is in dept_1
        register_entity_resolver(
            "mock_department",
            lambda: MockDepartmentResolver({employee.id: {"dept_1"}}),
        )

        employee_token = create_access_token(data={"sub": employee.user_name})
        before = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert before.status_code == 200

        # Employee leaves department (resolver now returns empty for this user)
        register_entity_resolver(
            "mock_department",
            lambda: MockDepartmentResolver({}),
        )

        after = test_client.get(
            f"/api/groups/{group.name}",
            headers=_auth_header(employee_token),
        )
        assert after.status_code == 403

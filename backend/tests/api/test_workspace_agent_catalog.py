# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Discovery query count is independent of the number of workspace Agents."""

from unittest.mock import Mock

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services.execution import team_readiness
from app.services.workspaces.agents import WorkspaceAgentService
from tests.api.test_personal_resources_queries import _kind


@pytest.mark.parametrize("size", [2, 86])
def test_light_workspace_catalog_has_constant_queries_without_preflight(
    test_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch, size: int
) -> None:
    workspace = _kind(test_user.id, "CollaborationWorkspace", "catalog", {})
    test_db.add(workspace)
    test_db.flush()
    workspace_id, user_id, owner_name = workspace.id, test_user.id, test_user.user_name
    for index in range(size):
        team = _kind(user_id, "Team", f"agent-{index}", {})
        test_db.add(team)
        test_db.flush()
        test_db.add(
            ResourceMember.create(
                resource_type="Team",
                resource_id=team.id,
                entity_type="workspace",
                entity_id=str(workspace_id),
                role="Developer",
                status="approved",
                invited_by_user_id=user_id,
            )
        )
    test_db.commit()
    validate = Mock(
        side_effect=AssertionError("Discovery requested execution preflight")
    )
    monkeypatch.setattr(team_readiness, "validate_team_execution_readiness", validate)
    statements: list[str] = []

    def record_sql(connection, cursor, statement, parameters, *args):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    connection = test_db.get_bind()
    event.listen(connection, "before_cursor_execute", record_sql)
    try:
        with Session(bind=connection) as db:
            rows = WorkspaceAgentService().list_agents(
                db, workspace_id, user_id, include_readiness=False
            )
    finally:
        event.remove(connection, "before_cursor_execute", record_sql)
    assert len(rows) == size
    assert {row["status"] for row in rows} == {"unchecked"}
    assert all(row["can_edit"] for row in rows)
    assert all(row["owner_name"] == owner_name for row in rows)
    validate.assert_not_called()
    # Workspace + active caller authorization, roster, owner names, and device grants.
    assert len(statements) == 5, statements


@pytest.mark.parametrize("size", [2, 86])
@pytest.mark.parametrize("role,editable", [("Developer", True), ("Viewer", False)])
def test_workspace_catalog_batches_external_identity_permissions_and_rechecks_revocation(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
    size: int,
    role: str,
    editable: bool,
) -> None:
    """Internal entity providers are called once per request, never once per Agent."""
    from app.models.namespace import Namespace
    from app.services import external_entity_resolver

    workspace = _kind(test_user.id, "CollaborationWorkspace", "external-catalog", {})
    test_db.add(workspace)
    test_db.flush()
    for index in range(size):
        group = Namespace(name=f"external-{index}", owner_user_id=test_admin_user.id)
        test_db.add(group)
        test_db.flush()
        team = _kind(test_admin_user.id, "Team", f"agent-{index}", {}, group.name)
        test_db.add(team)
        test_db.flush()
        for resource_type, resource_id, entity_type, entity_id, grant_role in [
            ("Namespace", group.id, "test_department", "department", role),
            (
                "Namespace",
                group.id,
                "test_department",
                "other-department",
                "Maintainer",
            ),
            ("Team", team.id, "workspace", str(workspace.id), "Developer"),
        ]:
            test_db.add(
                ResourceMember.create(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    role=grant_role,
                    status="approved",
                    invited_by_user_id=test_admin_user.id,
                )
            )
    test_db.commit()
    resolver = Mock(spec=external_entity_resolver.IExternalEntityResolver)
    monkeypatch.setattr(
        external_entity_resolver,
        "_external_entity_resolvers",
        {"test_department": type(resolver)},
    )
    monkeypatch.setattr(
        external_entity_resolver, "_resolver_instances", {"test_department": resolver}
    )
    workspace_id, user_id = workspace.id, test_user.id
    for allowed in [["department"], []]:
        resolver.match_entity_bindings.reset_mock()
        resolver.match_entity_bindings.return_value = allowed
        with Session(bind=test_db.get_bind()) as db:
            rows = WorkspaceAgentService().list_agents(
                db, workspace_id, user_id, include_readiness=False
            )
        assert len(rows) == size
        assert {row["can_edit"] for row in rows} == {bool(allowed) and editable}
        resolver.match_entity_bindings.assert_called_once()
        resolver.get_resource_ids_by_entity.assert_not_called()

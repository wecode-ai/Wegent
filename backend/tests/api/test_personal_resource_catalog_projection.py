# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Catalog discovery must not resolve execution graphs or deployment credentials."""

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.user import User
from app.services.execution import team_readiness
from app.services.project_chat.service import compiled_bot_config
from app.services.workspaces.personal_resources import WorkspacePersonalResourceService
from tests.api.test_personal_resources_queries import _catalog, _kind
from tests.api.test_workspace_collaboration_api import (
    _auth,
    _workspace_project_with_maintainer,
)
from tests.api.test_workspace_shared_agents import _native_team


@pytest.mark.parametrize("size", [2, 86])
async def test_light_catalog_does_not_read_execution_dependencies(
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
    record_property,
    size: int,
) -> None:
    """
    Require a fixed query budget with no execution preflight at either catalog size.
    """
    _catalog(test_db, test_user.id, test_admin_user.id, size)
    validate = Mock(side_effect=AssertionError("Catalog requested execution preflight"))
    monkeypatch.setattr(team_readiness, "validate_team_execution_readiness", validate)
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    statements: list[tuple[str, object]] = []

    def record_sql(connection, cursor, statement, parameters, *args):
        """Collect SELECT statements for the lightweight projection query budget."""
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append((statement, parameters))

    connection = test_db.get_bind()
    user_id = test_user.id
    event.listen(connection, "before_cursor_execute", record_sql)
    try:
        with Session(bind=connection) as db:
            resources = (
                await WorkspacePersonalResourceService().list_personal_resources(
                    db, user_id, include_readiness=False
                )
            )
    finally:
        event.remove(connection, "before_cursor_execute", record_sql)

    assert len(resources["agents"]) == size
    assert {agent["status"] for agent in resources["agents"]} == {"unchecked"}
    validate.assert_not_called()
    assert len(statements) == 3, statements
    kind_reads = [(sql, args) for sql, args in statements if "FROM kinds" in sql]
    assert len(kind_reads) == 2
    team_sql, _ = next((sql, args) for sql, args in kind_reads if "Team" in args)
    assert "JSON_QUOTE(JSON_EXTRACT(kinds.json" in team_sql
    assert "kinds.json AS kinds_json" not in team_sql
    assert not any("resource_members" in sql for sql, _ in statements)
    record_property("agent_count", size)
    record_property("catalog_selects", len(statements))


@pytest.mark.parametrize(
    "metadata",
    [
        None,
        [],
        {"displayName": 42},
        {"displayName": ""},
        {"displayName": "Review Agent"},
    ],
)
def test_light_catalog_keeps_scope_names_and_devices_without_unused_bindings(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_admin_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
    metadata: object,
) -> None:
    """
    Preserve owned-resource visibility and names while retaining the legacy response.
    """
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    team = _kind(test_user.id, "Team", "catalog-agent", {})
    team.json = {**team.json, "metadata": metadata}
    device = _kind(test_user.id, "Device", "catalog-device", {})
    inactive = _kind(test_user.id, "Team", "inactive-agent", {})
    inactive.is_active = False
    foreign = _kind(test_admin_user.id, "Team", "foreign-agent", {})
    test_db.add_all([team, device, inactive, foreign])
    test_db.commit()

    response = test_client.get(
        "/api/v1/resources?include_readiness=false", headers=_auth(test_token)
    )

    assert response.status_code == 200, response.text
    resources = response.json()
    assert resources["agents"] == [
        {
            "id": str(team.id),
            "team_id": team.id,
            "name": (
                "Review Agent"
                if metadata == {"displayName": "Review Agent"}
                else team.name
            ),
            "owner_type": "user",
            "owner_id": str(test_user.id),
            "owner_name": test_user.user_name,
            "status": "unchecked",
        }
    ]
    assert resources["execution_environments"][0]["device_id"] == device.id
    assert resources["execution_environments"][0]["status"] == "offline"
    assert "workspace_ids" not in resources["execution_environments"][0]

    # The original endpoint remains a full readiness contract for older clients.
    for query in ["", "?include_readiness=true"]:
        original = test_client.get(
            f"/api/v1/resources{query}", headers=_auth(test_token)
        )
        assert original.status_code == 200
        assert original.json()["agents"][0]["status"] == "unavailable"
        assert original.json()["agents"][0]["execution_environment_ids"] == [
            str(device.id)
        ]
        assert original.json()["agents"][0]["workspace_ids"] == []
        assert original.json()["execution_environments"][0]["workspace_ids"] == []


def test_selecting_catalog_agent_does_not_bypass_execution_validation(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject a selected agent whose execution configuration changed after discovery."""
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise", AsyncMock(return_value={})
    )
    workspace, project, _, _ = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    team = _native_team(test_db, test_user)
    shared = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert shared.status_code == 201, shared.text
    bound = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(test_token),
        json={"name": "Catalog Agent", "runtime": "wegent", "wegent_team_id": team.id},
    )
    assert bound.status_code == 201, bound.text
    binding = test_db.get(ProjectChatAgent, bound.json()["id"])
    assert (
        compiled_bot_config(test_db, binding, execution_user_id=test_user.id)[
            "wegent_team_id"
        ]
        == team.id
    )
    team.json = {**team.json, "spec": {}}
    test_db.commit()
    catalog = test_client.get(
        "/api/v1/resources?include_readiness=false", headers=_auth(test_token)
    )
    assert catalog.status_code == 200
    selected = next(
        agent for agent in catalog.json()["agents"] if agent["team_id"] == team.id
    )
    assert selected["status"] == "unchecked"

    with pytest.raises(HTTPException) as rejected:
        compiled_bot_config(test_db, binding, execution_user_id=test_user.id)
    assert rejected.value.status_code == 422
    assert (
        rejected.value.detail
        == f"Wegent Team is not runnable: Team '{team.name}' configuration is invalid"
    )

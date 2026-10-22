# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Discover shared Agents by their product names and bind them to projects."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.user import User
from app.services.project_chat.service import compiled_bot_config
from app.services.share import team_share_service
from tests.api.test_workspace_collaboration_api import (
    _auth,
    _workspace_project_with_maintainer,
)
from tests.api.test_workspace_shared_agents import _native_team


@pytest.mark.parametrize("display_name", ["代码审查智能体", "Review Agent", None, ""])
def test_discover_and_bind_workspace_agent_by_display_name(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    display_name: str | None,
) -> None:
    workspace, project, maintainer, token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    membership = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/members",
        headers=_auth(test_token),
        json={"user_id": maintainer.id, "role": "Maintainer"},
    )
    assert membership.status_code == 201
    team = _native_team(test_db, test_user)
    team.json = {
        **team.json,
        "metadata": {**team.json["metadata"], "displayName": display_name},
    }
    test_db.commit()
    expected_name = display_name or team.name

    personal = test_client.get("/api/v1/resources", headers=_auth(test_token))
    assert personal.status_code == 200
    personal_agent = next(
        agent for agent in personal.json()["agents"] if agent["team_id"] == team.id
    )
    assert personal_agent["name"] == expected_name

    shared = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert shared.status_code == 201
    assert shared.json()["name"] == expected_name
    catalog = test_client.get(
        f"/api/v1/workspaces/{workspace['id']}/agents", headers=_auth(token)
    )
    assert catalog.status_code == 200
    selected = next(
        agent for agent in catalog.json()["items"] if agent["name"] == expected_name
    )
    assert selected["team_id"] == team.id
    assert selected["status"] == "available"
    assert selected["can_edit"] is False

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(token),
        json={
            "name": selected["name"],
            "runtime": "wegent",
            "wegent_team_id": selected["team_id"],
            "share_with_workspace": True,
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["name"] == expected_name
    assert response.json()["canUse"] is True
    assert response.json()["canEdit"] is False
    binding = test_db.get(ProjectChatAgent, response.json()["id"])
    assert (
        compiled_bot_config(test_db, binding, execution_user_id=maintainer.id)[
            "wegent_team_id"
        ]
        == team.id
    )
    assert team_share_service.get_resource(test_db, team.id, maintainer.id) is None

    bindings = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents", headers=_auth(token)
    )
    assert bindings.status_code == 200
    assert [agent["name"] for agent in bindings.json()] == [expected_name]

    removed = test_client.delete(
        f"/api/v1/workspaces/{workspace['id']}/agents/{team.id}",
        headers=_auth(test_token),
    )
    assert removed.status_code == 204
    revoked = test_client.get(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents", headers=_auth(token)
    )
    assert revoked.status_code == 200
    assert revoked.json()[0]["canUse"] is False


@pytest.mark.parametrize("metadata", [None, [], {"displayName": 42}])
def test_invalid_agents_remain_listed_as_unavailable(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    metadata: object,
) -> None:
    workspace, _, _, _ = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    team = _native_team(test_db, test_user)
    team.json = {**team.json, "metadata": metadata}
    test_db.commit()

    shared = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert shared.status_code == 201
    assert shared.json()["name"] == team.name
    assert shared.json()["status"] == "unavailable"

    personal = test_client.get("/api/v1/resources", headers=_auth(test_token))
    assert personal.status_code == 200
    selected = next(
        agent for agent in personal.json()["agents"] if agent["team_id"] == team.id
    )
    assert selected["name"] == team.name
    assert selected["status"] == "unavailable"

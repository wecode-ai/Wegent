# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project-scoped shared Agent authorization and configuration boundaries."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.delivery import ProjectChatAgent
from app.models.kind import Kind
from app.models.user import User
from tests.api.test_workspace_collaboration_api import (
    _auth,
    _wegent_team,
    _workspace_project_with_maintainer,
)


def _native_team(test_db: Session, test_user: User) -> Kind:
    team = _wegent_team(test_db, test_user)
    bot_ref = team.json["spec"]["members"][0]["botRef"]
    bot = (
        test_db.query(Kind)
        .filter_by(
            kind="Bot", name=bot_ref["name"], namespace="default", user_id=test_user.id
        )
        .one()
    )
    shell_ref = bot.json["spec"]["shellRef"]
    shell = (
        test_db.query(Kind)
        .filter_by(
            kind="Shell",
            name=shell_ref["name"],
            namespace="default",
            user_id=test_user.id,
        )
        .one()
    )
    shell.json = {**shell.json, "spec": {**shell.json["spec"], "shellType": "Codex"}}
    bot.json = {
        **bot.json,
        "spec": {
            **bot.json["spec"],
            "modelRef": None,
            "execution_policy": {"mode": "project_pool"},
            "model_policy": {"mode": "user_select"},
        },
    }
    test_db.commit()
    return team


@pytest.mark.parametrize("native", [True, False])
def test_workspace_binding_preserves_resource_and_model_permissions(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    native: bool,
) -> None:
    from app.services.project_chat.service import compiled_bot_config
    from app.services.share.team_share_service import team_share_service

    workspace, project, maintainer, token = _workspace_project_with_maintainer(
        test_client, test_db, test_token
    )
    team = (
        _native_team(test_db, test_user) if native else _wegent_team(test_db, test_user)
    )
    authorization = test_client.post(
        f"/api/v1/workspaces/{workspace['id']}/agents",
        headers=_auth(test_token),
        json={"team_id": team.id},
    )
    assert authorization.status_code == 201
    assert team_share_service.get_resource(test_db, team.id, maintainer.id) is None

    response = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(token),
        json={
            "name": "Shared workspace Agent",
            "runtime": "wegent",
            "wegent_team_id": team.id,
        },
    )

    if not native:
        assert response.status_code == 422
        assert "model is unavailable" in response.json()["detail"]
        return

    assert response.status_code == 201, response.text
    assert response.json()["canEdit"] is False
    agent = test_db.get(ProjectChatAgent, response.json()["id"])
    assert agent is not None
    assert (
        compiled_bot_config(test_db, agent, execution_user_id=maintainer.id)[
            "wegent_team_id"
        ]
        == team.id
    )
    # Project execution access must not grant global configuration access.
    assert team_share_service.get_resource(test_db, team.id, maintainer.id) is None
    detail = test_client.get(f"/api/teams/{team.id}", headers=_auth(token))
    assert detail.status_code == 404

    removed = test_client.delete(
        f"/api/v1/workspaces/{workspace['id']}/agents/{team.id}",
        headers=_auth(test_token),
    )
    assert removed.status_code == 204
    denied = test_client.post(
        f"/api/v1/cloud-projects/{project['id']}/chat-agents",
        headers=_auth(token),
        json={"name": "Revoked Agent", "runtime": "wegent", "wegent_team_id": team.id},
    )
    assert denied.status_code == 422

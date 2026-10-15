# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Display-name contracts for shared and personal collaboration Agents."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.user import User
from tests.utils.agent_resources import create_runnable_wegent_team


@pytest.mark.parametrize(
    "display_name", ["123", "代码评审", "Review Agent", "", None, "   "]
)
def test_workspace_agent_names_follow_team_display_name(
    test_client: TestClient,
    test_db: Session,
    test_user: User,
    test_token: str,
    display_name: str | None,
) -> None:
    headers = {"Authorization": f"Bearer {test_token}"}
    team = create_runnable_wegent_team(
        test_db, user_id=test_user.id, name_prefix="agent"
    )
    metadata = {**team.json["metadata"]}
    if display_name is not None:
        metadata["displayName"] = display_name
    team.json = {**team.json, "metadata": metadata}
    test_db.commit()
    expected_name = (display_name or "").strip() or team.name
    workspace_response = test_client.post(
        "/api/v1/workspaces", headers=headers, json={"name": "Agent names"}
    )
    assert workspace_response.status_code == 201
    agents_url = f"/api/v1/workspaces/{workspace_response.json()['id']}/agents"

    added = test_client.post(agents_url, headers=headers, json={"team_id": team.id})

    assert added.status_code == 201
    assert added.json()["name"] == expected_name
    assert added.json()["team_id"] == team.id
    listed = test_client.get(agents_url, headers=headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["name"] == expected_name
    resources = test_client.get("/api/v1/resources", headers=headers)
    assert resources.status_code == 200
    personal_agent = next(
        row for row in resources.json()["agents"] if row["team_id"] == team.id
    )
    assert personal_agent["name"] == expected_name

    team.json = {
        **team.json,
        "metadata": {**team.json["metadata"], "displayName": "已重命名"},
    }
    test_db.commit()
    refreshed = test_client.get(agents_url, headers=headers)
    assert refreshed.status_code == 200
    assert refreshed.json()["items"][0]["name"] == "已重命名"
    assert refreshed.json()["items"][0]["team_id"] == team.id
    resources = test_client.get("/api/v1/resources", headers=headers)
    assert resources.status_code == 200
    assert (
        next(
            row["name"]
            for row in resources.json()["agents"]
            if row["team_id"] == team.id
        )
        == "已重命名"
    )
    assert team.name.startswith("agent-team-")

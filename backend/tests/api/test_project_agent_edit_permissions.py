"""CP09/CP10/CP13: project management does not transfer source ownership."""

import pytest

from app.models.delivery import ProjectChatAgent
from tests.api.test_collaboration_permission_contract import invite
from tests.api.test_collaboration_permission_contract import scope as scope


@pytest.mark.parametrize("role", ["Maintainer", "Developer", "Viewer"])
@pytest.mark.parametrize("archived", [False, True])
def test_cp10_cp13_inline_edit_capability_matches_update_authority(
    test_client, test_db, scope, role, archived
):
    invite(test_client, scope, role, project=True)
    base = f"/api/v1/cloud-projects/{scope['project']['id']}/chat-agents"
    response = test_client.post(
        base, headers=scope["owner"], json={"name": "Project definition"}
    )
    assert response.status_code == 201, response.text
    agent = response.json()
    if archived:
        response = test_client.patch(
            f"{base}/{agent['id']}",
            headers=scope["owner"],
            json={"version": agent["version"], "status": "archived"},
        )
        assert response.status_code == 200, response.text
        agent = response.json()
    response = test_client.get(
        f"{base}?include_archived={'true' if archived else 'false'}",
        headers=scope["member"],
    )
    if archived and role != "Maintainer":
        assert response.status_code == 403, response.text
    else:
        assert response.status_code == 200, response.text
        row = next(row for row in response.json() if row["id"] == agent["id"])
        assert row["canEdit"] is (role == "Maintainer")
    response = test_client.patch(
        f"{base}/{agent['id']}",
        headers=scope["member"],
        json={"version": agent["version"], "system_prompt": "Edited by administrator"},
    )
    assert response.status_code == (200 if role == "Maintainer" else 403), response.text
    stored = test_db.get(ProjectChatAgent, agent["id"])
    test_db.refresh(stored)
    assert stored.created_by_user_id == scope["space"]["owner_user_id"]
    assert stored.status == ("archived" if archived else "active")
    assert stored.metadata_json.get("system_prompt", "") == (
        "Edited by administrator" if role == "Maintainer" else ""
    )


def test_cp09_private_definition_does_not_gain_admin_edit_capability(test_db, scope):
    from app.services.project_chat.agent_permissions import can_edit_project_definition

    agent = ProjectChatAgent(
        id="private-definition",
        cloud_project_id=scope["project"]["id"],
        created_by_user_id=scope["space"]["owner_user_id"],
        metadata_json={"visibility": "private"},
    )
    assert not can_edit_project_definition(test_db, agent, scope["user"].id)


@pytest.mark.parametrize(
    "configuration",
    [
        {"system_prompt": "Cannot change a shared source"},
        {"execution_policy": {"mode": "project_pool"}},
        {"model_policy": {"mode": "user_select"}},
        {"mcp_servers": {"private": {"command": "review"}}},
    ],
)
def test_cp10_project_maintainer_does_not_gain_shared_source_edit_authority(
    test_client, test_db, scope, configuration
):
    invite(test_client, scope, "Maintainer", project=True)
    base = f"/api/v1/cloud-projects/{scope['project']['id']}/chat-agents"
    response = test_client.post(
        base, headers=scope["owner"], json={"name": "Shared source reference"}
    )
    assert response.status_code == 201, response.text
    agent = response.json()
    stored = test_db.get(ProjectChatAgent, agent["id"])
    original_metadata = {**stored.metadata_json, "wegent_team_id": 12345}
    stored.metadata_json = original_metadata
    test_db.commit()
    response = test_client.patch(
        f"{base}/{agent['id']}",
        headers=scope["member"],
        json={"version": agent["version"], **configuration},
    )
    assert response.status_code == 403, response.text
    test_db.refresh(stored)
    assert stored.metadata_json == original_metadata
    assert stored.created_by_user_id == scope["space"]["owner_user_id"]

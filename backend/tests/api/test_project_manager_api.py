"""Project AI manager API keeps configuration scoped to its project."""

from app.mcp_server.auth import MCPAuthInfo
from app.models.delivery import CloudProject


def test_project_manager_configuration_round_trip(
    test_client, test_db, test_user, test_token
) -> None:
    project = CloudProject(
        project_key="MANAGERAPI",
        name="Manager API project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-api",
    )
    test_db.add(project)
    test_db.commit()
    headers = {"Authorization": f"Bearer {test_token}"}

    initial = test_client.get(
        f"/api/v1/cloud-projects/{project.id}/project-manager", headers=headers
    )
    assert initial.status_code == 200
    assert initial.json()["enabled"] is False

    saved = test_client.put(
        f"/api/v1/cloud-projects/{project.id}/project-manager",
        headers=headers,
        json={
            "version": initial.json()["version"],
            "enabled": False,
            "agentId": "",
            "prompt": "Coordinate Issues",
            "triggers": [],
        },
    )
    assert saved.status_code == 200
    assert saved.json()["prompt"] == "Coordinate Issues"
    assert saved.json()["version"] == initial.json()["version"] + 1


def test_manager_tool_requires_bound_task_and_project_scope(
    test_client, monkeypatch
) -> None:
    from app.api.endpoints import project_automations

    path = "/api/v1/cloud-projects/42/project-manager/runs/run-1/tools/list_board_items"
    unauthenticated = test_client.post(path, json={"arguments": {}})
    assert unauthenticated.status_code == 401

    monkeypatch.setattr(
        project_automations,
        "authenticate_mcp_token",
        lambda _token: MCPAuthInfo(
            user_id=1, user_name="manager", auth_type="task", task_id=7
        ),
    )
    monkeypatch.setattr(
        project_automations.wework_space,
        "get_current_context",
        lambda _token_info: {
            "scope": "project",
            "space_id": "42",
            "manager_run_id": "run-1",
        },
    )
    monkeypatch.setitem(
        project_automations.PROJECT_MANAGER_TOOLS,
        "list_board_items",
        lambda _token_info, space_id: [{"space_id": space_id}],
    )

    accepted = test_client.post(
        path, headers={"Authorization": "Bearer task-token"}, json={"arguments": {}}
    )
    escaped = test_client.post(
        path,
        headers={"Authorization": "Bearer task-token"},
        json={"arguments": {"space_id": "43"}},
    )

    assert accepted.status_code == 200
    assert accepted.json() == [{"space_id": "42"}]
    assert escaped.status_code == 403

"""Project AI manager API keeps configuration scoped to its project."""

from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from app.mcp_server.auth import MCPAuthInfo
from app.mcp_server.tools import wework_space
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.services.auth.task_token import create_task_token


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


def test_manager_tool_uses_real_task_binding_and_enforces_read_only(
    test_client, test_db, test_user, monkeypatch
) -> None:
    project = CloudProject(
        project_key="MANAGERBOUND",
        name="Bound manager",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-bound",
        metadata_json={"task_provider": "local"},
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Project manager",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"project_manager": True},
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=str(project.id),
        source="manual",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"read_only": True},
    )
    test_db.add(run)
    project.metadata_json = {
        "task_provider": "local",
        "workflow_definition": {
            "version": 1,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "nodes": [
                {
                    "id": "work",
                    "name": "Work",
                    "kind": "my_task",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                    "required_deliverables": [],
                }
            ],
        },
        "project_manager": {
            "enabled": True,
            "automation_ids": [str(rule.id)],
        },
    }
    test_db.commit()
    monkeypatch.setattr(wework_space, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(
        wework_space.task_store,
        "get_by_id",
        lambda *_args, **_kwargs: SimpleNamespace(
            json={
                "metadata": {
                    "labels": {
                        "source": "project_automation",
                        "projectAutomationRunId": str(run.id),
                        "weworkSpaceProjectId": str(project.id),
                        "weworkSpaceTaskId": str(project.id),
                    }
                }
            }
        ),
    )
    token = create_task_token(7, 8, test_user.id, test_user.user_name)
    headers = {"Authorization": f"Bearer {token}"}
    base = f"/api/v1/cloud-projects/{project.id}/project-manager/runs/{run.id}/tools"

    context = test_client.post(
        f"{base}/get_current_context", headers=headers, json={"arguments": {}}
    )
    listed = test_client.post(
        f"{base}/list_board_items", headers=headers, json={"arguments": {}}
    )
    denied = test_client.post(
        f"{base}/create_board_item",
        headers=headers,
        json={"arguments": {"item": {"title": "Must not be created"}}},
    )
    wrong_run = test_client.post(
        f"/api/v1/cloud-projects/{project.id}/project-manager/runs/other/tools/list_board_items",
        headers=headers,
        json={"arguments": {}},
    )

    assert context.status_code == 200
    assert context.json()["scope"] == "project"
    assert context.json()["manager_run_id"] == str(run.id)
    assert listed.status_code == 200
    assert listed.json() == []
    assert denied.status_code == 403
    assert wrong_run.status_code == 403

    run.metadata_json = {"read_only": False}
    test_db.commit()
    forbidden_workflow = test_client.post(
        f"{base}/create_board_item",
        headers=headers,
        json={"arguments": {"item": {"title": "Unsafe", "workflow": {}}}},
    )
    created = test_client.post(
        f"{base}/create_board_item",
        headers=headers,
        json={"arguments": {"item": {"title": "Unassigned planning task"}}},
    )

    assert forbidden_workflow.status_code == 400
    assert created.status_code == 200
    assert created.json()["assignee_user_id"] is None
    assert created.json()["workflow"] is None
    test_db.refresh(run)
    assert [action["kind"] for action in run.metadata_json["manager_actions"]] == [
        "create"
    ]

    def fail_audit(*_args, **_kwargs) -> None:
        raise RuntimeError("audit failed")

    monkeypatch.setattr(
        wework_space.project_manager_service, "record_action", fail_audit
    )
    with pytest.raises(RuntimeError, match="audit failed"):
        test_client.post(
            f"{base}/create_board_item",
            headers=headers,
            json={"arguments": {"item": {"title": "Must roll back"}}},
        )
    test_db.rollback()
    assert (
        test_db.query(LoopItem).filter(LoopItem.title == "Must roll back").count() == 0
    )

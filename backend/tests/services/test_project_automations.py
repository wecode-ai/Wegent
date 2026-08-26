from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.services import project_automations as project_automations_module
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automations import (
    _next_run,
    project_automation_execution,
    project_automation_service,
)


def test_next_run_respects_rule_timezone():
    result = _next_run(
        "0 3 * * *",
        "Asia/Shanghai",
        datetime(2026, 8, 11, 0, 0),
    )

    assert result == datetime(2026, 8, 11, 19, 0)


@pytest.mark.parametrize("expression", ["", "not-a-cron", "0 3 *"])
def test_next_run_rejects_invalid_cron(expression: str):
    with pytest.raises(HTTPException) as exc_info:
        _next_run(expression, "UTC", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422


def test_next_run_rejects_unknown_timezone():
    with pytest.raises(HTTPException) as exc_info:
        _next_run("0 3 * * *", "Mars/Olympus", datetime(2026, 8, 11, 0, 0))

    assert exc_info.value.status_code == 422


def test_nullable_schema_uses_null_for_unset_due_at(test_db):
    assert loop_unset_datetime_for_connection(test_db.connection(), "due_at") is None


@pytest.mark.parametrize(
    ("status", "description", "expected_error"),
    [
        ("succeeded", "Completed result", None),
        ("cancelled", "Run cancelled.", None),
        ("failed", "Model is unavailable", "Model is unavailable"),
    ],
)
def test_run_view_exposes_only_failure_descriptions_as_errors(
    status: str, description: str, expected_error: str | None
):
    now = datetime(2026, 8, 14, 0, 0)
    row = SimpleNamespace(
        id="run-1",
        parent_id="rule-1",
        cloud_project_id="project-1",
        source="manual",
        status=status,
        task_id="task-1",
        backend_task_id=None,
        device_id="local-device",
        description=description,
        created_at=now,
        updated_at=now,
        completed_at=now,
        metadata_json={"scheduled_for": now.isoformat(), "timezone": "Asia/Shanghai"},
    )

    result = project_automation_service._run_view(row)

    assert result["error"] == expected_error


@pytest.mark.asyncio
async def test_due_scan_ignores_enabled_rule_from_archived_project(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = CloudProject(
        project_key="ARCHIVED",
        name="Archived project",
        created_by_user_id=1,
        storage_prefix="projects/archived",
        status="archived",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Stale schedule",
        status="enabled",
        due_at=datetime(2020, 1, 1),
        created_by_user_id=1,
        metadata_json={
            "trigger_type": "schedule",
            "cron_expression": "0 3 * * *",
            "timezone": "UTC",
        },
    )
    test_db.add(rule)
    test_db.commit()
    dispatched_rules: list[str] = []

    async def dispatch(*_args, **_kwargs) -> None:
        dispatched_rules.append(str(rule.id))

    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    dispatched = await project_automation_service.check_due(test_db)

    assert dispatched == 0
    assert dispatched_rules == []


@pytest.mark.asyncio
async def test_workflow_node_run_is_created_once_and_projects_queued_state(
    test_db, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = CloudProject(
        project_key="WORKFLOW",
        name="Workflow project",
        created_by_user_id=1,
        storage_prefix="projects/workflow",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Run test automation",
        description="Execute the workflow test stage",
        status="enabled",
        created_by_user_id=1,
        metadata_json={
            "trigger_type": "schedule",
            "timezone": "Asia/Shanghai",
            "assignment_mode": "manual",
        },
    )
    item = LoopItem(
        cloud_project_id=project.id,
        title="Workflow issue",
        description="",
        status="pending",
        created_by_user_id=1,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "execution_config": {
                    "agent_id": "agent-1",
                    "runtime_profile_id": None,
                    "model": "custom-model",
                    "workspace_binding": {
                        "type": "backend_project",
                        "projectId": 1,
                    },
                },
                "nodes": [
                    {
                        "id": "test",
                        "name": "Test",
                        "kind": "automation",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "none",
                        "automation_rule_id": None,
                        "status": "ready",
                    }
                ],
            }
        },
    )
    test_db.add_all([rule, item])
    test_db.flush()
    item.metadata_json["workflow"]["nodes"][0]["automation_rule_id"] = rule.id
    test_db.commit()
    dispatched: list[str] = []

    async def dispatch(_db, _rule, run) -> None:
        dispatched.append(str(run.id))

    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    result = await project_automation_service.run_for_workflow_node(
        test_db,
        str(project.id),
        str(rule.id),
        str(item.id),
        "test",
        1,
    )

    test_db.refresh(item)
    assert result["status"] == "pending"
    assert item.metadata_json["workflow"]["nodes"][0]["status"] == "queued"
    assert test_db.query(ProjectAutomationRun).count() == 1
    assert dispatched == [result["id"]]

    with pytest.raises(HTTPException) as exc_info:
        await project_automation_service.run_for_workflow_node(
            test_db,
            str(project.id),
            str(rule.id),
            str(item.id),
            "test",
            1,
        )

    assert exc_info.value.status_code == 409
    assert test_db.query(ProjectAutomationRun).count() == 1


@pytest.mark.asyncio
async def test_direct_workflow_node_queues_without_robot_rule(
    test_db, test_user, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = CloudProject(
        project_key="DIRECTWF",
        name="Direct workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/direct-workflow",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=project.id,
        title="Direct workflow issue",
        description="",
        status="pending",
        priority="medium",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "execution_config": {
                    "execution_device_id": "local-device",
                    "model": "custom-model",
                    "workspace_binding": {"type": "standalone"},
                },
                "nodes": [
                    {
                        "id": "develop",
                        "name": "Develop",
                        "prompt": "Implement the requested change",
                        "execution_mode": "robot",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "none",
                        "automation_rule_id": None,
                        "status": "ready",
                    }
                ],
            }
        },
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = await project_automation_service.run_direct_workflow_node(
        test_db,
        str(project.id),
        str(item.id),
        "develop",
        test_user.id,
    )

    test_db.refresh(item)
    execution = test_db.get(LoopItemExecution, result["execution_id"])
    assert execution is not None
    assert execution.executor_type == "generic_robot"
    assert execution.status == "queued"
    assert execution.agent_id == ""
    assert execution.execution_device_id == "local-device"
    assert item.metadata_json["workflow"]["nodes"][0]["status"] == "queued"
    run = test_db.get(ProjectAutomationRun, result["id"])
    assert run is not None
    assert run.parent_id == item.id
    assert run.metadata_json["workflow_node_id"] == "develop"

    profile, context = loop_item_execution_service._runtime_profile_and_context(
        test_db,
        execution=execution,
    )
    assert profile.execution_prompt == "Implement the requested change"
    assert profile.model == "custom-model"
    assert context["workspace_binding"]["type"] == "standalone"

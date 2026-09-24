from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_value_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.issue_workflow import ProjectWorkflowDefinition
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationUpdate,
    ProjectAutomationWorkflowMigration,
)
from app.services import project_automations as project_automations_module
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automation_domain import utc_aware
from app.services.project_automations import (
    _canonical_event_config,
    _next_run,
    project_automation_execution,
    project_automation_service,
)


def test_external_events_default_to_creating_an_issue() -> None:
    config = _canonical_event_config(
        "change_request.checks_failed",
        {},
    )

    assert config["execution_target"] == "create_issue"


def test_next_run_respects_rule_timezone():
    result = _next_run(
        "0 3 * * *",
        "Asia/Shanghai",
        datetime(2026, 8, 11, 0, 0),
    )

    assert result == datetime(2026, 8, 11, 19, 0)


def test_utc_aware_converts_naive_database_time_from_its_session_timezone():
    result = utc_aware(
        datetime(2026, 8, 26, 17, 18),
        timezone(timedelta(hours=8)),
    )

    assert result == datetime(2026, 8, 26, 9, 18, tzinfo=timezone.utc)


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


def _legacy_workflow_migration(
    project: CloudProject,
    user_id: int,
) -> ProjectAutomationWorkflowMigration:
    workflow = ProjectWorkflowDefinition.model_validate(
        {
            "version": 3,
            "stage_mode": "dag",
            "advancement_policy": "manual",
            "nodes": [
                {
                    "id": "implement",
                    "name": "实现",
                    "prompt": "完成 Issue 中的要求",
                    "execution_mode": "robot",
                    "execution_config": {
                        "execution_device_id": "local-device",
                        "model": "gpt-5.6-codex",
                        "workspace_binding": {"type": "standalone"},
                    },
                }
            ],
        }
    )
    return ProjectAutomationWorkflowMigration(
        project_version=project.version,
        automation=ProjectAutomationCreate(
            name="旧 Issue 编排",
            prompt="执行旧 Issue 编排",
            trigger_type="event",
            event_type="task.status_changed",
            event_config={"transition": "entered_processing"},
            assignment_mode="manual",
            role_source="generic",
            runtime_source="runtime_user",
            runtime_user_id=user_id,
        ),
        workflow_definition=workflow,
    )


def test_migrate_workflow_atomically_promotes_legacy_definition(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="MIGRATE",
        name="Migration project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/migration",
        metadata_json={
            "workflow_definition": {
                "version": 3,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [],
            }
        },
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    previous_version = project.version
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = project_automation_service.migrate_workflow(
        test_db,
        str(project.id),
        test_user.id,
        _legacy_workflow_migration(project, test_user.id),
    )

    test_db.refresh(project)
    rule = test_db.get(ProjectAutomationRule, result["workflow_automation_id"])
    assert rule is not None
    assert result["project_version"] == previous_version + 1
    assert project.metadata_json["workflow_automation_id"] == str(rule.id)
    assert project.metadata_json["workflow_definition"]["stage_mode"] == "none"
    runtime_workflow = rule.metadata_json["event_config"]["runtime_workflow_definition"]
    assert runtime_workflow["version"] == 3
    assert runtime_workflow["nodes"][0]["execution_config"]["model"] == "gpt-5.6-codex"


def test_migrate_workflow_rejects_stale_project_without_creating_rule(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="STALEMIGRATE",
        name="Stale migration project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/stale-migration",
    )
    test_db.add(project)
    test_db.commit()
    test_db.refresh(project)
    values = _legacy_workflow_migration(project, test_user.id)
    values.project_version += 1
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    with pytest.raises(HTTPException) as exc_info:
        project_automation_service.migrate_workflow(
            test_db,
            str(project.id),
            test_user.id,
            values,
        )

    assert exc_info.value.status_code == 409
    assert (
        test_db.query(ProjectAutomationRule)
        .filter(ProjectAutomationRule.cloud_project_id == project.id)
        .count()
        == 0
    )


def test_delete_canonical_workflow_clears_project_binding(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="DELETEFLOW",
        name="Delete workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/delete-workflow",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Canonical workflow",
        description="Run the complete workflow",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    test_db.add(rule)
    test_db.flush()
    project.metadata_json = {"workflow_automation_id": str(rule.id)}
    test_db.commit()
    previous_version = project.version
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = project_automation_service.delete(
        test_db,
        str(project.id),
        str(rule.id),
        test_user.id,
    )

    test_db.refresh(project)
    test_db.refresh(rule)
    assert result == {
        "project_version": previous_version + 1,
        "workflow_automation_id": None,
    }
    assert "workflow_automation_id" not in project.metadata_json
    assert not loop_datetime_value_is_unset(rule.deleted_at)


def test_list_runs_hides_internal_ai_manager_runs(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="RUNHISTORY",
        name="Run history project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/run-history",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Canonical workflow",
        description="Run the complete workflow",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.tag_added",
            "event_config": {"tags": ["review"]},
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add(rule)
    test_db.flush()
    parent_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id="issue-1",
        task_title="Visible workflow run",
        source="event",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={
            "scheduled_for": datetime(2026, 8, 25).isoformat(),
            "event": {"type": "task.tag_added", "subject_id": "issue-1"},
        },
    )
    test_db.add(parent_run)
    test_db.flush()
    child_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id="issue-1",
        task_title="Internal AI manager run",
        source="event",
        status="succeeded",
        created_by_user_id=test_user.id,
        metadata_json={
            "scheduled_for": datetime(2026, 8, 25).isoformat(),
            "workflow_parent_run_id": str(parent_run.id),
        },
    )
    test_db.add(child_run)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = project_automation_service.list_runs(
        test_db,
        str(project.id),
        str(rule.id),
        test_user.id,
    )

    assert [run["id"] for run in result] == [str(parent_run.id)]
    assert result[0]["trigger_type"] == "event"
    assert result[0]["event_type"] == "task.tag_added"
    assert result[0]["event_config"] == {"tags": ["review"]}


def test_list_runs_repairs_terminal_execution_projection(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="RUNREPAIR",
        name="Run repair project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/run-repair",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Repair terminal history",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"trigger_type": "event", "timezone": "Asia/Shanghai"},
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id="issue-1",
        task_title="Completed execution",
        source="event",
        status="queued",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 8, 26, 10, 0).isoformat()},
    )
    test_db.add(run)
    test_db.flush()
    completed_at = datetime(2026, 8, 26, 10, 1)
    test_db.add(
        LoopItemExecution(
            loop_item_id="issue-1",
            cloud_project_id=str(project.id),
            automation_run_id=str(run.id),
            agent_id="robot-1",
            status="completed",
            completed_at=completed_at,
            execution_note="Automation run completed",
        )
    )
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = project_automation_service.list_runs(
        test_db,
        str(project.id),
        str(rule.id),
        test_user.id,
    )

    assert result[0]["status"] == "succeeded"
    assert result[0]["completed_at"] == completed_at.replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_cancel_waiting_runtime_automation_run(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="CANCELWAIT",
        name="Cancel waiting runtime",
        created_by_user_id=test_user.id,
        storage_prefix="projects/cancel-waiting-runtime",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Waiting rule",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"trigger_type": "event", "timezone": "Asia/Shanghai"},
    )
    test_db.add(rule)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=project.id,
        title="Waiting runtime Issue",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    test_db.add(item)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        source="event",
        status="waiting_runtime",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 9, 14, 12, 0).isoformat()},
    )
    test_db.add(run)
    test_db.flush()
    execution = LoopItemExecution(
        loop_item_id=item.id,
        cloud_project_id=str(project.id),
        automation_run_id=str(run.id),
        executor_owner_user_id=test_user.id,
        assigner_user_id=test_user.id,
        execution_environment="local",
        status="waiting_runtime",
    )
    test_db.add(execution)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = await project_automation_service.cancel_run(
        test_db,
        str(project.id),
        str(run.id),
        test_user.id,
    )

    test_db.refresh(run)
    test_db.refresh(execution)
    assert run.status == "cancelled"
    assert execution.status == "cancelled"
    assert result["status"] == "cancelled"


def test_create_generic_manual_rule_does_not_persist_null_robot_id(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="GENERICRULE",
        name="Generic automation project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/generic-automation",
    )
    test_db.add(project)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    created = project_automation_service.create(
        test_db,
        str(project.id),
        test_user.id,
        ProjectAutomationCreate(
            name="Generic workflow",
            prompt="Run the complete workflow",
            triggerType="event",
            eventType="task.created",
            eventConfig={},
            assignmentMode="manual",
            roleSource="generic",
            agentId=None,
            runtimeSource="runtime_user",
            runtimeUserId=test_user.id,
            enabled=True,
        ),
    )

    rule = test_db.get(ProjectAutomationRule, created["id"])
    assert rule is not None
    assert rule.assignee_agent_id == ""


def test_generic_manual_rule_accepts_direct_runtime_configuration() -> None:
    rule = ProjectAutomationCreate(
        name="Direct Codex workflow",
        prompt="Run the configured node",
        triggerType="event",
        eventType="task.created",
        eventConfig={},
        assignmentMode="manual",
        roleSource="generic",
        model="gpt-5.6-codex",
        executionEnvironment="local",
        executionDeviceId="55",
        runtimeSource="runtime_user",
        runtimeUserId=1,
    )

    assert rule.model == "gpt-5.6-codex"
    assert rule.execution_environment == "local"
    assert rule.execution_device_id == "55"


def test_create_rejects_invalid_runtime_workflow_definition(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="INVALIDFLOW",
        name="Invalid workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/invalid-workflow",
    )
    test_db.add(project)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    with pytest.raises(HTTPException) as exc_info:
        project_automation_service.create(
            test_db,
            str(project.id),
            test_user.id,
            ProjectAutomationCreate(
                name="Invalid workflow",
                prompt="This definition must never be persisted",
                triggerType="schedule",
                cronExpression="8 17 * * *",
                timezone="Asia/Shanghai",
                eventConfig={
                    "runtime_workflow_definition": {
                        "version": 1,
                        "stage_mode": "dag",
                        "advancement_policy": "manual",
                        "nodes": [
                            {
                                "id": "execute",
                                "name": "",
                                "execution_mode": "robot",
                            }
                        ],
                    }
                },
                assignmentMode="manual",
                roleSource="generic",
                runtimeSource="runtime_user",
                runtimeUserId=test_user.id,
            ),
        )

    assert exc_info.value.status_code == 422
    assert str(exc_info.value.detail).startswith("自动化流程配置无效：")
    test_db.rollback()
    assert (
        test_db.query(ProjectAutomationRule)
        .filter(ProjectAutomationRule.cloud_project_id == project.id)
        .count()
        == 0
    )


def test_status_rule_create_and_update_persist_only_canonical_transition(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="STATUSRULE",
        name="Status automation project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/status-automation",
    )
    test_db.add(project)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    created = project_automation_service.create(
        test_db,
        str(project.id),
        test_user.id,
        ProjectAutomationCreate(
            name="Status workflow",
            prompt="Run when work begins",
            triggerType="event",
            eventType="task.status_changed",
            eventConfig={"statuses": ["pending", "in_progress"]},
            assignmentMode="manual",
            roleSource="generic",
            runtimeSource="runtime_user",
            runtimeUserId=test_user.id,
        ),
    )

    rule = test_db.get(ProjectAutomationRule, created["id"])
    assert rule is not None
    assert rule.metadata_json["event_config"] == {
        "transition": "entered_processing",
        "execution_target": "existing_issue",
    }


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
async def test_due_scan_dispatches_waiting_project_manager_turn(
    test_db, test_user, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = CloudProject(
        project_key="MANAGERDRAIN",
        name="Manager drain",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-drain",
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
        status="queued",
        backend_task_id=0,
        created_by_user_id=test_user.id,
    )
    test_db.add(run)
    test_db.commit()
    dispatched_runs: list[str] = []

    async def dispatch(_db, _rule, selected_run) -> None:
        dispatched_runs.append(str(selected_run.id))
        selected_run.backend_task_id = 42

    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)

    assert await project_automation_service.check_due(test_db) == 1
    assert dispatched_runs == [str(run.id)]

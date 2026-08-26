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
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automation_domain import utc_aware
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
        metadata_json={"trigger_type": "event", "timezone": "Asia/Shanghai"},
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
        metadata_json={"scheduled_for": datetime(2026, 8, 25).isoformat()},
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


@pytest.mark.parametrize(
    ("child_run_status", "execution_status", "expected_status"),
    [
        (None, None, "waiting_runtime"),
        ("queued", "queued", "queued"),
        ("running", "completed", "succeeded"),
        ("running", "failed", "failed"),
    ],
)
def test_list_runs_projects_root_workflow_execution_state(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
    child_run_status: str | None,
    execution_status: str | None,
    expected_status: str,
) -> None:
    project = CloudProject(
        project_key=f"ROOTSTATE{expected_status.upper()}",
        name=f"Root workflow {expected_status}",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/root-workflow-{expected_status}",
    )
    test_db.add(project)
    test_db.flush()
    root_rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Root workflow",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"trigger_type": "event", "timezone": "Asia/Shanghai"},
    )
    child_rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Internal workflow node",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"trigger_type": "workflow", "timezone": "Asia/Shanghai"},
    )
    test_db.add_all([root_rule, child_rule])
    test_db.flush()
    root_run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=root_rule.id,
        task_title="Workflow Issue",
        source="event",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 8, 26, 11, 0).isoformat()},
    )
    test_db.add(root_run)
    test_db.flush()
    root_run.task_id = f"issue-{root_run.id}"

    child_run = None
    if child_run_status is not None:
        child_run = ProjectAutomationRun(
            cloud_project_id=project.id,
            parent_id=child_rule.id,
            task_id=root_run.task_id,
            task_title="Workflow Issue",
            source="workflow",
            status=child_run_status,
            created_by_user_id=test_user.id,
            metadata_json={
                "workflow_parent_run_id": str(root_run.id),
                "workflow_node_id": "execute",
            },
        )
        test_db.add(child_run)
        test_db.flush()
        if execution_status is not None:
            test_db.add(
                LoopItemExecution(
                    loop_item_id=root_run.task_id,
                    cloud_project_id=str(project.id),
                    automation_run_id=str(child_run.id),
                    agent_id="robot-1",
                    status=execution_status,
                    error_message=(
                        "Runtime failed" if execution_status == "failed" else ""
                    ),
                )
            )

    node = {
        "id": "execute",
        "name": "Execute",
        "prompt": "Execute the Issue",
        "execution_mode": "robot",
        "automation_rule_id": str(child_rule.id),
        "depends_on": [],
        "required": True,
        "status": "ready" if child_run is None else "queued",
        "automation_run_id": str(child_run.id) if child_run is not None else None,
    }
    if child_run is not None:
        node["execution_config"] = {
            "execution_device_id": "local-device",
            "model": "gpt-5.6-codex",
            "workspace_binding": {"type": "standalone"},
        }
    item = LoopItem(
        id=root_run.task_id,
        cloud_project_id=project.id,
        title="Workflow Issue",
        status="in_progress",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow_automation": {
                "rule_id": str(root_rule.id),
                "run_id": str(root_run.id),
            },
            "workflow": {
                "version": 1,
                "definition_version": 1,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [node],
            },
        },
    )
    test_db.add(item)
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = project_automation_service.list_runs(
        test_db,
        str(project.id),
        str(root_rule.id),
        test_user.id,
    )

    assert result[0]["status"] == expected_status
    if expected_status == "failed":
        assert result[0]["error"] == "Runtime failed"


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
    assert "Invalid automation workflow definition" in str(exc_info.value.detail)
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
    assert rule.metadata_json["event_config"] == {"transition": "entered_processing"}

    project_automation_service.update(
        test_db,
        str(project.id),
        str(rule.id),
        test_user.id,
        ProjectAutomationUpdate(
            version=rule.version,
            eventConfig={
                "statuses": ["pending"],
                "transition": "unsupported_transition",
            },
        ),
    )

    test_db.refresh(rule)
    assert rule.metadata_json["event_config"] == {"transition": "entered_processing"}


@pytest.mark.asyncio
@pytest.mark.parametrize("trigger", ["event", "manual", "scheduled"])
async def test_complete_flow_dispatch_uses_issue_workflow_engine_for_every_trigger(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
    trigger: str,
) -> None:
    project = CloudProject(
        project_key=f"FLOW{trigger.upper()}",
        name=f"{trigger} flow project",
        created_by_user_id=test_user.id,
        storage_prefix=f"projects/{trigger}-flow",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=project.id,
        title=f"{trigger} flow Issue",
        description="",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json=(
            {}
            if trigger == "event"
            else {
                "workflow": {
                    "version": 1,
                    "definition_version": 1,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "project-default",
                            "name": "Project default",
                            "prompt": "Must not replace the automation-owned workflow",
                            "execution_mode": "human",
                            "depends_on": [],
                            "required": True,
                            "status": "ready",
                        }
                    ],
                }
            }
        ),
    )
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Complete flow",
        description="Run the complete DAG",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event" if trigger == "event" else "schedule",
            "event_config": {
                "runtime_workflow_definition": {
                    "version": 2,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "implement",
                            "name": "实现",
                            "prompt": "实现需求",
                            "execution_mode": "robot",
                            "execution_config": {
                                "execution_device_id": "local-device",
                                "model": "gpt-5.6-codex",
                                "workspace_binding": {"type": "standalone"},
                            },
                        }
                    ],
                }
            },
            "action": "execute",
            "role": {"source": "generic", "agent_id": None},
            "runtime": {"source": "runtime_user", "user_id": test_user.id},
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add_all([item, rule])
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id if trigger == "event" else "",
        task_title=item.title if trigger == "event" else "",
        source=trigger,
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 8, 25).isoformat()},
    )
    test_db.add(run)
    test_db.commit()
    start = AsyncMock(return_value=1)
    monkeypatch.setattr(issue_workflow_start_service, "start", start)

    def ensure_task(_db, **kwargs) -> None:
        kwargs["run"].task_id = item.id
        kwargs["run"].task_title = item.title

    monkeypatch.setattr(project_automation_execution, "_ensure_run_task", ensure_task)

    await project_automation_execution.dispatch(test_db, rule, run)

    test_db.refresh(item)
    test_db.refresh(run)
    assert run.status == "pending"
    assert item.metadata_json["workflow_automation"] == {
        "rule_id": str(rule.id),
        "run_id": str(run.id),
    }
    assert run.metadata_json["task_origin"] == (
        "existing_issue" if trigger == "event" else "automation_created"
    )
    workflow_node = item.metadata_json["workflow"]["nodes"][0]
    assert workflow_node["id"] == "implement"
    assert workflow_node["status"] == "ready"
    assert workflow_node["execution_config"]["model"] == "gpt-5.6-codex"
    start.assert_awaited_once()


@pytest.mark.asyncio
async def test_scheduled_workflow_creates_issue_binds_dag_and_queues_automatic_node(
    test_db,
    test_user,
) -> None:
    project = CloudProject(
        project_key="SCHEDULED",
        name="Scheduled workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/scheduled-workflow",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Scheduled automatic workflow",
        description="Run the configured DAG",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "schedule",
            "cron_expression": "8 17 * * *",
            "event_config": {
                "runtime_workflow_definition": {
                    "version": 1,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "execute",
                            "name": "执行任务",
                            "prompt": "执行 pwd",
                            "execution_mode": "robot",
                            "depends_on": [],
                            "workspace_policy": "none",
                            "execution_config": {
                                "execution_device_id": "local-device",
                                "model": "gpt-5.6-codex",
                                "workspace_binding": {"type": "standalone"},
                            },
                        }
                    ],
                }
            },
            "action": "execute",
            "role": {"source": "generic", "agent_id": None},
            "runtime": {"source": "runtime_user", "user_id": test_user.id},
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        source="scheduled",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 8, 26, 9, 8).isoformat()},
    )
    test_db.add(run)
    test_db.commit()

    await project_automation_execution.dispatch(test_db, rule, run)

    test_db.refresh(run)
    assert run.task_id
    item = test_db.get(LoopItem, run.task_id)
    assert item is not None
    assert item.metadata_json["workflow_automation"] == {
        "rule_id": str(rule.id),
        "run_id": str(run.id),
    }
    node = item.metadata_json["workflow"]["nodes"][0]
    assert node["id"] == "execute"
    assert node["status"] == "queued"
    child_run = (
        test_db.query(ProjectAutomationRun)
        .filter(
            ProjectAutomationRun.task_id == item.id,
            ProjectAutomationRun.id != run.id,
        )
        .one()
    )
    assert child_run.status == "queued"
    assert child_run.metadata_json["workflow_parent_run_id"] == str(run.id)
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(child_run.id))
        .one()
    )
    assert execution.status == "queued"
    assert execution.execution_device_id == "local-device"


@pytest.mark.asyncio
async def test_complete_flow_adopts_existing_legacy_issue_snapshot(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = CloudProject(
        project_key="ADOPTLEGACY",
        name="Adopt legacy workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/adopt-legacy-workflow",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=project.id,
        title="Existing legacy Issue",
        description="",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={
            "workflow": {
                "version": 2,
                "definition_version": 2,
                "stage_mode": "dag",
                "advancement_policy": "manual",
                "nodes": [
                    {
                        "id": "legacy-node",
                        "name": "Legacy node",
                        "prompt": "Continue the existing snapshot",
                        "execution_mode": "human",
                        "depends_on": [],
                        "required": True,
                        "status": "ready",
                    }
                ],
            }
        },
    )
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Canonical workflow",
        description="Run the canonical workflow",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.status_changed",
            "event_config": {
                "runtime_workflow_definition": {
                    "version": 3,
                    "stage_mode": "dag",
                    "advancement_policy": "manual",
                    "nodes": [
                        {
                            "id": "new-node",
                            "name": "New node",
                            "prompt": "Only future Issues use this node",
                            "execution_mode": "human",
                        }
                    ],
                }
            },
            "action": "execute",
            "role": {"source": "generic", "agent_id": None},
            "runtime": {"source": "runtime_user", "user_id": test_user.id},
            "timezone": "Asia/Shanghai",
        },
    )
    test_db.add_all([item, rule])
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        task_title=item.title,
        source="event",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={"scheduled_for": datetime(2026, 8, 25).isoformat()},
    )
    test_db.add(run)
    test_db.commit()
    start = AsyncMock(return_value=0)
    monkeypatch.setattr(issue_workflow_start_service, "start", start)

    def ensure_task(_db, **_kwargs) -> None:
        return None

    monkeypatch.setattr(project_automation_execution, "_ensure_run_task", ensure_task)

    await project_automation_execution.dispatch(test_db, rule, run)

    test_db.refresh(item)
    test_db.refresh(run)
    assert [node["id"] for node in item.metadata_json["workflow"]["nodes"]] == [
        "legacy-node"
    ]
    assert item.metadata_json["workflow_automation"]["run_id"] == str(run.id)
    assert run.status == "running"
    start.assert_awaited_once()


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


@pytest.mark.asyncio
async def test_inherited_direct_stage_queues_for_app_target_with_executor_workspace(
    test_db, test_user, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = CloudProject(
        project_key="INHERITWF",
        name="Inherited workflow project",
        created_by_user_id=test_user.id,
        storage_prefix="projects/inherited-workflow",
    )
    test_db.add(project)
    test_db.flush()
    item = LoopItem(
        cloud_project_id=project.id,
        title="Inherited workflow issue",
        description="",
        status="in_progress",
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
                        "prompt": "Implement",
                        "execution_mode": "robot",
                        "depends_on": [],
                        "required": True,
                        "workspace_policy": "composer",
                        "automation_rule_id": None,
                        "status": "completed",
                    },
                    {
                        "id": "verify",
                        "name": "Verify",
                        "prompt": "Verify the implementation",
                        "execution_mode": "robot",
                        "depends_on": ["develop"],
                        "required": True,
                        "workspace_policy": "inherit",
                        "automation_rule_id": None,
                        "status": "ready",
                    },
                ],
            }
        },
    )
    test_db.add(item)
    test_db.flush()
    test_db.add(
        LoopItemTaskBinding(
            cloud_project_id=str(project.id),
            loop_item_id=item.id,
            task_user_id=test_user.id,
            device_id="executor-runtime-device",
            task_id="previous-runtime-task",
            linked_by_user_id=test_user.id,
            metadata_json={
                "workflow_node_id": "develop",
                "workspace_device_id": "local-device",
            },
        )
    )
    test_db.commit()
    monkeypatch.setattr(
        project_automations_module, "require_cloud_project_role", lambda *_args: None
    )

    result = await project_automation_service.run_direct_workflow_node(
        test_db,
        str(project.id),
        str(item.id),
        "verify",
        test_user.id,
    )

    execution = test_db.get(LoopItemExecution, result["execution_id"])
    assert execution is not None
    assert execution.status == "queued"
    assert execution.execution_device_id == "local-device"
    assert execution.runtime_request["workspaceSourceTask"] == {
        "deviceId": "local-device",
        "taskId": "previous-runtime-task",
    }

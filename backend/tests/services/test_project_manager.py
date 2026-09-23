"""Project manager boundaries shared by manual and event runs."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import event

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.project_manager import ProjectManagerConfig, ProjectManagerTrigger
from app.services.project_automation_execution import project_automation_execution
from app.services.project_manager import project_manager_service


def test_approved_manager_assignment_schedules_after_commit(
    test_db, test_user, monkeypatch
) -> None:
    from app.services import board_team_execution, project_manager
    from app.services.loop_item_executions import wake

    project = CloudProject(
        project_key="MANAGERAPPROVE",
        name="Manager approval",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-approval",
        metadata_json={"task_provider": "local"},
    )
    test_db.add(project)
    test_db.flush()
    agent = ProjectChatAgent(
        id="approval-agent",
        cloud_project_id=project.id,
        title="Approval agent",
        name="Approval agent",
        status="active",
        created_by_user_id=test_user.id,
        metadata_json={"runtime": "wegent", "wegent_team_id": 21},
    )
    item = LoopItem(
        id="APPROVE-1",
        cloud_project_id=project.id,
        title="Approve this Issue",
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json={},
    )
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Project manager",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"project_manager": True},
    )
    test_db.add_all([agent, item, rule])
    test_db.flush()
    action = {
        "id": "approval-action",
        "kind": "assign",
        "item_id": item.id,
        "item_version": item.version,
        "status": "pending_confirmation",
        "payload": {"assignee_type": "agent", "assignee_id": agent.id},
    }
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=str(project.id),
        source="manual",
        status="running",
        created_by_user_id=test_user.id,
        metadata_json={"manager_actions": [action]},
    )
    test_db.add(run)
    test_db.commit()
    committed = False
    scheduled = []
    woken = []

    def after_commit(_session) -> None:
        nonlocal committed
        committed = True

    def assign(db, **_kwargs):
        item.assignee_agent_id = agent.id
        db.add(
            LoopItemExecution(
                loop_item_id=item.id,
                cloud_project_id=str(project.id),
                agent_id=agent.id,
                team_id=21,
                executor_owner_user_id=test_user.id,
                assigner_user_id=test_user.id,
                execution_environment="wegent",
                status="queued",
            )
        )
        db.flush()
        return item

    event.listen(test_db, "after_commit", after_commit)
    monkeypatch.setattr(
        project_manager,
        "require_cloud_project_role",
        lambda *_args: SimpleNamespace(project=project),
    )
    monkeypatch.setattr(project_manager.loop_item_service, "assign", assign)
    monkeypatch.setattr(
        board_team_execution,
        "schedule_board_robot_execution",
        lambda _db, execution: scheduled.append((committed, execution.id)),
    )
    monkeypatch.setattr(
        wake,
        "wake_robot_creator",
        lambda **kwargs: woken.append((committed, kwargs["agent_id"])),
    )

    result = project_manager_service.decide_change(
        test_db,
        project_id=str(project.id),
        run_id=run.id,
        action_id=action["id"],
        user_id=test_user.id,
        approve=True,
        version=item.version,
    )

    assert result["status"] == "executed"
    assert len(scheduled) == 1 and scheduled[0][0] is True
    assert woken == [(True, agent.id)]


def test_manager_config_requires_unique_trigger_ids() -> None:
    trigger = ProjectManagerTrigger(
        id="created", kind="event", event_type="task.created"
    )
    with pytest.raises(ValueError, match="unique"):
        ProjectManagerConfig(
            version=1,
            enabled=True,
            agent_id="agent-1",
            prompt="Coordinate Issues",
            triggers=[trigger, trigger],
        )


def test_manager_rejects_overlapping_processing_rule(test_db, test_user) -> None:
    project = CloudProject(
        project_key="MANAGERCONFLICT",
        name="Manager conflict",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-conflict",
    )
    test_db.add(project)
    test_db.flush()
    test_db.add(
        ProjectAutomationRule(
            cloud_project_id=project.id,
            title="Existing automation",
            description="Process created tasks",
            status="enabled",
            created_by_user_id=test_user.id,
            updated_by_user_id=test_user.id,
            metadata_json={
                "trigger_type": "event",
                "event_type": "task.created",
                "event_config": {"tags": []},
            },
        )
    )
    test_db.commit()

    with pytest.raises(HTTPException) as error:
        project_manager_service._check_conflicts(
            test_db,
            project,
            [
                ProjectManagerTrigger(
                    id="created", kind="event", event_type="task.created"
                )
            ],
        )

    assert error.value.status_code == 409


def test_manager_query_completes_without_issue_assignment(
    test_db, test_user, monkeypatch
) -> None:
    project = CloudProject(
        project_key="MANAGERQUERY",
        name="Manager query",
        created_by_user_id=test_user.id,
        storage_prefix="projects/manager-query",
    )
    test_db.add(project)
    test_db.flush()
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Project manager",
        description="Coordinate Issues",
        status="enabled",
        created_by_user_id=test_user.id,
        updated_by_user_id=test_user.id,
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
        metadata_json={},
    )
    test_db.add(run)
    test_db.commit()
    monkeypatch.setattr(project_automation_execution, "_activity", lambda *_args: None)
    monkeypatch.setattr(
        project_automation_execution,
        "_commit_and_push_activity",
        lambda db, *_args, **_kwargs: db.commit(),
    )

    changed = project_automation_execution.finalize_manager_result(
        test_db, run_id=run.id, content="The board has three open Issues."
    )

    assert changed is True
    assert test_db.get(ProjectAutomationRun, run.id).status == "succeeded"


@pytest.mark.parametrize("status_value", ["cancelled", "failed"])
def test_terminal_manager_run_is_not_rewritten_as_success(
    test_db, monkeypatch, status_value: str
) -> None:
    run = ProjectAutomationRun(status=status_value)
    activity = SimpleNamespace(status=status_value)
    monkeypatch.setattr(project_automation_execution, "_activity", lambda *_: activity)

    changed = project_automation_execution._finalize_project_manager_result(
        test_db,
        run=run,
        content="Late model response",
        backend_task_id=None,
        push_activity=False,
    )

    assert changed is False
    assert run.status == status_value
    assert activity.status == status_value

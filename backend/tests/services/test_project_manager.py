"""Project manager boundaries shared by manual and event runs."""

import pytest
from fastapi import HTTPException

from app.models.delivery import (
    CloudProject,
    ProjectAutomationRule,
    ProjectAutomationRun,
)
from app.schemas.project_manager import ProjectManagerConfig, ProjectManagerTrigger
from app.services.project_automation_execution import project_automation_execution
from app.services.project_manager import project_manager_service


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

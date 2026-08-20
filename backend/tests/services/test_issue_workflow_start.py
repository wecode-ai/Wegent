from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.project_automations import (
    project_automation_processor,
    project_automation_service,
)


def workflow(*, advancement_policy: str = "manual") -> dict:
    return {
        "version": 1,
        "definition_version": 1,
        "stage_mode": "dag" if advancement_policy == "manual" else "none",
        "advancement_policy": advancement_policy,
        "ai_automation_rule_id": (
            "ai-manager-rule" if advancement_policy == "ai" else None
        ),
        "nodes": (
            [
                {
                    "id": "automated",
                    "name": "Automated",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "none",
                    "automation_rule_id": "stage-rule",
                    "status": "ready",
                },
                {
                    "id": "human",
                    "name": "Human",
                    "depends_on": [],
                    "required": True,
                    "workspace_policy": "composer",
                    "automation_rule_id": None,
                    "status": "ready",
                },
                {
                    "id": "blocked",
                    "name": "Blocked",
                    "depends_on": ["automated"],
                    "required": True,
                    "workspace_policy": "none",
                    "automation_rule_id": "blocked-rule",
                    "status": "blocked",
                },
            ]
            if advancement_policy == "manual"
            else []
        ),
    }


@pytest.mark.asyncio
async def test_start_runs_only_ready_automated_stages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = AsyncMock(return_value={"id": "run-1"})
    monkeypatch.setattr(project_automation_service, "run_for_workflow_node", run)
    item = SimpleNamespace(
        id="ISSUE-1",
        cloud_project_id="11",
        metadata_json={"workflow": workflow()},
    )
    db = SimpleNamespace()

    started = await issue_workflow_start_service.start(
        db,
        item=item,
        project=SimpleNamespace(id=11, task_provider="local"),
        user_id=7,
    )

    assert started == 1
    run.assert_awaited_once_with(
        db,
        "11",
        "stage-rule",
        "ISSUE-1",
        "automated",
        7,
    )


@pytest.mark.asyncio
async def test_start_dispatches_ai_coordinator_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = AsyncMock(return_value=1)
    planning_run = SimpleNamespace(
        id="workflow-run-1",
        metadata_json={"plan_version": 1},
    )
    monkeypatch.setattr(project_automation_processor, "process", process)
    monkeypatch.setattr(
        issue_workflow_planning_service,
        "ensure_run",
        lambda *_args, **_kwargs: planning_run,
    )
    monkeypatch.setattr(issue_workflow_start_service, "_has_run", lambda *_args: False)
    item = SimpleNamespace(
        id="ISSUE-2",
        cloud_project_id="11",
        title="Coordinate this Issue",
        description="",
        status="pending",
        priority="none",
        metadata_json={"workflow": workflow(advancement_policy="ai"), "tags": []},
    )
    project = SimpleNamespace(id=11, task_provider="local")

    started = await issue_workflow_start_service.start(
        SimpleNamespace(),
        item=item,
        project=project,
        user_id=7,
    )

    assert started == 1
    process.assert_awaited_once()
    assert process.await_args.kwargs["automation_id"] == "ai-manager-rule"
    assert process.await_args.args[1].payload["workflow_run_id"] == planning_run.id

    monkeypatch.setattr(issue_workflow_start_service, "_has_run", lambda *_args: True)
    assert (
        await issue_workflow_start_service.start(
            SimpleNamespace(),
            item=item,
            project=project,
            user_id=7,
        )
        == 0
    )
    process.assert_awaited_once()


@pytest.mark.asyncio
async def test_start_without_ai_rule_does_not_create_planning_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ensure_run = MagicMock()
    monkeypatch.setattr(issue_workflow_planning_service, "ensure_run", ensure_run)

    started = await issue_workflow_start_service._start_ai(
        SimpleNamespace(),
        SimpleNamespace(
            id="ISSUE-3",
            cloud_project_id="11",
        ),
        SimpleNamespace(id=11, task_provider="local"),
        SimpleNamespace(ai_automation_rule_id=None),
        7,
    )

    assert started == 0
    ensure_run.assert_not_called()

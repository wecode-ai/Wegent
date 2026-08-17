# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime boundaries for manual assignment and AI-managed assignment."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.project_automation_domain import assignment_mode, manager_type
from app.services.project_automation_execution import ProjectAutomationExecution


@pytest.mark.parametrize("value", [{}, {"assignment_mode": "automatic"}])
def test_assignment_mode_rejects_missing_or_unknown_rules(value):
    with pytest.raises(ValueError, match="missing or invalid"):
        assignment_mode(value)


@pytest.mark.parametrize("value", [{"manager_type": "robot"}])
def test_manager_type_rejects_unknown_sources(value):
    with pytest.raises(ValueError, match="invalid"):
        manager_type(value)


def _dispatch_objects(configuration: dict[str, object]):
    owner = SimpleNamespace(id=7)
    project = SimpleNamespace(id="project-1")
    rule = SimpleNamespace(
        id="rule-1",
        title="Assign new task",
        description="Choose by capability.",
        assignee_agent_id="agent-1",
        created_by_user_id=owner.id,
        cloud_project_id=project.id,
        metadata_json=configuration,
    )
    run = SimpleNamespace(
        id="run-1",
        status="pending",
        source="manual",
        task_id="task-1",
        metadata_json={},
    )
    db = MagicMock()
    db.get.side_effect = lambda model, _key: (
        owner if model.__name__ == "User" else project
    )
    return db, owner, project, rule, run


@pytest.mark.asyncio
async def test_manual_assignment_enters_only_existing_project_robot_path(monkeypatch):
    service = ProjectAutomationExecution()
    db, _owner, _project, rule, run = _dispatch_objects({"assignment_mode": "manual"})
    monkeypatch.setattr(service, "_ensure_run_task", MagicMock())
    assign = MagicMock()
    custom = MagicMock()
    wegent = AsyncMock()
    monkeypatch.setattr(service, "_assign_project_robot", assign)
    monkeypatch.setattr(service, "_dispatch_custom_manager", custom)
    monkeypatch.setattr(service, "_dispatch_wegent_manager", wegent)

    await service.dispatch(db, rule, run)

    assign.assert_called_once()
    assert assign.call_args.kwargs["agent_id"] == "agent-1"
    custom.assert_not_called()
    wegent.assert_not_awaited()


@pytest.mark.asyncio
async def test_custom_ai_is_only_a_manager_transport(monkeypatch):
    service = ProjectAutomationExecution()
    db, _owner, _project, rule, run = _dispatch_objects(
        {"assignment_mode": "ai_managed", "manager_type": "custom"}
    )
    activity = SimpleNamespace(message_id="manager-message")
    monkeypatch.setattr(service, "_ensure_run_task", MagicMock())
    monkeypatch.setattr(
        service, "_create_manager_activity", MagicMock(return_value=activity)
    )
    assign = MagicMock()
    custom = MagicMock()
    wegent = AsyncMock()
    monkeypatch.setattr(service, "_assign_project_robot", assign)
    monkeypatch.setattr(service, "_dispatch_custom_manager", custom)
    monkeypatch.setattr(service, "_dispatch_wegent_manager", wegent)

    await service.dispatch(db, rule, run)

    custom.assert_called_once()
    assign.assert_not_called()
    wegent.assert_not_awaited()


@pytest.mark.asyncio
async def test_wegent_agent_is_only_a_manager_transport(monkeypatch):
    service = ProjectAutomationExecution()
    db, _owner, _project, rule, run = _dispatch_objects(
        {"assignment_mode": "ai_managed", "manager_type": "wegent"}
    )
    activity = SimpleNamespace(message_id="manager-message")
    monkeypatch.setattr(service, "_ensure_run_task", MagicMock())
    monkeypatch.setattr(
        service, "_create_manager_activity", MagicMock(return_value=activity)
    )
    assign = MagicMock()
    custom = MagicMock()
    wegent = AsyncMock()
    monkeypatch.setattr(service, "_assign_project_robot", assign)
    monkeypatch.setattr(service, "_dispatch_custom_manager", custom)
    monkeypatch.setattr(service, "_dispatch_wegent_manager", wegent)

    await service.dispatch(db, rule, run)

    wegent.assert_awaited_once()
    assign.assert_not_called()
    custom.assert_not_called()


def test_manager_prompt_is_minimal_visible_assignment_input():
    service = ProjectAutomationExecution()
    project = SimpleNamespace(
        id="project-1",
        project_key="PRJ",
        title="Project",
        name="Project",
        description="",
        task_provider="local",
    )
    prompt = service._managed_prompt(
        MagicMock(),
        owner=SimpleNamespace(id=7),
        project=project,
        rule=SimpleNamespace(description="Prefer domain ownership."),
        run=SimpleNamespace(id="run-1", task_id="task-1"),
        context={"trigger": "event"},
    )

    assert prompt == (
        "project_id: project-1\n"
        "task_id: task-1\n"
        "automation_run_id: run-1\n\n"
        "看板任务数据位于 cloud://projects/project-1/todos/task-1，"
        "请通过看板工具自行查看。\n\n"
        "请读取候选执行者并按调度要求完成分派，不要执行任务。\n\n"
        "Prefer domain ownership."
    )

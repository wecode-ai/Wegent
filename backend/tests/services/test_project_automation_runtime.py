# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Runtime boundaries for manual assignment and AI-managed assignment."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.issue_workflow_planning import issue_workflow_planning_service
from app.services.project_automation_domain import (
    ProjectAutomationEvent,
    assignment_mode,
    manager_type,
)
from app.services.project_automation_execution import (
    ProjectAutomationExecution,
    ProjectAutomationProcessor,
    project_automation_execution,
)


@pytest.mark.parametrize("value", [{}, {"action": "automatic"}])
def test_assignment_mode_rejects_missing_or_unknown_rules(value):
    with pytest.raises(ValueError, match="missing or invalid"):
        assignment_mode(value)


@pytest.mark.parametrize("value", [{"manager": {"type": "robot"}}])
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
async def test_event_processing_wakes_cloud_executor_after_dispatch(monkeypatch):
    rule = SimpleNamespace(
        id="rule-1",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    query = MagicMock()
    query.filter.return_value = query
    query.all.return_value = [rule]
    db = MagicMock()
    db.query.return_value = query
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    with patch(
        "app.tasks.robot_queue_tasks.consume_queues_background",
        new=AsyncMock(),
    ) as wake:
        dispatched = await processor.process(
            db,
            ProjectAutomationEvent(
                event_type="task.created",
                project_id="project-1",
                subject_id="task-1",
                source="local",
                actor_user_id=7,
                payload={"title": "Wake immediately"},
            ),
        )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, rule, run)
    wake.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_ai_workflow_defers_only_its_coordinator_rule(monkeypatch):
    coordinator = SimpleNamespace(
        id="coordinator-rule",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    ordinary = SimpleNamespace(
        id="ordinary-rule",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    query = MagicMock()
    query.filter.return_value = query
    query.all.return_value = [coordinator, ordinary]
    db = MagicMock()
    db.query.return_value = query
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    dispatched = await processor.process(
        db,
        ProjectAutomationEvent(
            event_type="task.created",
            project_id="project-1",
            subject_id="task-1",
            source="local",
            actor_user_id=7,
            payload={
                "title": "AI workflow task",
                "workflow": {
                    "advancement_policy": "ai",
                    "ai_automation_rule_id": coordinator.id,
                    "execution_config": {
                        "execution_device_id": None,
                        "model": None,
                    },
                },
            },
        ),
    )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, ordinary, run)


@pytest.mark.asyncio
async def test_ai_workflow_uses_coordinator_rule_runtime_when_no_override(monkeypatch):
    coordinator = SimpleNamespace(
        id="coordinator-rule",
        status="enabled",
        metadata_json={
            "trigger_type": "event",
            "event_type": "task.created",
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="",
        task_title="",
        metadata_json={},
    )
    rule_query = MagicMock()
    rule_query.filter.return_value = rule_query
    rule_query.all.return_value = [coordinator]
    issue = SimpleNamespace(
        id="task-1",
        cloud_project_id="project-1",
        metadata_json={},
    )
    issue_query = MagicMock()
    issue_query.filter.return_value = issue_query
    issue_query.one_or_none.return_value = issue
    planning_run = SimpleNamespace(
        id="workflow-run-1",
        metadata_json={"plan_version": 1},
    )
    db = MagicMock()
    db.query.side_effect = [rule_query, issue_query]
    dispatch = AsyncMock()
    monkeypatch.setattr(project_automation_execution, "dispatch", dispatch)
    monkeypatch.setattr(
        issue_workflow_planning_service,
        "ensure_run",
        MagicMock(return_value=planning_run),
    )
    processor = ProjectAutomationProcessor(run_factory=MagicMock(return_value=run))

    dispatched = await processor.process(
        db,
        ProjectAutomationEvent(
            event_type="task.created",
            project_id="project-1",
            subject_id="task-1",
            source="local",
            actor_user_id=7,
            payload={
                "title": "AI workflow task",
                "workflow": {
                    "advancement_policy": "ai",
                    "ai_automation_rule_id": coordinator.id,
                    "execution_config": None,
                },
            },
        ),
    )

    assert dispatched == 1
    dispatch.assert_awaited_once_with(db, coordinator, run)
    assert run.metadata_json["event"]["payload"]["workflow_run_id"] == planning_run.id
    assert run.metadata_json["event"]["payload"]["workflow_plan_version"] == 1


@pytest.mark.asyncio
async def test_manual_assignment_enters_only_existing_project_robot_path(monkeypatch):
    service = ProjectAutomationExecution()
    db, _owner, _project, rule, run = _dispatch_objects(
        {"action": "execute", "role": {"source": "agent"}}
    )
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
        {"action": "ai_assign", "manager": {"type": "custom"}}
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
        {
            "action": "ai_assign",
            "manager": {"type": "wegent", "wegent_team_id": 42},
        }
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


@pytest.mark.asyncio
async def test_wegent_manager_dispatch_reads_team_from_manager_config(monkeypatch):
    service = ProjectAutomationExecution()
    db = MagicMock()
    owner = SimpleNamespace(id=7)
    project = SimpleNamespace(id="project-1")
    rule = SimpleNamespace(
        id="rule-1",
        title="Assign new task",
        metadata_json={
            "action": "ai_assign",
            "manager": {"type": "wegent", "wegent_team_id": 42},
        },
    )
    run = SimpleNamespace(
        id="run-1",
        task_id="task-1",
        status="pending",
        version=1,
        backend_task_id=0,
    )
    activity = SimpleNamespace(message_id="message-1")
    refreshed_activity = SimpleNamespace(metadata_json={}, status="pending")
    db.get.return_value = run
    db.query.return_value.filter.return_value.one.return_value = refreshed_activity
    monkeypatch.setattr(service, "_managed_prompt", MagicMock(return_value="prompt"))

    with (
        patch(
            "app.services.project_automation_execution.runnable_wegent_team",
            return_value=SimpleNamespace(id=42),
        ) as resolve_team,
        patch(
            "app.services.project_automation_managed_execution."
            "project_automation_managed_execution_service.dispatch",
            new=AsyncMock(return_value=SimpleNamespace(task_id=101, subtask_id=202)),
        ),
        patch(
            "app.services.project_automation_execution.project_chat_service.to_view",
            return_value=MagicMock(model_dump=MagicMock(return_value={})),
        ),
        patch("app.services.project_automation_execution.push_project_chat_message"),
    ):
        await service._dispatch_wegent_manager(
            db,
            owner=owner,
            project=project,
            rule=rule,
            run=run,
            activity=activity,
            context={},
        )

    resolve_team.assert_called_once_with(db, owner.id, 42)
    assert run.backend_task_id == 101
    assert run.status == "queued"


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
        "你是看板的 AI 管家，只负责编排，不执行具体任务。"
        "请读取当前 Issue 和候选执行者，将工作拆成可独立验收的子任务，"
        "然后调用 submit_workflow_plan 提交结构化方案。"
        "方案项不需要提供 stage_id，平台会绑定当前活动规划范围；"
        "不要查询、猜测或伪造阶段标识。"
        "不要直接修改原 Issue 的负责人。\n\n"
        "Prefer domain ownership."
    )


def test_manager_prompt_prefers_run_instruction_override():
    prompt = ProjectAutomationExecution._managed_prompt(
        MagicMock(),
        owner=SimpleNamespace(id=7),
        project=SimpleNamespace(id="project-1"),
        rule=SimpleNamespace(description="Default instruction."),
        run=SimpleNamespace(
            id="run-1",
            task_id="task-1",
            metadata_json={"instruction_override": "Stage-specific instruction."},
        ),
        context={"trigger": "workflow"},
    )

    assert prompt.endswith("Stage-specific instruction.")
    assert "Default instruction." not in prompt


def test_manager_activity_binding_persists_execution_identity(monkeypatch):
    activity = SimpleNamespace(
        metadata_json={
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
        }
    )
    execution = SimpleNamespace(
        id=61,
        executor_type="automation_manager",
        execution_device_id="device-1",
    )
    find_activity = MagicMock(return_value=activity)
    monkeypatch.setattr(ProjectAutomationExecution, "_activity", find_activity)

    ProjectAutomationExecution._bind_activity_to_execution(
        MagicMock(),
        run=SimpleNamespace(id="run-1"),
        execution=execution,
    )

    assert activity.metadata_json == {
        "assignment_mode": "ai_managed",
        "manager_type": "custom",
        "execution_id": 61,
        "executor_type": "automation_manager",
        "run_status": "queued",
        "execution_device_id": "device-1",
    }


def test_manager_plan_submission_rejects_non_owner_before_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProjectAutomationExecution()
    run = SimpleNamespace(status="running", created_by_user_id=8)
    db = MagicMock()
    db.get.return_value = run
    find_activity = MagicMock()
    monkeypatch.setattr(service, "_activity", find_activity)

    with pytest.raises(RuntimeError, match="does not own"):
        service.record_manager_plan_submission(
            db,
            run_id="run-1",
            user_id=7,
            workflow_run_id="workflow-run-1",
            plan_version=1,
        )

    find_activity.assert_not_called()
    db.flush.assert_not_called()
    db.commit.assert_not_called()


def test_manager_plan_submission_rejects_stale_workflow_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = ProjectAutomationExecution()
    run = SimpleNamespace(
        id="run-1",
        status="running",
        created_by_user_id=7,
        task_id="issue-1",
        metadata_json={
            "event": {"payload": {"workflow_run_id": "workflow-run-current"}}
        },
    )
    activity = SimpleNamespace(metadata_json={})
    stale_workflow_run = SimpleNamespace(
        parent_id="issue-1",
        metadata_json={},
    )
    db = MagicMock()
    db.get.side_effect = [run, stale_workflow_run]
    monkeypatch.setattr(service, "_activity", MagicMock(return_value=activity))

    with pytest.raises(RuntimeError, match="no longer active"):
        service.record_manager_plan_submission(
            db,
            run_id="run-1",
            user_id=7,
            workflow_run_id="workflow-run-stale",
            plan_version=2,
        )

    assert stale_workflow_run.metadata_json == {}
    assert activity.metadata_json == {}
    db.flush.assert_not_called()
    db.commit.assert_not_called()

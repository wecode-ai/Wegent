# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Automation instructions reach the AI request without rewriting the Issue."""

from unittest.mock import patch

import pytest
from sqlalchemy.orm import Session

from app.models.delivery import ProjectAutomationRule, ProjectAutomationRun
from app.models.loop_item_execution import LoopItemExecution
from app.models.user import User
from app.schemas.project_automation import ProjectAutomationCreate
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automation_execution import project_automation_execution
from app.services.project_automations import project_automation_service
from tests.services.test_loop_item_assignment import (
    _collaboration_group,
    _make_bot,
    _make_item,
    _make_project,
)
from tests.utils.agent_resources import create_runnable_wegent_team


@pytest.fixture(autouse=True)
def isolate_notification_delivery():
    with patch("app.core.async_utils.schedule_async_task"):
        yield


@pytest.mark.asyncio
@pytest.mark.parametrize("target_kind", ["agent", "collaboration_group"])
@pytest.mark.parametrize("environment", ["local", "cloud"])
@pytest.mark.parametrize("override", [None, "只分析本轮变更，不修改文件。"])
async def test_saved_prompt_reaches_ai_runtime_request(
    test_db: Session,
    test_user: User,
    target_kind: str,
    environment: str,
    override: str | None,
) -> None:
    project = _make_project(test_db, test_user)
    group, manager, _member = _collaboration_group(
        test_db, project, test_user, execution_environment=environment
    )
    item = _make_item(test_db, project, test_user)
    item.description = "Business requirements must remain unchanged."
    original_description = item.description
    test_db.commit()
    prompt = "检查状态自动化的执行结果。\n输出可验证的审查证据。"
    effective_prompt = prompt if override is None else override

    with patch(
        "app.services.workspaces.workspace_service.list_project_collaboration_groups",
        return_value=[group],
    ):
        saved = project_automation_service.create(
            test_db,
            str(project.id),
            test_user.id,
            ProjectAutomationCreate(
                name="Review the existing Issue",
                prompt=prompt,
                trigger_type="manual",
                target_kind=target_kind,
                target_id=(manager.id if target_kind == "agent" else str(group["id"])),
            ),
        )
        rule = test_db.get(ProjectAutomationRule, saved["id"])
        assert rule is not None and rule.description == prompt
        assert saved["prompt"] == prompt
        run = ProjectAutomationRun(
            cloud_project_id=project.id,
            parent_id=rule.id,
            task_id=item.id,
            status="pending",
            created_by_user_id=test_user.id,
            metadata_json=(
                {"instruction_override": override} if override is not None else {}
            ),
        )
        test_db.add(run)
        test_db.commit()

        await project_automation_execution.dispatch(test_db, rule, run)

    test_db.expire_all()
    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(run.id))
        .one()
    )
    assert run.status == "queued"
    assert execution.execution_environment == environment
    assert effective_prompt in execution.runtime_origin_context["execution_prompt"]
    request = loop_item_execution_service._persist_runtime_request_intent(
        test_db, execution=execution
    )
    test_db.commit()
    assert effective_prompt in request.message
    assert request.message.count(effective_prompt) == 1
    assert request.origin["run_id"] == str(run.id)
    assert f"task_id: {item.id}" in request.message
    assert execution.runtime_request["message"] == request.message
    test_db.refresh(item)
    assert item.description == original_description
    if override is not None:
        assert prompt not in request.message
    if target_kind == "collaboration_group":
        assert original_description in request.message
        assert group["instructions"] in request.message
        assert manager.id in request.message
        continuation = loop_item_execution_service.enqueue_for_assignment(
            test_db,
            loop_item_id=item.id,
            cloud_project_id=str(project.id),
            agent=manager,
            assigner_user_id=test_user.id,
            environment=environment,
            execution_device_id=manager.device_id,
            priority=None,
            automation_context={
                **execution.runtime_origin_context,
                "collaboration_dispatch_execution_id": execution.id,
                "comment_continue_task_id": execution.runtime_task_id,
            },
        )
        profile, context = loop_item_execution_service._runtime_profile_and_context(
            test_db, execution=continuation
        )
        assert effective_prompt in profile.execution_prompt
        assert (
            context["execution_prompt"]
            == execution.runtime_origin_context["execution_prompt"]
        )


@pytest.mark.parametrize("override", [None, "Apply the current workflow instruction."])
def test_existing_team_assignment_retains_effective_prompt(
    test_db: Session, test_user: User, override: str | None
) -> None:
    project = _make_project(test_db, test_user)
    item = _make_item(test_db, project, test_user)
    item.description = "Keep the original Issue requirements."
    team = create_runnable_wegent_team(
        test_db, user_id=test_user.id, name_prefix="automation-prompt"
    )
    _make_bot(test_db, project, test_user, runtime="wegent", wegent_team_id=team.id)
    rule = ProjectAutomationRule(
        cloud_project_id=project.id,
        title="Existing Team automation",
        description="Review the configured automation requirements.",
        status="enabled",
        created_by_user_id=test_user.id,
        metadata_json={"dispatch_target": {"kind": "agent", "id": str(team.id)}},
    )
    test_db.add(rule)
    test_db.flush()
    run = ProjectAutomationRun(
        cloud_project_id=project.id,
        parent_id=rule.id,
        task_id=item.id,
        status="pending",
        created_by_user_id=test_user.id,
        metadata_json=(
            {"instruction_override": override} if override is not None else {}
        ),
    )
    test_db.add(run)
    test_db.commit()

    project_automation_execution._assign_team_target(
        test_db,
        owner=test_user,
        rule=rule,
        run=run,
        team_id=str(team.id),
        workflow_step=None,
        context=project_automation_execution._automation_context(test_db, rule, run),
    )

    execution = (
        test_db.query(LoopItemExecution)
        .filter(LoopItemExecution.automation_run_id == str(run.id))
        .one()
    )
    assert run.status == "queued"
    assert execution.executor_type == "wegent_team"
    assert execution.runtime_origin_context["execution_prompt"] == (
        rule.description if override is None else override
    )
    test_db.refresh(item)
    assert item.description == "Keep the original Issue requirements."

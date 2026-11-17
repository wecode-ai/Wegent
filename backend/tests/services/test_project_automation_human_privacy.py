"""Shared automation receipts preserve the personal Runtime privacy boundary."""

import pytest

from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_automation_human import project_human_execution
from app.services.project_automations import project_automation_service
from tests.services.test_project_automation_human_delivery import (
    _dispatch,
    human_automation,
)


@pytest.mark.asyncio
async def test_personal_runtime_address_is_recipient_only(
    test_db, test_user, human_automation
):
    item, run, execution, _, _ = await _dispatch(test_db, test_user)
    message = ProjectChatMessage(
        message_id="human-automation-activity",
        project_id=str(item.cloud_project_id),
        task_id=item.id,
    )
    test_db.add(message)
    run.metadata_json = {
        **run.metadata_json,
        "activity_message_id": message.message_id,
    }
    test_db.flush()
    execution.status = "running"
    execution.observed_state = "running"
    project_human_execution(test_db, execution=execution)
    test_db.commit()

    owner = project_automation_service._run_view(run, viewer_user_id=test_user.id)
    other = project_automation_service._run_view(run, viewer_user_id=test_user.id + 1)
    anonymous = project_automation_service._run_view(run)
    assert owner["human_automation"]["runtime_task_id"] == "design-task"
    assert owner["human_automation"]["endpoint_ref"]
    for context in (
        other["human_automation"],
        anonymous["human_automation"],
        message.metadata_json["human_automation"],
    ):
        assert (
            not {"runtime_device_id", "runtime_task_id", "endpoint_ref"}
            & context.keys()
        )
        assert context["execution_id"] == str(execution.id)
        assert context["workflow_stage_id"] == "ux_spec"
    assert not message.runtime_device_id
    assert not message.runtime_task_id


@pytest.mark.asyncio
async def test_manual_retry_returns_the_existing_human_execution(
    test_db, test_user, human_automation
):
    item, run, execution, _, _ = await _dispatch(test_db, test_user)
    execution.status = "failed"
    execution.termination_reason = "Runtime failed"
    project_human_execution(test_db, execution=execution)
    test_db.commit()
    count = test_db.query(LoopItemExecution).count()

    result = await project_automation_service.retry_run(
        test_db, str(item.cloud_project_id), run.id, test_user.id
    )

    assert result["id"] == run.id
    assert result["status"] == "failed"
    assert result["retryable"] is False
    assert result["human_automation"]["execution_id"] == str(execution.id)
    assert test_db.query(LoopItemExecution).count() == count

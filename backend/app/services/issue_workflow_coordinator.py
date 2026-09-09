# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execute Issue-owned coordinators without creating reusable automation rules."""

from uuid import uuid4

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectAutomationRun, ProjectWorkflowRun
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.issue_workflow import IssueWorkflowInstance
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.runtime_profiles import runtime_profile_service
from shared.telemetry.decorators import trace_async


@trace_async()
async def start_issue_coordinator(
    db: Session,
    *,
    item: LoopItem,
    workflow: IssueWorkflowInstance,
    planning_run: ProjectWorkflowRun,
    user_id: int,
) -> dict:
    config = workflow.execution_config
    if config is None or not config.is_complete() or not config.runtime_profile_id:
        raise ValueError("Issue coordinator requires a complete Runtime profile")
    profile = runtime_profile_service.require_runnable(
        db, config.runtime_profile_id, user_id
    )
    values = dict(profile.metadata_json or {})
    run = ProjectAutomationRun(
        cloud_project_id=item.cloud_project_id,
        parent_id=item.id,
        task_id=item.id,
        task_title=item.title,
        source="workflow",
        status="pending",
        created_by_user_id=user_id,
        metadata_json={
            "issue_coordinator": True,
            "trigger": "workflow",
            "instruction_override": workflow.coordinator_prompt,
            "workflow_execution_config": config.model_dump(mode="json"),
            "event": {
                "source": "workflow",
                "payload": {
                    "workflow_run_id": str(planning_run.id),
                    "workflow_plan_version": workflow.active_plan_version,
                },
            },
        },
    )
    db.add(run)
    db.flush()
    planning_run.metadata_json = {
        **(planning_run.metadata_json or {}),
        "project_automation_run_id": str(run.id),
    }
    message_id = str(uuid4())
    activity = ProjectChatMessage(
        message_id=message_id,
        client_message_id=message_id,
        project_id=str(item.cloud_project_id),
        task_id=item.id,
        sender_type="agent",
        sender_id=f"issue_coordinator:{item.id}",
        sender_name="工单 AI",
        message_type="text",
        content="",
        status="queued",
        metadata_json={
            "kind": "project_automation_run",
            "automation_run_id": str(run.id),
            "assignment_mode": "ai_managed",
            "manager_type": "custom",
        },
    )
    db.add(activity)
    run.metadata_json = {**run.metadata_json, "activity_message_id": message_id}
    db.flush()
    context = loop_item_execution_service._automation_runtime_context(run, None)
    context.update(
        runtime_source="fixed_profile",
        runtime_profile_id=profile.id,
        runtime_subject_user_id=user_id,
        activity_message_id=message_id,
    )
    execution = loop_item_execution_service.enqueue_automation_manager(
        db,
        loop_item_id=item.id,
        cloud_project_id=str(item.cloud_project_id),
        owner_user_id=user_id,
        assigner_user_id=user_id,
        environment=values["execution_environment"],
        execution_device_id=profile.device_id,
        priority=item.priority,
        automation_context=context,
        runtime_selection={
            "runtime_source": "fixed_profile",
            "runtime_profile_id": profile.id,
            "runtime_profile_version": profile.version,
            "model": config.model,
            "model_type": config.model_type,
            "model_options": config.model_options,
        },
    )
    run.device_id = execution.execution_device_id
    run.status = "queued"
    from app.services.project_automation_execution import project_automation_execution

    project_automation_execution._bind_activity_to_execution(
        db, run=run, execution=execution
    )
    db.commit()
    return {"id": str(run.id), "status": run.status, "execution_id": execution.id}

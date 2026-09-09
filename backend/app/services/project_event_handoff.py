# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Transactional experience creation and resumable event-to-Issue handoff."""

import logging
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectIncomingEvent,
    loop_datetime_is_unset,
)
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import (
    ProjectWorkflowDefinition,
    WorkflowExecutionConfig,
    instantiate_workflow,
)
from app.schemas.project_event_center import EventRoutingDecision, ExternalReference
from app.services.project_event_center import metadata, project_event_center_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


def create_issue_experience(
    db: Session,
    event: ProjectIncomingEvent,
    decision: EventRoutingDecision,
    user_id: int,
) -> ProjectWorkflowDefinition:
    """Build an Issue-owned snapshot without publishing an automation rule."""
    from app.services.runtime_profiles import runtime_profile_service

    config = metadata(db.get(CloudProject, event.cloud_project_id))["event_center"]
    profile = runtime_profile_service.require_runnable(
        db, config["runtime_profile_id"], user_id
    )
    values = metadata(profile)
    execution = WorkflowExecutionConfig(
        runtime_profile_id=profile.id,
        execution_device_id=profile.device_id,
        model=values["model"],
        model_type=values.get("model_type"),
        model_options=values.get("model_options") or {},
        workspace_binding=config.get("workspace_binding") or {"type": "standalone"},
    )
    draft = decision.workflow
    return ProjectWorkflowDefinition(
        stage_mode="dag",
        advancement_policy="ai",
        approval_policy="automatic",
        coordinator_prompt=draft.coordinator_prompt,
        execution_config=execution,
        nodes=[
            {
                "id": f"role_{index + 1}",
                "name": role.name,
                "prompt": role.instruction,
                "execution_mode": "robot",
                "depends_on": [f"role_{index}"] if index else [],
                "workspace_policy": "composer",
            }
            for index, role in enumerate(draft.roles)
        ],
    )


def prepare_handoff(
    db: Session,
    *,
    event: ProjectIncomingEvent,
    decision: EventRoutingDecision,
    user_id: int,
) -> None:
    from app.services.loop_items.service import loop_item_service
    from app.services.project_automations import project_automation_service

    issue = None
    if decision.issue_id:
        issue = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == decision.issue_id,
                LoopItem.cloud_project_id == event.cloud_project_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .with_for_update()
            .one_or_none()
        )
        if issue is None:
            raise HTTPException(404, "Related Issue not found in this board")
    if decision.action == "route_existing":
        if not metadata(issue).get("workflow"):
            raise HTTPException(
                422, "Select or create an experience for this existing Issue"
            )
    else:
        if issue is not None and metadata(issue).get("workflow"):
            raise HTTPException(409, "Route the event to the existing Issue workflow")
        if decision.action == "create_workflow":
            definition = create_issue_experience(db, event, decision, user_id)
        else:
            rule = project_automation_service._rule(
                db, event.cloud_project_id, decision.automation_id
            )
            if rule.status != "enabled":
                raise HTTPException(409, "Selected automation is disabled")
            raw = (
                metadata(rule)
                .get("event_config", {})
                .get("runtime_workflow_definition")
            )
            if not raw:
                raise HTTPException(
                    422, "Selected automation has no experience definition"
                )
            definition = ProjectWorkflowDefinition.model_validate(raw)
            event.metadata_json = {**metadata(event), "automation_id": rule.id}
        snapshot = instantiate_workflow(definition)
        if issue is None:
            issue = loop_item_service.create(
                db,
                event.cloud_project_id,
                user_id,
                LoopItemCreate(
                    title=event.title, description=decision.goal, workflow=snapshot
                ),
                commit=False,
                assign_creator_if_unassigned=False,
            )
        else:
            values = snapshot.model_dump(mode="json")
            values.update(intent=decision.goal, coordinator_user_id=user_id)
            issue.metadata_json = {**metadata(issue), "workflow": values}
    if reference := metadata(event).get("reference"):
        project_event_center_service.bind_reference(
            db,
            str(event.cloud_project_id),
            issue.id,
            user_id,
            ExternalReference.model_validate(reference),
        )
    event.loop_item_id = issue.id
    event.status = "dispatching"
    db.add(
        ProjectChatMessage(
            message_id=str(uuid4()),
            project_id=str(event.cloud_project_id),
            task_id=issue.id,
            sender_type="system",
            sender_id="event_center",
            sender_name="事件中心",
            message_type="text",
            content=event.description or event.title,
            metadata_json={
                "incoming_event_id": event.id,
                "routing_reason": decision.reason,
            },
            status="completed",
        )
    )
    workflow = dict(metadata(issue).get("workflow") or {})
    workflow["incoming_events"] = [
        *workflow.get("incoming_events", []),
        {
            "id": event.id,
            "title": event.title,
            "content": event.description,
            "clarifications": metadata(event).get("history", []),
        },
    ]
    workflow["assignment_version"] = int(workflow.get("assignment_version") or 0) + 1
    # Active work keeps ownership. Its next coordinator turn reads the event inbox.
    if workflow.get("orchestration_status") == "completed":
        workflow.update(orchestration_status="planning", active_run_id=None)
    values = {**metadata(issue), "workflow": workflow}
    if workflow.get("orchestration_status") in {"idle", "planning"}:
        from app.services.loop_item_status_history import (
            project_board_config,
            write_status_change,
        )

        project = db.get(CloudProject, event.cloud_project_id)
        processing = project_board_config(project).processing_start_status_id
        if processing and issue.status != processing:
            write_status_change(
                values,
                project=project,
                from_status=issue.status,
                to_status=processing,
                trigger="incoming_event",
                by_user_id=user_id,
            )
            issue.status = processing
    issue.metadata_json = values
    issue.version += 1
    db.flush()


@trace_async()
async def resume_handoff(db: Session, event_id: str) -> None:
    from app.services.issue_workflow_start import issue_workflow_start_service
    from app.services.loop_item_events import publish_loop_item_changed

    event = (
        db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.id == event_id)
        .with_for_update()
        .one()
    )
    if event.status not in {"dispatching", "handoff_failed"}:
        return
    issue = db.get(LoopItem, event.loop_item_id)
    project = db.get(CloudProject, event.cloud_project_id)
    owner_id = int(metadata(event)["owner_user_id"])
    try:
        started = await issue_workflow_start_service.start(
            db, item=issue, project=project, user_id=owner_id
        )
        db.refresh(issue)
        workflow = metadata(issue).get("workflow") or {}
        from app.services.issue_workflow_planning import issue_workflow_planning_service

        manager = (
            issue_workflow_planning_service.manager_automation_run(
                db, workflow_run_id=workflow["active_run_id"]
            )
            if workflow.get("active_run_id")
            else None
        )
        coordinator_pending = manager is not None and manager.status in {
            "pending",
            "queued",
            "waiting_runtime",
            "waiting_device",
            "running",
        }
        if (
            not started
            and not coordinator_pending
            and workflow.get("orchestration_status")
            not in {
                "running",
                "waiting_human",
                "paused",
                "completed",
            }
        ):
            raise RuntimeError(
                "The Issue workflow could not start; check its Runtime and experience configuration"
            )
        db.refresh(event)
        event.status = "routed"
        event.metadata_json = {**metadata(event), "error": None}
        event.version += 1
        db.commit()
    except Exception:
        db.rollback()
        event = db.get(ProjectIncomingEvent, event_id)
        event.status = "handoff_failed"
        event.version += 1
        event.metadata_json = {
            **metadata(event),
            "error": "Flow AI handoff failed; retry this event to continue the same Issue",
        }
        db.commit()
        raise
    publish_loop_item_changed(
        db, item=issue, reason="incoming_event", actor_user_id=owner_id
    )


@trace_async()
async def recover_handoffs(db: Session) -> int:
    events = (
        db.query(ProjectIncomingEvent)
        .filter(ProjectIncomingEvent.status == "dispatching")
        .limit(100)
        .all()
    )
    recovered = 0
    for event in events:
        try:
            await resume_handoff(db, event.id)
            recovered += 1
        except Exception:
            logger.exception("Event handoff recovery failed event=%s", event.id)
    return recovered

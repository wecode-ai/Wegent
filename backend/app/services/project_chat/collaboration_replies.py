"""Publish native collaboration messages under their recorded project Agent."""

import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.issue_activity_comment import CollaborationPublicReply
from app.schemas.project_chat import ProjectChatCommentExecution, ProjectChatMessageView
from app.services.collaboration_group_execution import (
    collaboration_group_snapshot_for_dispatch,
)
from app.services.collaboration_revocation import execution_authorized
from app.services.device.identity import same_owned_device
from app.services.loop_item_executions.runtime_identity import (
    execution_conversation_task_id,
)
from app.services.project_chat.public_replies import (
    existing_public_reply,
    public_reply_key,
    public_reply_view,
    save_public_reply,
)
from app.services.project_chat.runtime_binding import (
    collaboration_manager_task_id,
    collaboration_member_assignment,
)
from app.services.project_chat.service import ReplyContext, project_chat_service
from shared.telemetry.decorators import trace_sync


def _reply_author(
    db: Session, *, dispatch: LoopItemExecution, identity: CollaborationPublicReply
) -> tuple[str, ProjectChatMessage | None]:
    manager_id = dispatch.runtime_origin_context.get("manager_agent_id")
    if identity.task_id == execution_conversation_task_id(dispatch):
        return manager_id or "", None
    activities = (
        db.query(ProjectChatMessage)
        .filter_by(
            project_id=dispatch.cloud_project_id,
            task_id=dispatch.loop_item_id,
            runtime_task_id=identity.task_id,
        )
        .filter(loop_datetime_is_unset(ProjectChatMessage.deleted_at))
        .order_by(ProjectChatMessage.id.desc())
    )
    for activity in activities:
        metadata = activity.metadata_json or {}
        if metadata.get("dispatch_id") != identity.dispatch_id:
            continue
        if metadata.get("activity_type") == "member_execution":
            request = ProjectChatCommentExecution(
                project_id=dispatch.cloud_project_id,
                task_id=dispatch.loop_item_id,
                trigger_message_id=activity.message_id,
            )
            collaboration_member_assignment(db, request, activity)
            return activity.agent_id, activity
        if (
            metadata.get("activity_type") == "manager_execution"
            and activity.agent_id == manager_id
            and collaboration_manager_task_id(db, dispatch, activity)
            == identity.task_id
        ):
            return activity.agent_id, None
    # A member can speak before the Executor's running report creates the activity.
    raise HTTPException(425, "Collaboration session activity is not recorded")


def _reply_context(
    db: Session,
    *,
    dispatch: LoopItemExecution,
    identity: CollaborationPublicReply,
    reply_to_comment_id: str | None,
) -> ReplyContext:
    trigger_id = identity.trigger_comment_id
    if trigger_id and reply_to_comment_id:
        raise HTTPException(422, "Choose one Issue reply target")
    if trigger_id:
        continuations = db.query(LoopItemExecution).filter_by(
            cloud_project_id=dispatch.cloud_project_id,
            loop_item_id=dispatch.loop_item_id,
            executor_owner_user_id=dispatch.executor_owner_user_id,
            runtime_task_id=identity.task_id,
        )
        if not any(
            row.runtime_origin_context.get("comment_trigger_message_id") == trigger_id
            and row.runtime_origin_context.get("dispatch_id") == identity.dispatch_id
            for row in continuations
        ):
            raise HTTPException(409, "The comment does not match this execution turn")
    return project_chat_service._resolve_reply_context(
        db,
        project_id=dispatch.cloud_project_id,
        task_id=dispatch.loop_item_id,
        reply_to_message_id=trigger_id or reply_to_comment_id,
    )


@trace_sync("collaboration.public_issue_reply", tracer_name="backend.project_chat")
def publish_collaboration_reply(
    db: Session,
    *,
    user_id: int,
    project_id: str,
    item_id: str,
    body: str,
    identity: CollaborationPublicReply,
    reply_to_comment_id: str | None = None,
) -> ProjectChatMessageView:
    project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=project_id,
        task_id=item_id,
        required_role=BaseRole.Developer,
    )
    item = (
        db.query(LoopItem)
        .filter_by(id=item_id, cloud_project_id=project_id, resource_type="task")
        .filter(loop_datetime_is_unset(LoopItem.deleted_at))
        .populate_existing()
        .with_for_update()
        .one_or_none()
    )
    if item is None:
        raise HTTPException(404, "Issue not found")
    dispatch = next(
        (
            run
            for run in db.query(LoopItemExecution).filter_by(
                cloud_project_id=project_id,
                loop_item_id=item_id,
            )
            if run.executor_type == "collaboration_group_dispatch"
            and run.runtime_origin_context.get("dispatch_id") == identity.dispatch_id
        ),
        None,
    )
    if (
        dispatch is None
        or dispatch.executor_owner_user_id != user_id
        or not same_owned_device(
            db,
            user_id=user_id,
            left_device_id=dispatch.runtime_device_id,
            right_device_id=identity.device_id,
        )
    ):
        raise HTTPException(403, "Collaboration execution is not owned by the caller")
    collaboration_group_snapshot_for_dispatch(item=item, execution=dispatch)
    if not execution_authorized(db, dispatch):
        raise HTTPException(403, "Collaboration execution authority is revoked")
    agent_id, member_activity = _reply_author(db, dispatch=dispatch, identity=identity)
    agent = db.get(ProjectChatAgent, agent_id)
    if (
        agent is None
        or agent.status != "active"
        or str(agent.cloud_project_id) != project_id
    ):
        raise HTTPException(409, "Collaboration Agent is unavailable")
    key = public_reply_key(
        project_id,
        item_id,
        dispatch.runtime_device_id,
        identity.task_id,
        identity.message_id,
    )
    reply = _reply_context(
        db,
        dispatch=dispatch,
        identity=identity,
        reply_to_comment_id=reply_to_comment_id,
    )
    existing = existing_public_reply(db, sender_id=agent_id, key=key, body=body)
    if existing is not None:
        if existing.reply_to_message_id != (reply.reply_to_message_id or ""):
            raise HTTPException(
                409, "The public message identity has another reply target"
            )
        return public_reply_view(db, existing)
    message_id = str(uuid.uuid4())
    row = ProjectChatMessage(
        message_id=message_id,
        client_message_id=key,
        project_id=project_id,
        task_id=item_id,
        sender_type="agent",
        sender_id=agent_id,
        sender_name=agent.title or agent.name,
        agent_id=agent_id,
        message_type="text",
        content=body,
        reply_to_message_id=reply.reply_to_message_id or "",
        trigger_message_id=reply.reply_to_message_id or "",
        metadata_json={
            "execution_dispatch": "comment_only",
            "collaboration_public_reply": True,
            "dispatch_id": identity.dispatch_id,
            **(
                {"collaboration_member_activity_id": member_activity.message_id}
                if member_activity is not None
                else {"manager_runtime_task_id": identity.task_id}
            ),
        },
        status="completed",
        thread_root_message_id=reply.root_message_id or message_id,
    )
    if reply.reply_to_message_id:
        guided_response = (
            db.query(ProjectChatMessage)
            .filter_by(
                project_id=project_id,
                task_id=item_id,
                trigger_message_id=reply.reply_to_message_id,
                runtime_task_id=identity.task_id,
                agent_id=agent_id,
                status="streaming",
            )
            .filter(
                ProjectChatMessage.metadata_json["collaboration_guidance"].as_boolean()
                == True  # noqa: E712
            )
            .first()
        )
        if guided_response is not None:
            guided_response.status = "completed"
            guided_response.metadata_json = {
                **guided_response.metadata_json,
                "run_status": "completed",
            }
    return save_public_reply(
        db, item=item, row=row, item_metadata=item.metadata_json or {}
    )

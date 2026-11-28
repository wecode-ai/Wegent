"""Publish native collaboration messages under their recorded project Agent."""

import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, ProjectChatAgent, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.issue_activity_comment import CollaborationPublicReply
from app.schemas.project_chat import (
    ProjectChatCommentExecution,
    ProjectChatMention,
    ProjectChatMessageView,
)
from app.services.collaboration_group_execution import (
    collaboration_group_snapshot_for_dispatch,
)
from app.services.collaboration_revocation import (
    execution_authorized,
    execution_permission,
)
from app.services.device.identity import same_owned_device
from app.services.loop_item_executions.runtime_identity import (
    execution_conversation_task_id,
)
from app.services.project_chat.mention_notification import (
    notify_project_chat_mentions,
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
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_sync


def _reply_author(
    db: Session, *, dispatch: LoopItemExecution, identity: CollaborationPublicReply
) -> tuple[str, ProjectChatMessage | None]:
    manager_id = dispatch.runtime_origin_context.get("manager_agent_id")
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
    initial_manager_session = identity.task_id == execution_conversation_task_id(
        dispatch
    )
    for activity in activities:
        metadata = activity.metadata_json or {}
        if (
            initial_manager_session
            and metadata.get("dispatch_role") == "manager"
            and (
                not metadata.get("activity_type")
                or metadata.get("activity_type") == "manager_execution"
            )
        ):
            return manager_id or "", activity
        if (
            metadata.get("dispatch_role") == "member"
            and metadata.get("execution_id")
            and metadata.get("activity_type") != "member_execution"
        ):
            member = (
                db.query(LoopItemExecution)
                .filter_by(
                    id=metadata["execution_id"],
                    cloud_project_id=dispatch.cloud_project_id,
                    loop_item_id=dispatch.loop_item_id,
                    agent_id=activity.agent_id,
                    runtime_task_id=identity.task_id,
                    executor_owner_user_id=dispatch.executor_owner_user_id,
                )
                .one_or_none()
            )
            if member is None:
                continue
            context = member.runtime_origin_context
            if (
                context.get("dispatch_role") == "member"
                and context.get("collaboration_dispatch_execution_id") == dispatch.id
                and context.get("dispatch_id") == identity.dispatch_id
                and same_owned_device(
                    db,
                    user_id=member.executor_owner_user_id,
                    left_device_id=member.runtime_device_id,
                    right_device_id=identity.device_id,
                )
            ):
                if not execution_permission(db, member, for_comment=True).allowed:
                    raise HTTPException(403, "Member execution authority is revoked")
                return member.agent_id, activity
            continue
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
            return activity.agent_id, activity
    if initial_manager_session:
        return manager_id or "", None
    # A member can speak before the Executor's running report creates the activity.
    raise HTTPException(425, "Collaboration session activity is not recorded")


def _continuation_activity(
    db: Session,
    *,
    dispatch: LoopItemExecution,
    identity: CollaborationPublicReply,
    agent_id: str,
) -> ProjectChatMessage | None:
    trigger_id = identity.execution_trigger_comment_id or identity.trigger_comment_id
    if not trigger_id:
        return None
    if identity.trigger_comment_id not in (None, trigger_id):
        raise HTTPException(422, "The reply and execution have different triggers")
    continuations = db.query(LoopItemExecution).filter_by(
        cloud_project_id=dispatch.cloud_project_id,
        loop_item_id=dispatch.loop_item_id,
        executor_owner_user_id=dispatch.executor_owner_user_id,
        runtime_task_id=identity.task_id,
    )
    execution = next(
        (
            row
            for row in continuations
            if row.runtime_origin_context.get("comment_trigger_message_id")
            == trigger_id
            and row.runtime_origin_context.get("dispatch_id") == identity.dispatch_id
        ),
        None,
    )
    if execution is None:
        raise HTTPException(409, "The comment does not match this execution turn")
    return (
        db.query(ProjectChatMessage)
        .filter_by(
            project_id=dispatch.cloud_project_id,
            task_id=dispatch.loop_item_id,
            sender_type="agent",
            agent_id=agent_id,
            trigger_message_id=trigger_id,
        )
        .filter(
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            ProjectChatMessage.metadata_json["execution_id"].as_integer()
            == execution.id,
        )
        .first()
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
    mentions: list[ProjectChatMention] | None = None,
) -> ProjectChatMessageView:
    project = project_chat_service._require_scope(
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
    agent_id, activity = _reply_author(db, dispatch=dispatch, identity=identity)
    member_activity = activity is not None and (
        (activity.metadata_json or {}).get("dispatch_role") == "member"
        or (activity.metadata_json or {}).get("activity_type") == "member_execution"
    )
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
    mention_metadata = [mention.model_dump(by_alias=True) for mention in mentions or []]
    if identity.trigger_comment_id and reply_to_comment_id:
        raise HTTPException(422, "Choose one Issue reply target")
    mirror = (
        _continuation_activity(
            db, dispatch=dispatch, identity=identity, agent_id=agent_id
        )
        or activity
    )
    explicit_target = identity.trigger_comment_id or reply_to_comment_id
    reply_target = explicit_target
    if identity.phase == "output" and identity.turn_id and not reply_target:
        start_key = public_reply_key(
            project_id,
            item_id,
            dispatch.runtime_device_id,
            identity.task_id,
            identity.turn_id,
        )
        start = (
            db.query(ProjectChatMessage)
            .filter_by(
                project_id=project_id,
                task_id=item_id,
                sender_type="agent",
                sender_id=agent_id,
                client_message_id=start_key,
            )
            .filter(
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                ProjectChatMessage.metadata_json["collaboration_turn_start"]
                .as_boolean()
                .is_(True),
            )
            .first()
        )
        if start is None:
            raise HTTPException(425, "Issue turn start comment has not been published")
        reply_target = start.message_id
    reply = project_chat_service._resolve_reply_context(
        db,
        project_id=project_id,
        task_id=item_id,
        reply_to_message_id=reply_target,
    )
    existing = existing_public_reply(db, sender_id=agent_id, key=key, body=body)
    status_reply_key = ProjectChatMessage.metadata_json[
        "collaboration_public_reply_key"
    ].as_string()
    if existing is None and not member_activity:
        existing = (
            db.query(ProjectChatMessage)
            .filter_by(project_id=project_id, task_id=item_id, agent_id=agent_id)
            .filter(status_reply_key == key)
            .first()
        )
        if existing is not None and existing.content != body.strip():
            raise HTTPException(
                409, "The public message identity already has different content"
            )
    if existing is not None:
        status_alias = (existing.metadata_json or {}).get(
            "collaboration_public_reply_key"
        ) == key
        expected_target = (
            "" if status_alias and not explicit_target else reply.reply_to_message_id
        )
        if existing.reply_to_message_id != (expected_target or ""):
            raise HTTPException(
                409, "The public message identity has another reply target"
            )
        if (existing.metadata_json or {}).get("mentions", []) != mention_metadata:
            raise HTTPException(
                409, "The public message identity has different mentions"
            )
        return public_reply_view(db, existing)
    if (
        not member_activity
        and not explicit_target
        and not mentions
        and identity.phase != "start"
    ):
        status_comments = (
            db.query(ProjectChatMessage)
            .filter_by(
                project_id=project_id,
                task_id=item_id,
                agent_id=agent_id,
                runtime_task_id=identity.task_id,
                content=body.strip(),
            )
            .filter(
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
                status_reply_key.is_(None),
                ProjectChatMessage.metadata_json["activity_type"].as_string()
                == "manager_status_comment",
                ProjectChatMessage.metadata_json["dispatch_id"].as_string()
                == identity.dispatch_id,
            )
        )
        if activity is not None:
            status_comments = status_comments.filter(
                ProjectChatMessage.id > activity.id
            )
        status_comment = status_comments.order_by(ProjectChatMessage.id.desc()).first()
        if status_comment is not None:
            # Keep the status command's own client message identity intact.
            status_comment.metadata_json = {
                **status_comment.metadata_json,
                "collaboration_public_reply_key": key,
            }
            project_chat_service._commit(db)
            return public_reply_view(db, status_comment)
    message_id = str(uuid.uuid4())
    if mentions:
        project_chat_service._validate_comment_mentions(
            db, project, user_id, item_id, mentions
        )
    if member_activity:
        author_binding = {"collaboration_member_activity_id": activity.message_id}
        if activity.metadata_json.get("activity_type") != "member_execution":
            author_binding["collaboration_member_execution_id"] = (
                activity.metadata_json["execution_id"]
            )
    else:
        author_binding = {"manager_runtime_task_id": identity.task_id}
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
            **({"mentions": mention_metadata} if mention_metadata else {}),
            **({"collaboration_turn_start": True} if identity.phase == "start" else {}),
            "dispatch_id": identity.dispatch_id,
            **(
                {"collaboration_execution_activity_id": mirror.message_id}
                if mirror
                else {}
            ),
            **author_binding,
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
    if mentions:
        notify_project_chat_mentions(
            db,
            project=project,
            task_id=item_id,
            item=item,
            comment_id=message_id,
            actor_user_id=user_id,
            actor_name=row.sender_name,
            content=body,
            mentions=mentions,
            reply_preview=reply.preview,
        )
    return save_public_reply(
        db, item=item, row=row, item_metadata=item.metadata_json or {}
    )

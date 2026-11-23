# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Expose Issue activity comments through MCP and authenticated HTTP."""

import uuid
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.schemas.base_role import BaseRole
from app.schemas.issue_activity_comment import (
    AssistantPublicationSource,
    CollaborationPublicReply,
    StandInPublicReply,
)
from app.schemas.project_chat import (
    ProjectChatMention,
    ProjectChatMessageView,
    ProjectChatSend,
    ProjectChatSubscribe,
)
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service


def _comment_view(message: ProjectChatMessageView) -> dict[str, Any]:
    return {
        "id": message.message_id,
        "body": message.content,
        "author": message.sender["name"],
        "web_url": None,
        "created_at": message.created_at,
        "updated_at": message.updated_at,
        "sequence_number": message.sequence_number,
        "reply_to_comment_id": message.reply_to_message_id,
        "root_comment_id": message.root_message_id,
        "mentions": message.metadata.get("mentions", []),
        "stand_in_reply_to": message.metadata.get("stand_in_reply_to"),
        "actor_user_id": message.actor_user_id,
        "actor_display_name": message.actor_display_name,
        "generation_source": message.generation_source,
        "publication_source": message.publication_source,
        "confirmation_state": message.confirmation_state,
        "trace_ref": message.trace_ref,
        "trace_state": message.trace_state,
    }


def list_issue_comments(
    db: Session,
    *,
    user_id: int,
    project_id: str,
    item_id: str,
    after_sequence: int = 0,
    limit: int = 200,
    message_id: str | None = None,
) -> list[dict[str, Any]]:
    if message_id is not None:
        project_chat_service._require_scope(
            db,
            user_id=user_id,
            project_id=project_id,
            task_id=item_id,
            required_role=BaseRole.Viewer,
        )
        row = (
            db.query(ProjectChatMessage)
            .filter(
                ProjectChatMessage.project_id == project_id,
                ProjectChatMessage.task_id == item_id,
                ProjectChatMessage.message_id == message_id,
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .first()
        )
        messages = (
            [project_chat_service.to_shared_view(row, db=db, viewer_user_id=user_id)]
            if row is not None
            else []
        )
    else:
        messages = project_chat_service.subscribe(
            db,
            user_id=user_id,
            request=ProjectChatSubscribe(
                project_id=project_id,
                task_id=item_id,
                after_sequence=after_sequence,
                limit=limit,
            ),
        )
    activity_ids = {
        message.message_id
        for message in messages
        if message.sender["type"] == "agent"
        and message.content
        and message.metadata.get("execution_dispatch") != "comment_only"
    }
    published, started = _published_activity_content(
        db, project_id, item_id, activity_ids
    )
    comments = []
    for message in messages:
        comment = _comment_view(message)
        if (
            message.message_id in started
            or (message.message_id, message.content) in published
        ):
            comment["body"] = ""
        comments.append(comment)
    return comments


def _published_activity_content(
    db: Session, project_id: str, item_id: str, activity_ids: set[str]
) -> tuple[set[tuple[str, str]], set[str]]:
    if not activity_ids:
        return set(), set()
    source = ProjectChatMessage.metadata_json[
        "collaboration_execution_activity_id"
    ].as_string()
    is_start = ProjectChatMessage.metadata_json["collaboration_turn_start"].as_boolean()
    rows = (
        db.query(source, ProjectChatMessage.content, is_start)
        .filter(
            ProjectChatMessage.project_id == project_id,
            ProjectChatMessage.task_id == item_id,
            ProjectChatMessage.sender_type == "agent",
            loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            ProjectChatMessage.metadata_json["collaboration_public_reply"]
            .as_boolean()
            .is_(True),
            source.in_(activity_ids),
        )
        .all()
    )
    return (
        {(activity_id, content) for activity_id, content, _ in rows},
        {activity_id for activity_id, _, start in rows if start},
    )


def add_issue_comment(
    db: Session,
    *,
    user_id: int,
    user_name: str,
    project_id: str,
    item_id: str,
    body: str,
    client_message_id: str | None = None,
    mentions: list[ProjectChatMention] | None = None,
    stand_in: StandInPublicReply | None = None,
    collaboration: CollaborationPublicReply | None = None,
    reply_to_comment_id: str | None = None,
    assistant_source: AssistantPublicationSource | None = None,
) -> dict[str, Any]:
    if collaboration is not None:
        from app.services.project_chat.collaboration_replies import (
            publish_collaboration_reply,
        )

        if stand_in is not None or assistant_source is not None:
            raise HTTPException(422, "Issue comment has multiple publication sources")
        message = publish_collaboration_reply(
            db,
            user_id=user_id,
            project_id=project_id,
            item_id=item_id,
            body=body,
            identity=collaboration,
            reply_to_comment_id=reply_to_comment_id,
            mentions=mentions,
        )
        push_project_chat_message(message.model_dump(mode="json", by_alias=True))
        return _comment_view(message)
    if stand_in is not None:
        from app.services.project_chat.stand_in_replies import publish_stand_in_reply

        message = publish_stand_in_reply(
            db,
            user_id=user_id,
            project_id=project_id,
            item_id=item_id,
            body=body,
            identity=stand_in,
        )
        push_project_chat_message(message.model_dump(mode="json", by_alias=True))
        return _comment_view(message)
    result = project_chat_service.send(
        db,
        user_id=user_id,
        user_name=user_name,
        request=ProjectChatSend(
            client_message_id=client_message_id or str(uuid.uuid4()),
            project_id=project_id,
            task_id=item_id,
            content=body,
            mentions=mentions or [],
            reply_to_message_id=reply_to_comment_id,
        ),
        assistant_source=assistant_source,
    )
    message = result.message
    push_project_chat_message(message.model_dump(mode="json", by_alias=True))
    return _comment_view(message)

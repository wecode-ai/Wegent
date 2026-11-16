# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Expose Issue activity comments through MCP and authenticated HTTP."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.schemas.issue_activity_comment import StandInPublicReply
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
        "mentions": message.metadata.get("mentions", []),
        "stand_in_reply_to": message.metadata.get("stand_in_reply_to"),
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
        from app.models.delivery import loop_datetime_is_unset
        from app.models.project_chat_message import ProjectChatMessage
        from app.schemas.base_role import BaseRole

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
        return [_comment_view(project_chat_service.to_view(row, db=db))] if row else []
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
    return [_comment_view(message) for message in messages]


def add_issue_comment(
    db: Session,
    *,
    user_id: int,
    user_name: str,
    project_id: str,
    item_id: str,
    body: str,
    mentions: list[ProjectChatMention] | None = None,
    stand_in: StandInPublicReply | None = None,
) -> dict[str, Any]:
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
            client_message_id=str(uuid.uuid4()),
            project_id=project_id,
            task_id=item_id,
            content=body,
            mentions=mentions or [],
        ),
    )
    push_project_chat_message(result.message.model_dump(mode="json", by_alias=True))
    return _comment_view(result.message)

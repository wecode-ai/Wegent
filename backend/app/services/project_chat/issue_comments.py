# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Expose Issue activity comments through MCP and authenticated HTTP."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.schemas.project_chat import (
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
    }


def list_issue_comments(
    db: Session,
    *,
    user_id: int,
    project_id: str,
    item_id: str,
    after_sequence: int = 0,
    limit: int = 200,
) -> list[dict[str, Any]]:
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
) -> dict[str, Any]:
    result = project_chat_service.send(
        db,
        user_id=user_id,
        user_name=user_name,
        request=ProjectChatSend(
            client_message_id=str(uuid.uuid4()),
            project_id=project_id,
            task_id=item_id,
            content=body,
        ),
    )
    push_project_chat_message(result.message.model_dump(mode="json", by_alias=True))
    return _comment_view(result.message)

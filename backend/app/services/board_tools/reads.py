"""Per-target batch reading with honest section and history coverage."""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.models.delivery import loop_datetime_is_unset
from app.models.project_chat_message import ProjectChatMessage
from app.services.project_chat.issue_comments import _comment_view
from app.services.project_chat.service import project_chat_service

from . import access
from .protocol import digest, failure


def details(
    db: Session, token: MCPAuthInfo, entry: dict[str, Any], include: list[str]
) -> dict[str, Any]:
    from app.mcp_server.tools import wework_space as single

    target = entry["target"]
    project = access.project(db, token, target["space"], item_id=target["item_id"])
    item = single._read_item(db, project, target["item_id"], token.user_id)
    sections = {}
    actions = {
        "permissions": lambda: item.get("permissions", {}),
        "attachment_metadata": lambda: single._item_attachments(
            db, project, target["item_id"], token.user_id
        ),
        "delivery_summaries": lambda: single._item_deliveries(
            db, project, target["item_id"], token.user_id
        ),
    }
    for name in include:
        try:
            action = {
                "permissions": "get_board_item",
                "attachment_metadata": "list_item_attachments",
                "delivery_summaries": "list_deliveries",
            }[name]
            access.project(
                db, token, target["space"], item_id=target["item_id"], action=action
            )
            sections[name] = {"state": "complete", "value": actions[name]()}
        except Exception:
            sections[name] = {"state": "unavailable"}
    return {"item": item, "sections": sections}


def comments(db: Session, token: MCPAuthInfo, entry: dict[str, Any]) -> dict[str, Any]:
    from app.mcp_server.tools import wework_space as single

    target = entry["target"]
    project = access.project(
        db,
        token,
        target["space"],
        item_id=target["item_id"],
        action="list_board_item_comments",
    )
    if project.task_provider in {"github", "gitlab"}:
        raise failure(
            "unsupported_operation",
            "This source does not provide complete Issue activity history",
        )
    single._read_item(db, project, target["item_id"], token.user_id)
    project_chat_service._require_scope(
        db,
        user_id=token.user_id,
        project_id=str(project.id),
        task_id=target["item_id"],
        required_role=single.BaseRole.Viewer,
    )
    mode = entry["mode"]
    after = 0
    history_from_start = mode == "oldest"
    binding = digest([access.identity(db, token), target])
    if mode == "after":
        try:
            cursor = json.loads(base64.urlsafe_b64decode(entry.get("cursor", "")))
            if cursor["target"] != binding:
                raise ValueError("Wrong comment target")
            if cursor["expires_at"] < time.time():
                raise ValueError("Comment cursor expired")
            after = int(cursor["after"])
            if after < 0:
                raise ValueError("Invalid sequence")
            history_from_start = cursor["history_from_start"]
            if not isinstance(history_from_start, bool):
                raise ValueError("Invalid history coverage")
        except (ValueError, KeyError, TypeError) as error:
            raise failure("cursor_expired", "Invalid comment cursor") from error
    elif entry.get("cursor"):
        raise failure("invalid_request", "Only after mode accepts a cursor")
    query = db.query(ProjectChatMessage).filter(
        ProjectChatMessage.project_id == str(project.id),
        ProjectChatMessage.task_id == target["item_id"],
        loop_datetime_is_unset(ProjectChatMessage.deleted_at),
    )
    limit = entry.get("limit", 100)
    if mode == "latest":
        rows = query.order_by(ProjectChatMessage.id.desc()).limit(limit + 1).all()
        has_earlier = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        has_later = False
    else:
        rows = (
            query.filter(ProjectChatMessage.id > after)
            .order_by(ProjectChatMessage.id)
            .limit(limit + 1)
            .all()
        )
        has_later = len(rows) > limit
        rows = rows[:limit]
        has_earlier = (
            after > 0
            and query.filter(ProjectChatMessage.id <= after).first() is not None
        )
    next_cursor = None
    if rows:
        next_cursor = base64.urlsafe_b64encode(
            json.dumps(
                {
                    "target": binding,
                    "after": rows[-1].id,
                    "history_from_start": history_from_start,
                    "expires_at": time.time() + 600,
                }
            ).encode()
        ).decode()
    return {
        "comments": [
            _comment_view(project_chat_service.to_view(row, db=db)) for row in rows
        ],
        "has_earlier": has_earlier,
        "has_later": has_later,
        "history_complete": history_from_start and not has_later,
        "next_cursor": next_cursor,
    }

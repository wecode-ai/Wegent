"""Resolve explicit project identities without widening delegated authority."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.models.delivery import CloudProject

from .protocol import digest, failure


def identity(db: Session, token: MCPAuthInfo) -> str:
    from app.mcp_server.tools import wework_space as single

    return digest([token.user_id, token.task_id, single._board_context(db, token)])


def project(
    db: Session,
    token: MCPAuthInfo,
    space: dict[str, Any],
    *,
    item_id: str | None = None,
    action: str = "get_board_item",
) -> CloudProject:
    from app.mcp_server.tools import wework_space as single

    if space["project_store"] != "backend":
        raise failure(
            "unsupported_operation", "This MCP server cannot access local devices"
        )
    resolved = single._space_id(db, token, space["space_id"])
    value = single._project(db, resolved, token.user_id)
    context = single._board_context(db, token)
    role = context.get("dispatch_role")
    if role == "executor":
        parent_reads = {"get_board_item", "list_board_item_comments", "list_deliveries"}
        own_actions = parent_reads | {"add_board_item_comment", "list_item_attachments"}
        if action not in own_actions:
            raise failure(
                "scope_violation",
                "Executor cannot call management or discovery tools",
                403,
            )
        if item_id != context.get("item_id"):
            if action not in parent_reads:
                raise failure(
                    "scope_violation",
                    "This operation requires the delegated Issue",
                    403,
                )
            child = single._read_item(db, value, context["item_id"], token.user_id)
            if not item_id or child.get("parent_id") != item_id:
                raise failure(
                    "scope_violation", "Target is outside the delegated Issue", 403
                )
    return value


def ref(project_id: str) -> dict[str, str]:
    return {"project_store": "backend", "space_id": str(project_id)}

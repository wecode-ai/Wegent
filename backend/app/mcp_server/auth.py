# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authentication primitives shared by MCP servers.

This module re-exports task token functions from the centralized auth service.
For new code, prefer importing directly from app.services.auth.

Example:
    from app.services.auth import create_task_token, verify_task_token
"""

from dataclasses import dataclass, replace
from typing import Literal, Optional

from jose import jwt

# Re-export from centralized auth service for backward compatibility
from app.services.auth.task_token import (
    TaskTokenData,
    TaskTokenInfo,
    create_task_token,
    extract_token_from_header,
    get_user_from_task_token,
    verify_task_token,
)
from app.services.chat.access.auth import verify_jwt_token


@dataclass(frozen=True)
class MCPAuthInfo:
    """Authenticated identity available to an MCP tool invocation."""

    user_id: int
    user_name: str
    auth_type: Literal["user", "task"]
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None
    project_group_execution: bool | None = False
    project_knowledge_base_ids: frozenset[int] = frozenset()


def authenticate_mcp_token(
    token: str, *, allow_user_token: bool = False
) -> Optional[MCPAuthInfo]:
    """Authenticate a task token or, when allowed, a regular user JWT."""

    try:
        claims = jwt.get_unverified_claims(token)
    except Exception:
        return None

    if claims.get("type") == "task_token":
        token_info = verify_task_token(token)
        if token_info is None:
            return None
        return MCPAuthInfo(
            user_id=token_info.user_id,
            user_name=token_info.user_name,
            auth_type="task",
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            project_group_execution=token_info.project_group_execution,
        )

    if not allow_user_token:
        return None

    user = verify_jwt_token(token)
    if user is None or not user.is_active:
        return None
    return MCPAuthInfo(
        user_id=user.id,
        user_name=user.user_name,
        auth_type="user",
    )


def scope_personal_resources(server_name: str, auth: MCPAuthInfo) -> MCPAuthInfo | None:
    from app.db.session import SessionLocal
    from app.services.auth.task_token import is_project_group_task

    if auth.task_id is None or auth.task_id <= 0:
        return (
            None
            if auth.project_group_execution and server_name == "subscription"
            else auth
        )
    with SessionLocal() as db:
        if not is_project_group_task(db, auth):
            return auth
        if server_name != "knowledge":
            return None
        from app.services.chat.task_default_knowledge_bases import (
            resolve_task_default_knowledge_base_ids,
        )
        from app.services.knowledge.task_knowledge_base_service import (
            task_knowledge_base_service,
        )

        ids = frozenset(
            resolve_task_default_knowledge_base_ids(db, auth.task_id, auth.user_id)
        )
        ids = ids.union(
            task_knowledge_base_service.get_bound_knowledge_base_ids(db, auth.task_id)
        )
        return replace(
            auth, project_group_execution=True, project_knowledge_base_ids=ids
        )


__all__ = [
    "TaskTokenData",
    "TaskTokenInfo",
    "create_task_token",
    "verify_task_token",
    "get_user_from_task_token",
    "extract_token_from_header",
    "MCPAuthInfo",
    "authenticate_mcp_token",
]

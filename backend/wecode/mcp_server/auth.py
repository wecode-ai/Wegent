# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal authentication adapter for the external knowledge MCP server."""

from typing import Any, Optional

from app.db.session import get_db_session
from app.mcp_server import server as mcp_server_module
from app.models.user import User
from wecode.service.erp_user_identity import resolve_active_user_id_by_employee_id


def _resolve_user_by_employee_id(db, employee_id: str) -> Optional[User]:
    user_id = resolve_active_user_id_by_employee_id(db, employee_id)
    if user_id is None:
        return None
    return db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()


def erp_auth_handler(token: str, request) -> Optional[Any]:
    """Resolve the external MCP user from the internal gateway user header."""
    employee_id = (request.headers.get("X-User-Name") or "").strip()
    if not employee_id:
        return None

    with get_db_session() as db:
        user = _resolve_user_by_employee_id(db, employee_id)
        if user is None:
            return None
        return mcp_server_module.ExternalKnowledgeUser(
            id=user.id,
            user_name=user.user_name,
        )

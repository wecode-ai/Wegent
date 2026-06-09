# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Replace external MCP auth handler with ERP employee_id resolution.

Imported as a side-effect during app startup (via wecode/api/__init__.py).
Must execute before register_mcp_apps() to take effect.

Temporary: X-User-Name header carries the employee_id (工号). Resolution:
  1. wecode_erp_user.employee_id → user_id → users.id
  2. (fallback) ERP OpenSearch API → email prefix → users.user_name
Unified token auth will be designed later after business delivery.
"""
import logging
from typing import Any, Optional

from app.db.session import get_db_session
from app.mcp_server import server as mcp_server_module
from app.models.user import User
from wecode.models.erp_user import WecodeErpUser
from wecode.service.erp_client import erp_client

logger = logging.getLogger(__name__)


def _resolve_user_by_employee_id(db, employee_id: str) -> Optional[User]:
    """Resolve a User from an employee_id via wecode_erp_user table."""
    erp_user = (
        db.query(WecodeErpUser).filter(WecodeErpUser.employee_id == employee_id).first()
    )
    if not erp_user:
        return None
    return (
        db.query(User)
        .filter(User.id == erp_user.user_id, User.is_active.is_(True))
        .first()
    )


def _resolve_user_by_erp_api(db, employee_id: str) -> Optional[User]:
    """Resolve a User from an employee_id via ERP OpenSearch API.

    Queries the ERP API for the employee, extracts the email prefix, and
    matches it against users.user_name.
    """
    employee = erp_client.search_employee(employee_id)
    if not employee or not employee.email:
        return None
    email_prefix = employee.email.split("@")[0]
    if not email_prefix:
        return None
    return (
        db.query(User)
        .filter(User.user_name == email_prefix, User.is_active.is_(True))
        .first()
    )


def _erp_auth_handler(token: str, request) -> Optional[Any]:
    """Resolve user by X-User-Name (employee_id) → ERP → users table."""
    employee_id = request.headers.get("X-User-Name")
    if not employee_id:
        return None

    with get_db_session() as db:
        user = _resolve_user_by_employee_id(db, employee_id)
        if user is None:
            try:
                user = _resolve_user_by_erp_api(db, employee_id)
            except Exception:
                logger.exception(
                    "ERP API fallback failed for employee_id=%s", employee_id
                )
                return None
        if user is None:
            return None
        return mcp_server_module.ExternalKnowledgeUser(
            id=user.id, user_name=user.user_name
        )


# Guard: only replace if open-source sync has delivered the extension point.
if hasattr(mcp_server_module, "set_external_knowledge_auth_handler"):
    mcp_server_module.set_external_knowledge_auth_handler(_erp_auth_handler)
    logger.info("External knowledge MCP auth replaced with ERP employee_id handler")
else:
    logger.warning(
        "set_external_knowledge_auth_handler not found in app.mcp_server.server; "
        "ERP auth replacement skipped (open-source sync may be pending)"
    )

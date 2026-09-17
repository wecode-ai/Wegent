# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public endpoint that resolves the Wegent user behind a task token."""

import logging
import time
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.rate_limit import (
    ExternalMcpRateLimitStatus,
    check_external_mcp_rate_limit,
)
from app.models.user import User
from app.services.auth import extract_token_from_header, verify_task_token

router = APIRouter(prefix="/external/mcp-identity", tags=["mcp-identity"])

logger = logging.getLogger(__name__)


class McpIdentityUserInfo(BaseModel):
    """Basic current user info resolvable from a Wegent task token."""

    id: int
    user_name: str
    email: Optional[str] = None


@router.get("/userinfo", response_model=McpIdentityUserInfo)
def read_mcp_identity_userinfo(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> McpIdentityUserInfo:
    """Return the Wegent user bound to an MCP caller's task token.

    Business MCP servers receive a task-scoped token as
    ``Authorization: Bearer ${{task_token}}`` on inbound calls when their
    Ghost ``mcpServers`` headers configure it, and can pass it back here as
    ``Authorization: Bearer <token>`` to resolve the current user. The
    response carries basic user information and never exposes git
    credentials.

    The handler is deliberately synchronous so FastAPI runs the token and
    database work in the worker threadpool instead of the event loop that also
    drives chat streaming. Rate limiting uses the fail-open Redis check because
    this endpoint is on the critical path of every business MCP tool call: an
    unreachable limiter must never turn a valid token into an auth failure.
    """
    started_at = time.perf_counter()

    rate_limit_status = ExternalMcpRateLimitStatus.ALLOWED
    if settings.RATE_LIMIT_ENABLED and settings.MCP_IDENTITY_RATE_LIMIT_ENABLED:
        rate_limit_status = check_external_mcp_rate_limit(
            request,
            namespace="mcp-identity",
            limit=settings.MCP_IDENTITY_RATE_LIMIT_REQUESTS,
            window_seconds=settings.MCP_IDENTITY_RATE_LIMIT_WINDOW_SECONDS,
        )
        if rate_limit_status == ExternalMcpRateLimitStatus.LIMITED:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many MCP identity lookups",
                headers={
                    "Retry-After": str(settings.MCP_IDENTITY_RATE_LIMIT_WINDOW_SECONDS)
                },
            )

    token = extract_token_from_header(authorization or "")
    token_info = verify_task_token(token or "")
    if token_info is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Wegent task token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    db_started_at = time.perf_counter()
    user = (
        db.query(User)
        .filter(User.id == token_info.user_id, User.is_active.is_(True))
        .first()
    )
    db_ms = (time.perf_counter() - db_started_at) * 1000
    elapsed_ms = (time.perf_counter() - started_at) * 1000

    if elapsed_ms >= settings.MCP_IDENTITY_SLOW_LOG_MS:
        logger.warning(
            "[mcp-identity] slow userinfo lookup: user_id=%s task_id=%s "
            "elapsed_ms=%.1f db_ms=%.1f rate_limit=%s",
            token_info.user_id,
            token_info.task_id,
            elapsed_ms,
            db_ms,
            rate_limit_status.value,
        )

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )

    return McpIdentityUserInfo(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
    )

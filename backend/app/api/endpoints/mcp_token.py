# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public endpoints for simplified-OAuth MCP access tokens.

Business MCP servers use these three endpoints instead of the broad task
token: exchange a Wegent credential for an MCP token, ask whether a token is
still live, and resolve the user behind it.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.rate_limit import get_limiter
from app.core.security import get_current_user_jwt_apikey_tasktoken
from app.models.user import User
from app.services.auth import (
    MCP_SCOPE_USERINFO,
    MCP_TOKEN_TYPE,
    McpTokenScopeError,
    create_mcp_token,
    extract_token_from_header,
    parse_scopes,
    verify_mcp_token,
)

router = APIRouter(prefix="/external/mcp", tags=["mcp-token"])

limiter = get_limiter()


class McpTokenRequest(BaseModel):
    """Scopes the caller wants; the token lifetime stays provider-managed."""

    scope: str = MCP_SCOPE_USERINFO


class McpTokenResponse(BaseModel):
    """RFC 6749 shaped token response."""

    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    scope: str


class McpIntrospectionResponse(BaseModel):
    """RFC 7662 shaped introspection response; ``active`` gates every field."""

    active: bool
    scope: Optional[str] = None
    sub: Optional[str] = None
    username: Optional[str] = None
    user_id: Optional[int] = None
    aud: Optional[str] = None
    token_type: Optional[str] = None
    jti: Optional[str] = None
    iat: Optional[int] = None
    exp: Optional[int] = None
    task_id: Optional[int] = None
    subtask_id: Optional[int] = None


class McpUserInfoResponse(BaseModel):
    """Basic caller information; never exposes git credentials."""

    id: int
    user_name: str
    email: Optional[str] = None
    scope: str


@router.post("/token", response_model=McpTokenResponse)
@limiter.limit(settings.RATE_LIMIT_MCP_TOKEN)
async def issue_mcp_token(
    request: Request,
    payload: McpTokenRequest,
    current_user: User = Depends(get_current_user_jwt_apikey_tasktoken),
) -> McpTokenResponse:
    """Exchange an existing Wegent credential for a user-bound MCP token.

    Authentication is deliberately flexible: a user session, a personal API
    key, or the task token Wegent already injects into MCP requests all work,
    so a business MCP server can hand back the credential it received.
    """
    try:
        scopes = parse_scopes(payload.scope)
    except McpTokenScopeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    token = create_mcp_token(
        user_id=current_user.id,
        user_name=current_user.user_name,
        scopes=scopes,
    )
    return McpTokenResponse(
        access_token=token,
        expires_in=settings.MCP_TOKEN_EXPIRE_MINUTES * 60,
        scope=" ".join(sorted(scopes)),
    )


@router.post(
    "/introspect",
    response_model=McpIntrospectionResponse,
    response_model_exclude_none=True,
)
@limiter.limit(settings.RATE_LIMIT_MCP_TOKEN)
async def introspect_mcp_token(
    request: Request,
    token: str = Form(..., description="The MCP token to validate"),
) -> McpIntrospectionResponse:
    """Report whether an MCP token is live.

    An unusable token is answered with ``{"active": false}`` and HTTP 200, the
    way RFC 7662 expects, so servers can treat every failure the same.
    """
    info = verify_mcp_token(token)
    if info is None:
        return McpIntrospectionResponse(active=False)

    return McpIntrospectionResponse(
        active=True,
        scope=info.scope,
        sub=info.user_name,
        username=info.user_name,
        user_id=info.user_id,
        aud=info.audience,
        token_type=MCP_TOKEN_TYPE,
        jti=info.token_id,
        iat=info.issued_at,
        exp=info.expire_at,
        task_id=info.task_id,
        subtask_id=info.subtask_id,
    )


@router.get("/userinfo", response_model=McpUserInfoResponse)
@limiter.limit(settings.RATE_LIMIT_MCP_TOKEN)
async def read_mcp_token_userinfo(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> McpUserInfoResponse:
    """Return the Wegent user an MCP token stands for."""
    token = extract_token_from_header(authorization or "")
    info = verify_mcp_token(token or "", required_scope=MCP_SCOPE_USERINFO)
    if info is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid MCP token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = (
        db.query(User).filter(User.id == info.user_id, User.is_active.is_(True)).first()
    )
    if not user or user.user_name != info.user_name:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="MCP token user is unavailable",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return McpUserInfoResponse(
        id=user.id,
        user_name=user.user_name,
        email=user.email,
        scope=info.scope,
    )

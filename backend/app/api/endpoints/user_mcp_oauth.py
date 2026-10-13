# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""OAuth endpoints for user-level provider MCP servers."""

import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.user import User
from app.services.mcp_provider_registry import get_mcp_provider_service
from app.services.user_mcp_oauth import (
    BROWSER_BINDING_COOKIE,
    user_mcp_oauth_service,
)

router = APIRouter(tags=["mcp-oauth"])
public_router = APIRouter(tags=["mcp-oauth"])


class MCPOAuthSessionCreateResponse(BaseModel):
    """Authorization session details handed to the client."""

    session_id: str
    poll_token: str
    authorize_url: str
    expires_at: int
    poll_interval_seconds: int


class MCPOAuthSessionPollResponse(BaseModel):
    """Polling result for an authorization session."""

    status: str
    error: Optional[str] = None
    account: Optional[str] = None
    expires_at: Optional[int] = None


def _require_oauth_service(provider_id: str, service_id: str) -> None:
    """Reject providers or services that do not support OAuth."""
    definition = get_mcp_provider_service(provider_id, service_id)
    if not definition:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unsupported MCP provider service: {provider_id}/{service_id}",
        )
    if not definition.get("oauth_supported"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "MCP provider service does not support OAuth: "
                f"{provider_id}/{service_id}"
            ),
        )


@router.post(
    "/users/me/mcps/providers/{provider_id}/services/{service_id}/oauth/sessions",
    response_model=MCPOAuthSessionCreateResponse,
)
async def create_mcp_oauth_session(
    provider_id: str,
    service_id: str,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MCPOAuthSessionCreateResponse:
    """Start an OAuth authorization for a user-level provider MCP service."""
    _require_oauth_service(provider_id, service_id)
    session = await user_mcp_oauth_service.create_session(
        db,
        user=current_user,
        provider_id=provider_id,
        service_id=service_id,
    )
    # Bind the authorization to this browser so a forwarded URL cannot be
    # completed by another logged-in user.
    response.set_cookie(
        BROWSER_BINDING_COOKIE,
        f"{session['session_id']}.{session['binding']}",
        max_age=max(1, int(session["expires_at"]) - int(time.time())),
        httponly=True,
        samesite="lax",
        secure=settings.MCP_OAUTH_REDIRECT_URI.startswith("https"),
        path="/",
    )
    session.pop("binding", None)
    return MCPOAuthSessionCreateResponse(**session)


@router.get(
    "/users/me/mcps/providers/{provider_id}/services/{service_id}"
    "/oauth/sessions/{session_id}/poll",
    response_model=MCPOAuthSessionPollResponse,
)
async def poll_mcp_oauth_session(
    provider_id: str,
    service_id: str,
    session_id: str,
    poll_token: str = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> MCPOAuthSessionPollResponse:
    """Poll the state of a user-level provider MCP authorization."""
    _require_oauth_service(provider_id, service_id)
    result = await user_mcp_oauth_service.poll_session(
        db,
        user=current_user,
        provider_id=provider_id,
        service_id=service_id,
        session_id=session_id,
        poll_token=poll_token,
    )
    return MCPOAuthSessionPollResponse(**result)


@router.delete(
    "/users/me/mcps/providers/{provider_id}/services/{service_id}/oauth/connection",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def disconnect_mcp_oauth(
    provider_id: str,
    service_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> None:
    """Disconnect a user-level provider MCP OAuth authorization."""
    _require_oauth_service(provider_id, service_id)
    await user_mcp_oauth_service.disconnect(
        db,
        user=current_user,
        provider_id=provider_id,
        service_id=service_id,
    )


@public_router.get("/mcp-oauth/callback", response_class=HTMLResponse)
async def mcp_oauth_callback(
    request: Request,
    state: str = Query(...),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    """Public OAuth redirect target for user-level provider MCP services."""
    message = await user_mcp_oauth_service.complete_callback(
        db,
        code=code,
        state_token=state,
        provider_error=error,
        browser_binding=request.cookies.get(BROWSER_BINDING_COOKIE),
    )
    html = HTMLResponse(
        "<!doctype html><html><body><p>" + message + "</p></body></html>",
        headers={"Cache-Control": "no-store"},
    )
    html.delete_cookie(BROWSER_BINDING_COOKIE, path="/")
    return html

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-facing connector app catalog and authorization endpoints."""

import html

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.responses import HTMLResponse

from app.core.payload_codec import run_payload_codec
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppResponse,
    ConnectorOAuthSessionCreateResponse,
    ConnectorOAuthSessionPollResponse,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.connector_endpoint_db import connector_endpoint_db
from app.services.connector_oauth import connector_oauth_service

router = APIRouter()


def _oauth_html_response(message: str) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html><body><p>" + html.escape(message) + "</p></body></html>",
        headers={"Cache-Control": "no-store"},
    )


@router.get("", response_model=list[ConnectorAppResponse])
async def list_connector_apps(
    user: User = Depends(get_current_user),
) -> list[ConnectorAppResponse]:
    user_id = user.id
    user_role = user.role
    del user
    return await run_sync_in_executor(
        connector_endpoint_db.list_user_apps,
        user_id,
        user_role,
    )


@router.post(
    "/{slug}/oauth/sessions",
    response_model=ConnectorOAuthSessionCreateResponse,
)
async def create_connector_oauth_session(
    slug: str,
    user: User = Depends(get_current_user),
) -> ConnectorOAuthSessionCreateResponse:
    user_id = user.id
    user_role = user.role
    del user
    await run_sync_in_executor(
        connector_endpoint_db.validate_oauth_app,
        slug,
        user_role,
    )
    return await connector_oauth_service.create_session(slug=slug, user_id=user_id)


@router.get(
    "/oauth/sessions/{session_id}/poll",
    response_model=ConnectorOAuthSessionPollResponse,
)
async def poll_connector_oauth_session(
    session_id: str,
    poll_token: str = Query(...),
    user: User = Depends(get_current_user),
) -> ConnectorOAuthSessionPollResponse:
    user_id = user.id
    del user
    return await connector_oauth_service.poll_session(
        session_id=session_id,
        poll_token=poll_token,
        user_id=user_id,
    )


@router.get("/oauth/callback", response_class=HTMLResponse)
async def connector_oauth_callback(
    state: str = Query(...),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
) -> HTMLResponse:
    message = await connector_oauth_service.complete_callback(
        code=code,
        state_token=state,
        provider_error=error,
    )
    return await run_payload_codec(
        _oauth_html_response,
        message,
        payload_hint=message,
        force_offload=True,
    )


@router.delete("/{slug}/connection", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_connector(
    slug: str,
    user: User = Depends(get_current_user),
) -> Response:
    user_id = user.id
    del user
    await connector_oauth_service.disconnect(slug=slug, user_id=user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

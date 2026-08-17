# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-facing connector app catalog and authorization endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppResponse,
    ConnectorOAuthSessionCreateResponse,
    ConnectorOAuthSessionPollResponse,
)
from app.services.connector_apps import connector_app_service
from app.services.connector_oauth import connector_oauth_service

router = APIRouter()


@router.get("", response_model=list[ConnectorAppResponse])
def list_connector_apps(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[ConnectorAppResponse]:
    return [
        connector_app_service.user_response(db, app, user)
        for app in connector_app_service.list_visible_apps(db, user)
    ]


@router.post(
    "/{slug}/oauth/sessions",
    response_model=ConnectorOAuthSessionCreateResponse,
)
async def create_connector_oauth_session(
    slug: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorOAuthSessionCreateResponse:
    app = connector_app_service.get_app_by_slug(db, slug)
    visible_ids = {
        item.id for item in connector_app_service.list_visible_apps(db, user)
    }
    if not app or app.id not in visible_ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
    if app.auth_type != "oauth2":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Connector app does not use OAuth",
        )
    return await connector_oauth_service.create_session(slug=slug, user_id=user.id)


@router.get(
    "/oauth/sessions/{session_id}/poll",
    response_model=ConnectorOAuthSessionPollResponse,
)
async def poll_connector_oauth_session(
    session_id: str,
    poll_token: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorOAuthSessionPollResponse:
    return await connector_oauth_service.poll_session(
        db,
        session_id=session_id,
        poll_token=poll_token,
        user_id=user.id,
    )


@router.get("/oauth/callback", response_class=HTMLResponse)
async def connector_oauth_callback(
    state: str = Query(...),
    code: str | None = Query(default=None),
    error: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    message = await connector_oauth_service.complete_callback(
        db,
        code=code,
        state_token=state,
        provider_error=error,
    )
    return HTMLResponse(
        "<!doctype html><html><body><p>" + message + "</p></body></html>",
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/{slug}/connection", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_connector(
    slug: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    await connector_oauth_service.disconnect(db, slug=slug, user_id=user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

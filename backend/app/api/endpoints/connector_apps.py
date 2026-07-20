# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""User-facing connector app catalog and authorization endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppResponse,
    ConnectorAuthorizeResponse,
    ConnectorBearerCredentialRequest,
)
from app.services.connector_apps import connector_app_service

router = APIRouter()


def _visible_app(db: Session, user: User, app_id: int):
    app = connector_app_service.get_app(db, app_id)
    visible_apps = connector_app_service.list_visible_apps(db, user)
    if all(item.id != app.id for item in visible_apps):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connector app not found")
    return app


@router.get("", response_model=list[ConnectorAppResponse])
def list_connector_apps(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[ConnectorAppResponse]:
    return [
        connector_app_service.user_response(db, app, user)
        for app in connector_app_service.list_visible_apps(db, user)
    ]


@router.post("/{app_id}/authorize", response_model=ConnectorAuthorizeResponse)
def authorize_connector_app(
    app_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorAuthorizeResponse:
    app = _visible_app(db, user, app_id)
    if app.auth_type == "oauth2":
        callback_base = settings.CONNECTOR_OAUTH_CALLBACK_BASE_URL.strip().rstrip("/")
        callback_url = (
            f"{callback_base}{settings.API_PREFIX}/connector-apps/oauth/callback"
            if callback_base
            else str(request.url_for("complete_connector_oauth"))
        )
        authorization_url = connector_app_service.begin_oauth(
            db, app, user, callback_url
        )
        return ConnectorAuthorizeResponse(
            authorization_url=authorization_url, status="pending"
        )
    if app.auth_type == "bearer":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Bearer credential must be submitted through the credential endpoint",
        )
    connector_app_service.connect_without_oauth(db, app, user)
    return ConnectorAuthorizeResponse(status="connected")


@router.put("/{app_id}/credential", response_model=ConnectorAppResponse)
def connect_bearer_connector_app(
    app_id: int,
    payload: ConnectorBearerCredentialRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorAppResponse:
    app = _visible_app(db, user, app_id)
    if app.auth_type != "bearer":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Connector app does not use bearer auth"
        )
    connector_app_service.connect_without_oauth(
        db,
        app,
        user,
        bearer_token=payload.token,
        account_name=payload.account_name,
    )
    return connector_app_service.user_response(db, app, user)


@router.get(
    "/oauth/callback", response_class=HTMLResponse, name="complete_connector_oauth"
)
async def complete_connector_oauth(
    state: str = Query(..., min_length=1, max_length=512),
    code: str | None = Query(default=None, min_length=1, max_length=8192),
    error: str | None = Query(default=None, max_length=1024),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    if error or not code:
        connector_app_service.fail_oauth(db, state=state)
        return HTMLResponse(
            "<html><head><meta charset='utf-8'></head><body>"
            "<h1>Connection was not completed</h1>"
            "<p>You can close this page and retry from Wegent.</p>"
            "<script>setTimeout(() => window.close(), 800)</script></body></html>",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    await connector_app_service.complete_oauth(db, state=state, code=code)
    return HTMLResponse(
        "<html><head><meta charset='utf-8'></head><body>"
        "<h1>Connected</h1><p>You can close this page and return to Wegent.</p>"
        "<script>setTimeout(() => window.close(), 800)</script></body></html>"
    )


@router.delete("/{app_id}/connection", status_code=status.HTTP_204_NO_CONTENT)
def disconnect_connector_app(
    app_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    app = _visible_app(db, user, app_id)
    connector_app_service.disconnect(db, app, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

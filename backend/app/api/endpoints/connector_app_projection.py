# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector app projections for desktop app surfaces."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.connector import ConnectorApp
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppListItem,
    ConnectorAppListResponse,
    ConnectorAppReadItem,
    ConnectorAppReadRequest,
    ConnectorAppReadResponse,
    ConnectorInstalledApp,
    ConnectorInstalledResponse,
    ConnectorToolSummary,
)
from app.services.connector_apps import connector_app_service
from app.services.connector_runtime import connector_runtime_service

router = APIRouter()


def _app_id(app: ConnectorApp) -> str:
    return app.slug


async def _tool_summaries_by_app(
    db: Session, user: User
) -> dict[str, list[ConnectorToolSummary]]:
    summaries: dict[str, list[ConnectorToolSummary]] = {}
    for tool in await connector_runtime_service.list_tools(db, user):
        summaries.setdefault(tool.connector_id, []).append(
            ConnectorToolSummary(
                name=tool.name,
                title=tool.title,
                description=tool.description,
                raw_tool_name=tool.raw_tool_name,
            )
        )
    return summaries


@router.get("/list", response_model=ConnectorAppListResponse)
async def list_apps(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorAppListResponse:
    apps = connector_app_service.list_visible_apps(db, user)
    start = int(cursor or "0")
    page = apps[start : start + limit]
    tools_by_app = await _tool_summaries_by_app(db, user)
    data = []
    for app in page:
        user_view = connector_app_service.user_response(db, app, user)
        connected = user_view.connection.status == "connected"
        callable_app = bool(tools_by_app.get(_app_id(app)))
        data.append(
            ConnectorAppListItem(
                id=_app_id(app),
                slug=app.slug,
                name=app.name,
                description=app.description,
                logo_url=app.icon_url,
                install_url=None,
                auth_type=app.auth_type,
                is_accessible=connected,
                is_enabled=app.enabled,
                callable=callable_app,
                runtime_name=app.name if callable_app else None,
                connection=user_view.connection,
            )
        )
    next_cursor = start + limit if start + limit < len(apps) else None
    return ConnectorAppListResponse(
        data=data, next_cursor=str(next_cursor) if next_cursor is not None else None
    )


@router.post("/read", response_model=ConnectorAppReadResponse)
async def read_apps(
    payload: ConnectorAppReadRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorAppReadResponse:
    requested = list(dict.fromkeys(payload.app_ids))
    visible_by_slug = {
        app.slug: app for app in connector_app_service.list_visible_apps(db, user)
    }
    tools_by_app = (
        await _tool_summaries_by_app(db, user) if payload.include_tools else {}
    )
    apps: list[ConnectorAppReadItem] = []
    missing: list[str] = []
    for app_id in requested:
        app = visible_by_slug.get(app_id)
        if not app:
            missing.append(app_id)
            continue
        apps.append(
            ConnectorAppReadItem(
                id=_app_id(app),
                slug=app.slug,
                name=app.name,
                description=app.description,
                icon_url=app.icon_url,
                auth_type=app.auth_type,
                tool_summaries=tools_by_app.get(_app_id(app), []),
            )
        )
    return ConnectorAppReadResponse(apps=apps, missing_app_ids=missing)


@router.get("/installed", response_model=ConnectorInstalledResponse)
async def installed_apps(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ConnectorInstalledResponse:
    tools_by_app = await _tool_summaries_by_app(db, user)
    apps: list[ConnectorInstalledApp] = []
    for app in connector_app_service.list_visible_apps(db, user):
        user_view = connector_app_service.user_response(db, app, user)
        if user_view.connection.status != "connected":
            continue
        app_tools = tools_by_app.get(_app_id(app), [])
        apps.append(
            ConnectorInstalledApp(
                id=_app_id(app),
                slug=app.slug,
                name=app.name,
                description=app.description,
                icon_url=app.icon_url,
                runtime_name=app.name if app_tools else None,
                enabled=app.enabled,
                callable=bool(app_tools),
                connection=user_view.connection,
                tool_summaries=app_tools,
            )
        )
    return ConnectorInstalledResponse(apps=apps)

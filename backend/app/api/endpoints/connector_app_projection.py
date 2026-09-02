# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector app projections for desktop app surfaces."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.payload_codec import run_payload_codec
from app.core.security import get_current_user
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
from app.services.chat.storage.db import run_sync_in_executor
from app.services.connector_apps import ConnectorApp
from app.services.connector_endpoint_db import (
    ConnectorUserAppPlan,
    connector_endpoint_db,
)
from app.services.connector_runtime import connector_runtime_service

router = APIRouter()


def _app_id(app: ConnectorApp) -> str:
    return app.slug


def _parse_cursor(cursor: str | None) -> int:
    try:
        return int(cursor or "0")
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail="cursor must be a numeric offset"
        ) from exc


def _tool_summaries_by_app(
    tools: list,
) -> dict[str, list[ConnectorToolSummary]]:
    summaries: dict[str, list[ConnectorToolSummary]] = {}
    for tool in tools:
        summaries.setdefault(tool.connector_id, []).append(
            ConnectorToolSummary(
                name=tool.name,
                title=tool.title,
                description=tool.description,
                raw_tool_name=tool.raw_tool_name,
            )
        )
    return summaries


def _build_list_response(
    plans: tuple[ConnectorUserAppPlan, ...],
    tools: list,
    cursor: str | None,
    limit: int,
) -> ConnectorAppListResponse:
    start = _parse_cursor(cursor)
    page = plans[start : start + limit]
    tools_by_app = _tool_summaries_by_app(tools)
    data = []
    for plan in page:
        app = plan.app
        connected = plan.connection.status == "connected"
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
                connection=plan.connection,
            )
        )
    next_cursor = start + limit if start + limit < len(plans) else None
    return ConnectorAppListResponse(
        data=data,
        next_cursor=str(next_cursor) if next_cursor is not None else None,
    )


def _build_read_response(
    plans: tuple[ConnectorUserAppPlan, ...],
    tools: list,
    payload: ConnectorAppReadRequest,
) -> ConnectorAppReadResponse:
    requested = list(dict.fromkeys(payload.app_ids))
    visible_by_slug = {plan.app.slug: plan.app for plan in plans}
    tools_by_app = _tool_summaries_by_app(tools) if payload.include_tools else {}
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


def _build_installed_response(
    plans: tuple[ConnectorUserAppPlan, ...],
    tools: list,
) -> ConnectorInstalledResponse:
    tools_by_app = _tool_summaries_by_app(tools)
    apps: list[ConnectorInstalledApp] = []
    for plan in plans:
        if plan.connection.status != "connected":
            continue
        app = plan.app
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
                connection=plan.connection,
                tool_summaries=app_tools,
            )
        )
    return ConnectorInstalledResponse(apps=apps)


@router.get("/list", response_model=ConnectorAppListResponse)
async def list_apps(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    user: User = Depends(get_current_user),
) -> ConnectorAppListResponse:
    user_id = user.id
    user_name = user.user_name
    user_role = user.role
    del user
    plans = await run_sync_in_executor(
        connector_endpoint_db.list_user_app_plans,
        user_id,
        user_role,
    )
    tools = await connector_runtime_service.list_tools(
        user_id,
        user_name,
        user_role,
    )
    return await run_payload_codec(
        _build_list_response,
        plans,
        tools,
        cursor,
        limit,
        payload_hint=tools,
        force_offload=True,
    )


@router.post("/read", response_model=ConnectorAppReadResponse)
async def read_apps(
    payload: ConnectorAppReadRequest,
    user: User = Depends(get_current_user),
) -> ConnectorAppReadResponse:
    user_id = user.id
    user_name = user.user_name
    user_role = user.role
    del user
    plans = await run_sync_in_executor(
        connector_endpoint_db.list_user_app_plans,
        user_id,
        user_role,
    )
    tools = (
        await connector_runtime_service.list_tools(
            user_id,
            user_name,
            user_role,
        )
        if payload.include_tools
        else []
    )
    return await run_payload_codec(
        _build_read_response,
        plans,
        tools,
        payload,
        payload_hint=payload,
        force_offload=True,
    )


@router.get("/installed", response_model=ConnectorInstalledResponse)
async def installed_apps(
    user: User = Depends(get_current_user),
) -> ConnectorInstalledResponse:
    user_id = user.id
    user_name = user.user_name
    user_role = user.role
    del user
    plans = await run_sync_in_executor(
        connector_endpoint_db.list_user_app_plans,
        user_id,
        user_role,
    )
    tools = await connector_runtime_service.list_tools(
        user_id,
        user_name,
        user_role,
    )
    return await run_payload_codec(
        _build_installed_response,
        plans,
        tools,
        payload_hint=tools,
        force_offload=True,
    )

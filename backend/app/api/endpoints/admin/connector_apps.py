# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator endpoints for the connector app catalog."""

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.connector import ConnectorApp
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
    ConnectorToolCallRequest,
    ConnectorToolCallResponse,
    ConnectorToolListResponse,
)
from app.services.connector_apps import connector_app_service
from app.services.connector_runtime import connector_runtime_service

router = APIRouter(prefix="/connector-apps")


@router.get("", response_model=list[ConnectorAppAdminResponse])
def list_connector_apps(
    db: Session = Depends(get_db), _: User = Depends(get_admin_user)
) -> list[ConnectorAppAdminResponse]:
    apps = db.query(ConnectorApp).order_by(ConnectorApp.name, ConnectorApp.id).all()
    return [connector_app_service.admin_response(db, app) for app in apps]


@router.post("", response_model=ConnectorAppAdminResponse, status_code=201)
def create_connector_app(
    payload: ConnectorAppWrite,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    app = connector_app_service.create_app(db, payload, admin)
    return connector_app_service.admin_response(db, app)


@router.get("/{app_id}", response_model=ConnectorAppAdminResponse)
def get_connector_app(
    app_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    return connector_app_service.admin_response(
        db, connector_app_service.get_app(db, app_id)
    )


@router.post("/{app_id}/tools/discover", response_model=ConnectorToolListResponse)
async def discover_connector_tools(
    app_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> ConnectorToolListResponse:
    app = connector_app_service.get_app(db, app_id)
    connection = connector_app_service.connection(db, admin.id, app.id)
    if app.transport == "http":
        tools = connector_runtime_service._http_tools(app)
    else:
        upstream_tools = await connector_runtime_service._upstream_tools(
            db, app, connection, admin
        )
        tools = []
        for tool in upstream_tools:
            tools.append(connector_runtime_service._tool_from_upstream(app, tool))
    return ConnectorToolListResponse(tools=tools)


@router.post("/{app_id}/tools/test", response_model=ConnectorToolCallResponse)
async def test_connector_tool(
    app_id: int,
    payload: ConnectorToolCallRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(get_admin_user),
) -> ConnectorToolCallResponse:
    app = connector_app_service.get_app(db, app_id)
    tool_name = (
        payload.name
        if payload.name.startswith(f"{app.slug}__")
        else f"{app.slug}__{payload.name}"
    )
    content, structured_content, is_error = await connector_runtime_service.call_tool(
        db, admin, tool_name, payload.arguments
    )
    return ConnectorToolCallResponse(
        content=content,
        structured_content=structured_content,
        is_error=is_error,
    )


@router.patch("/{app_id}", response_model=ConnectorAppAdminResponse)
def update_connector_app(
    app_id: int,
    payload: ConnectorAppUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    app = connector_app_service.update_app(
        db, connector_app_service.get_app(db, app_id), payload
    )
    return connector_app_service.admin_response(db, app)


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
def disable_connector_app(
    app_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_admin_user),
) -> Response:
    app = connector_app_service.get_app(db, app_id)
    connector_app_service.disable_app(db, app)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

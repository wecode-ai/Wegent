# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator endpoints for the connector app catalog."""

from typing import Any

from fastapi import APIRouter, Depends, Response, status

from app.core.payload_codec import run_payload_codec
from app.core.security import get_admin_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorAppAdminResponse,
    ConnectorAppUpdate,
    ConnectorAppWrite,
    ConnectorTool,
    ConnectorToolCallRequest,
    ConnectorToolCallResponse,
    ConnectorToolListResponse,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.connector_endpoint_db import connector_endpoint_db
from app.services.connector_runtime import connector_runtime_service

router = APIRouter(prefix="/connector-apps")


def _tool_list_response(tools: list[ConnectorTool]) -> ConnectorToolListResponse:
    return ConnectorToolListResponse(tools=tools)


def _tool_call_response(
    content: Any,
    structured_content: dict[str, Any] | None,
    is_error: bool,
) -> ConnectorToolCallResponse:
    return ConnectorToolCallResponse(
        content=content,
        structured_content=structured_content,
        is_error=is_error,
    )


@router.get("", response_model=list[ConnectorAppAdminResponse])
async def list_connector_apps(
    _: User = Depends(get_admin_user),
) -> list[ConnectorAppAdminResponse]:
    del _
    return await run_sync_in_executor(connector_endpoint_db.list_admin_apps)


@router.post("", response_model=ConnectorAppAdminResponse, status_code=201)
async def create_connector_app(
    payload: ConnectorAppWrite,
    admin: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    admin_id = admin.id
    del admin
    return await run_sync_in_executor(
        connector_endpoint_db.create_admin_app,
        payload,
        admin_id,
    )


@router.get("/{app_id}", response_model=ConnectorAppAdminResponse)
async def get_connector_app(
    app_id: int,
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    del _
    return await run_sync_in_executor(
        connector_endpoint_db.get_admin_app,
        app_id,
    )


@router.post("/{app_id}/tools/discover", response_model=ConnectorToolListResponse)
async def discover_connector_tools(
    app_id: int,
    admin: User = Depends(get_admin_user),
) -> ConnectorToolListResponse:
    admin_id = admin.id
    admin_name = admin.user_name
    del admin
    tools = await connector_runtime_service.discover_tools(
        app_id,
        admin_id,
        admin_name,
    )
    return await run_payload_codec(
        _tool_list_response,
        tools,
        payload_hint=tools,
        force_offload=True,
    )


@router.post("/{app_id}/tools/test", response_model=ConnectorToolCallResponse)
async def test_connector_tool(
    app_id: int,
    payload: ConnectorToolCallRequest,
    admin: User = Depends(get_admin_user),
) -> ConnectorToolCallResponse:
    admin_id = admin.id
    admin_name = admin.user_name
    admin_role = admin.role
    del admin
    content, structured_content, is_error = (
        await connector_runtime_service.call_admin_tool(
            app_id,
            admin_id,
            admin_name,
            admin_role,
            payload,
        )
    )
    return await run_payload_codec(
        _tool_call_response,
        content,
        structured_content,
        is_error,
        payload_hint=(content, structured_content),
        force_offload=True,
    )


@router.patch("/{app_id}", response_model=ConnectorAppAdminResponse)
async def update_connector_app(
    app_id: int,
    payload: ConnectorAppUpdate,
    _: User = Depends(get_admin_user),
) -> ConnectorAppAdminResponse:
    del _
    return await run_sync_in_executor(
        connector_endpoint_db.update_admin_app,
        app_id,
        payload,
    )


@router.delete("/{app_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disable_connector_app(
    app_id: int,
    _: User = Depends(get_admin_user),
) -> Response:
    del _
    await run_sync_in_executor(
        connector_endpoint_db.disable_admin_app,
        app_id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)

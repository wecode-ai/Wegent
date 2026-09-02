# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Minimal-scope connector runtime API consumed by executor MCP proxies."""

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from jose import JWTError, jwt

from app.core.config import settings
from app.core.payload_codec import run_payload_codec
from app.core.security import create_access_token, get_current_user
from app.models.user import User
from app.schemas.connector import (
    ConnectorTokenResponse,
    ConnectorTool,
    ConnectorToolCallRequest,
    ConnectorToolCallResponse,
    ConnectorToolListResponse,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.connector_endpoint_db import (
    ConnectorPrincipal,
    connector_endpoint_db,
)
from app.services.connector_runtime import connector_runtime_service

router = APIRouter()
CONNECTOR_TOKEN_MINUTES = 15


def _decode_connector_token(authorization: str) -> tuple[int, str]:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Connector token required")
    try:
        claims: dict[str, Any] = jwt.decode(
            authorization.removeprefix("Bearer ").strip(),
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
            audience="wegent-connector-runtime",
        )
    except JWTError as exc:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid connector token"
        ) from exc
    if (
        claims.get("token_type") != "connector"
        or claims.get("aud") != "wegent-connector-runtime"
        or claims.get("scope") != "connectors:invoke"
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid connector token scope"
        )
    user_id = claims.get("user_id")
    user_name = claims.get("sub")
    if not isinstance(user_id, int) or not isinstance(user_name, str):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid connector user")
    return user_id, user_name


async def get_connector_runtime_user(
    authorization: str = Header(default=""),
) -> ConnectorPrincipal:
    user_id, user_name = await run_payload_codec(
        _decode_connector_token,
        authorization,
        payload_hint=authorization,
        force_offload=True,
    )
    return await run_sync_in_executor(
        connector_endpoint_db.resolve_runtime_principal,
        user_id,
        user_name,
    )


def _issue_token(user_id: int, user_name: str) -> ConnectorTokenResponse:
    token = create_access_token(
        {
            "sub": user_name,
            "user_id": user_id,
            "token_type": "connector",
            "aud": "wegent-connector-runtime",
            "scope": "connectors:invoke",
        },
        expires_delta=CONNECTOR_TOKEN_MINUTES,
    )
    return ConnectorTokenResponse(
        access_token=token,
        expires_in=CONNECTOR_TOKEN_MINUTES * 60,
    )


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


@router.post("/token", response_model=ConnectorTokenResponse)
async def issue_connector_token(
    user: User = Depends(get_current_user),
) -> ConnectorTokenResponse:
    user_id = user.id
    user_name = user.user_name
    del user
    return await run_payload_codec(
        _issue_token,
        user_id,
        user_name,
        payload_hint=user_name,
        force_offload=True,
    )


@router.get("/tools", response_model=ConnectorToolListResponse)
async def list_connector_tools(
    user: ConnectorPrincipal = Depends(get_connector_runtime_user),
) -> ConnectorToolListResponse:
    tools = await connector_runtime_service.list_tools(
        user.user_id,
        user.user_name,
        user.role,
    )
    return await run_payload_codec(
        _tool_list_response,
        tools,
        payload_hint=tools,
        force_offload=True,
    )


@router.post("/call", response_model=ConnectorToolCallResponse)
async def call_connector_tool(
    payload: ConnectorToolCallRequest,
    user: ConnectorPrincipal = Depends(get_connector_runtime_user),
) -> ConnectorToolCallResponse:
    content, structured_content, is_error = await connector_runtime_service.call_tool(
        user.user_id,
        user.user_name,
        user.role,
        payload,
    )
    return await run_payload_codec(
        _tool_call_response,
        content,
        structured_content,
        is_error,
        payload_hint=(content, structured_content),
        force_offload=True,
    )

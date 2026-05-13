# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.schemas.mcp_providers import (
    MCPProviderKeysRequest,
    MCPProviderKeysResponse,
    MCPProviderListResponse,
    MCPServerListResponse,
    MCPTestRequest,
    MCPTestResponse,
    MCPToolInfo,
)
from app.schemas.user import MCPProviderKeys, UserInDB, UserPreferences, UserUpdate
from app.services.mcp_providers.security import encrypt_mcp_provider_keys
from app.services.mcp_providers.service import MCPProviderService
from app.services.user import user_service
from chat_shell.tools.mcp.client import MCPClient
from shared.logger import setup_logger

router = APIRouter(tags=["mcp-providers"])
logger = setup_logger("api.mcp_providers")


@router.get("", response_model=MCPProviderListResponse)
async def list_mcp_providers(
    current_user: UserInDB = Depends(security.get_current_user),
) -> MCPProviderListResponse:
    """List all available MCP providers"""
    # Parse preferences from JSON string
    parsed_prefs = _parse_user_preferences(current_user.preferences)
    providers = MCPProviderService.list_providers(parsed_prefs)
    return MCPProviderListResponse(providers=providers)


def _parse_user_preferences(prefs_data: Optional[str]) -> UserPreferences:
    """Parse user preferences from JSON string or return default"""
    if not prefs_data:
        return UserPreferences()
    try:
        if isinstance(prefs_data, str):
            prefs_dict = json.loads(prefs_data)
            return UserPreferences.model_validate(prefs_dict)
        return UserPreferences.model_validate(prefs_data)
    except Exception:
        return UserPreferences()


@router.post("/test", response_model=MCPTestResponse)
async def test_mcp_connection(
    request: MCPTestRequest,
    current_user: UserInDB = Depends(security.get_current_user),
) -> MCPTestResponse:
    """Test an MCP server connection and list its available tools.

    Returns success=False (HTTP 200) for all connection failures so callers
    can display the error message without treating it as a server error.
    """
    server_type = request.server_config.get("type", "")
    if server_type == "stdio":
        return MCPTestResponse(success=False, error="stdio type is not testable")

    # Normalize "http" to "streamable-http" — the frontend may store the type as "http"
    # after saving, but MCPClient only understands "streamable-http" for HTTP transports
    server_config = dict(request.server_config)
    if server_type == "http":
        server_config["type"] = "streamable-http"

    try:
        config = {request.server_name: server_config}
        raw_tools = await asyncio.wait_for(_connect_and_get_tools(config), timeout=15)
        tools = [
            MCPToolInfo(
                name=getattr(tool, "name", ""),
                description=getattr(tool, "description", ""),
            )
            for tool in raw_tools
        ]
        return MCPTestResponse(success=True, tools=tools)
    except asyncio.TimeoutError:
        return MCPTestResponse(success=False, error="Connection timed out (15s)")
    except Exception as e:
        return MCPTestResponse(success=False, error=str(e))


@router.post("/{provider_key}/servers", response_model=MCPServerListResponse)
async def get_provider_servers(
    provider_key: str,
    db: Session = Depends(get_db),
    current_user: UserInDB = Depends(security.get_current_user),
) -> MCPServerListResponse:
    """Get MCP servers from a specific provider"""
    # Parse preferences from JSON string
    parsed_prefs = _parse_user_preferences(current_user.preferences)

    logger.info(
        "Syncing MCP servers requested: provider_key=%s user_id=%s",
        provider_key,
        getattr(current_user, "id", None),
    )
    success, message, servers, error_details = await MCPProviderService.sync_servers(
        provider_key=provider_key,
        preferences=parsed_prefs,
        user_name=current_user.user_name,
    )
    logger.info(
        "Syncing MCP servers finished: provider_key=%s user_id=%s success=%s servers=%s error_details=%s",
        provider_key,
        getattr(current_user, "id", None),
        success,
        len(servers),
        error_details,
    )

    return MCPServerListResponse(
        success=success,
        message=message,
        servers=servers,
        error_details=error_details,
    )


@router.put("/keys", response_model=MCPProviderKeysResponse)
async def update_mcp_provider_keys(
    keys: MCPProviderKeysRequest,
    db: Session = Depends(get_db),
    current_user: UserInDB = Depends(security.get_current_user),
) -> MCPProviderKeysResponse:
    """Update MCP provider API keys for current user"""
    try:
        # Parse existing preferences from JSON string
        existing_prefs = _parse_user_preferences(current_user.preferences)

        # Get existing keys or create new
        existing_keys = existing_prefs.mcp_provider_keys or MCPProviderKeys()

        # Update only provided keys (merge with existing)
        updated_keys = MCPProviderKeys(
            bailian=keys.bailian if keys.bailian is not None else existing_keys.bailian,
            modelscope=(
                keys.modelscope
                if keys.modelscope is not None
                else existing_keys.modelscope
            ),
            mcp_router=(
                keys.mcp_router
                if keys.mcp_router is not None
                else existing_keys.mcp_router
            ),
        )
        existing_prefs.mcp_provider_keys = encrypt_mcp_provider_keys(updated_keys)

        # Update user via service
        user_update = UserUpdate(preferences=existing_prefs)
        user_service.update_current_user(
            db=db,
            user=current_user,
            obj_in=user_update,
        )

        return MCPProviderKeysResponse(
            success=True,
            message="MCP provider keys updated successfully",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to update MCP provider keys: {str(e)}",
        )


async def _connect_and_get_tools(config: dict) -> list:
    """Connect to MCP server and retrieve its tools list."""
    async with MCPClient(config) as client:
        return client.get_tools()

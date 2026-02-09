# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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
)
from app.schemas.user import MCPProviderKeys, UserInDB, UserPreferences, UserUpdate
from app.services.mcp_providers.service import MCPProviderService
from app.services.user import user_service
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

        # Update MCP provider keys
        existing_prefs.mcp_provider_keys = MCPProviderKeys(
            bailian=keys.bailian,
            modelscope=keys.modelscope,
            mcp_router=keys.mcp_router,
        )

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

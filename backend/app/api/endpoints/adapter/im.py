# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
IM Integration API Endpoints.

Provides endpoints for validating IM configurations and listing available platforms.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from app.core import security
from app.models.user import User
from app.schemas.im import (
    PLATFORM_CONFIG_FIELDS,
    IMPlatformInfo,
    ListPlatformsResponse,
    ValidateIMConfigRequest,
    ValidateIMConfigResponse,
)
from app.services.im.base.message import IMPlatform
from app.services.im.registry import IMProviderRegistry

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/validate", response_model=ValidateIMConfigResponse)
async def validate_im_config(
    request: ValidateIMConfigRequest,
    current_user: User = Depends(security.get_current_user),
):
    """
    Validate an IM integration configuration.

    Tests if the provided configuration (e.g., bot token) is valid
    by attempting to connect to the IM platform.
    """
    provider = IMProviderRegistry.create_provider(request.provider)
    if not provider:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown or unavailable platform: {request.provider}",
        )

    try:
        valid, error = await provider.validate_config(request.config)
        bot_info = None

        if valid:
            bot_info = await provider.get_bot_info(request.config)

        return ValidateIMConfigResponse(
            valid=valid,
            error=error,
            bot_info=bot_info,
        )
    except Exception as e:
        logger.error(f"Error validating IM config: {e}")
        return ValidateIMConfigResponse(
            valid=False,
            error=str(e),
            bot_info=None,
        )


@router.get("/platforms", response_model=ListPlatformsResponse)
async def list_available_platforms(
    current_user: User = Depends(security.get_current_user),
):
    """
    List all available IM platforms.

    Returns platforms that have registered providers and can be used
    for IM integrations.
    """
    # Get all registered platforms
    registered_platforms = IMProviderRegistry.get_available_platforms()

    platforms = []
    for platform in registered_platforms:
        config_fields = PLATFORM_CONFIG_FIELDS.get(platform, [])
        platforms.append(
            IMPlatformInfo(
                id=platform.value,
                name=platform.value.title(),
                description=f"{platform.value.title()} bot integration",
                config_fields=config_fields,
            )
        )

    return ListPlatformsResponse(platforms=platforms)


@router.get("/platforms/all", response_model=ListPlatformsResponse)
async def list_all_platforms(
    current_user: User = Depends(security.get_current_user),
):
    """
    List all supported IM platforms.

    Returns all platforms defined in the system, regardless of whether
    providers are available. Useful for UI to show future integrations.
    """
    platforms = []
    for platform in IMPlatform:
        config_fields = PLATFORM_CONFIG_FIELDS.get(platform, [])
        is_available = IMProviderRegistry.is_registered(platform)
        platforms.append(
            IMPlatformInfo(
                id=platform.value,
                name=platform.value.title(),
                description=(
                    f"{platform.value.title()} bot integration"
                    if is_available
                    else f"{platform.value.title()} (coming soon)"
                ),
                config_fields=config_fields if is_available else [],
            )
        )

    return ListPlatformsResponse(platforms=platforms)

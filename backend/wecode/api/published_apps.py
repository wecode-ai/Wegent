# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API endpoint for published apps."""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from app.core import security
from app.models.user import User
from wecode.service.published_apps import (
    PublishedAppsNotConfiguredError,
    published_apps_service,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("")
async def list_published_apps(
    current_user: User = Depends(security.get_current_user),
) -> dict[str, Any]:
    """List published apps for the current user."""
    try:
        return await published_apps_service.list_apps(current_user.user_name)
    except PublishedAppsNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Published apps service returned error: status=%s username=%s",
            exc.response.status_code,
            current_user.user_name,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Published apps service returned an error",
        ) from exc
    except httpx.HTTPError as exc:
        logger.error(
            "Failed to request published apps service for username=%s: %s",
            current_user.user_name,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to request published apps service",
        ) from exc

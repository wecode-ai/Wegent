# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin API endpoint for managing all published apps."""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core import security
from app.models.user import User
from wecode.service.published_apps import (
    PublishedAppsNotConfiguredError,
    published_apps_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/published-apps")


@router.get("")
async def list_all_published_apps(
    current_user: User = Depends(security.get_admin_user),
) -> dict[str, Any]:
    """List all published apps across all users (admin only)."""
    try:
        return await published_apps_service.list_all_apps()
    except PublishedAppsNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Admin published apps service returned error: status=%s",
            exc.response.status_code,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Published apps service returned an error",
        ) from exc
    except httpx.TimeoutException as exc:
        logger.error("Admin published apps service timed out")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Published apps service request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        logger.error("Failed to request admin published apps service: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to request published apps service",
        ) from exc


@router.delete("/{app_name}")
async def delete_published_app(
    app_name: str,
    username: str = Query(..., description="Owner username of the app"),
    current_user: User = Depends(security.get_admin_user),
) -> dict[str, Any]:
    """Delete a published app by admin."""
    try:
        return await published_apps_service.delete_app(username, app_name)
    except PublishedAppsNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except httpx.HTTPStatusError as exc:
        logger.error(
            "Admin published apps delete returned error: status=%s username=%s app=%s",
            exc.response.status_code,
            username,
            app_name,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Published apps service returned an error",
        ) from exc
    except httpx.TimeoutException as exc:
        logger.error(
            "Admin published apps delete timed out: username=%s app=%s",
            username,
            app_name,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Published apps service request timed out",
        ) from exc
    except httpx.HTTPError as exc:
        logger.error(
            "Failed to request admin published apps delete: username=%s app=%s: %s",
            username,
            app_name,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to request published apps service",
        ) from exc

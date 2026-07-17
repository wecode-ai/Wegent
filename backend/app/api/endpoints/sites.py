# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend proxy endpoints for the Sites service."""

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core import security
from app.models.user import User
from app.schemas.site import SiteListResponse
from app.services.sites import (
    SitesNotAvailableError,
    SitesUpstreamAuthenticationError,
    SitesUpstreamResponseError,
    SitesUpstreamUnavailableError,
    sites_service,
)

router = APIRouter()


def _raise_sites_error(error: Exception) -> NoReturn:
    if isinstance(error, SitesNotAvailableError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "sites_not_available",
                "message": "Sites is not available yet",
            },
        ) from error
    if isinstance(error, SitesUpstreamAuthenticationError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "sites_upstream_auth_failed",
                "message": "Sites service authentication failed",
            },
        ) from error
    if isinstance(error, SitesUpstreamUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "sites_upstream_unavailable",
                "message": "Sites service is unavailable",
            },
        ) from error
    if isinstance(error, SitesUpstreamResponseError):
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from error
    raise error


@router.get("", response_model=SiteListResponse)
async def list_sites(
    q: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
) -> SiteListResponse:
    """Search projects owned by the authenticated user."""
    try:
        return await sites_service.list_sites(
            username=current_user.user_name,
            query=q.strip() if q else None,
            cursor=cursor,
            limit=limit,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamAuthenticationError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)

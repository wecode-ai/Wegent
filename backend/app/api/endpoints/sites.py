# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend proxy endpoints for the Sites project API."""

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.core import security
from app.models.user import User
from app.schemas.site import (
    SiteListResponse,
    SiteNetworkUpdateRequest,
    SiteResponse,
    SiteUpdateRequest,
)
from app.services.sites import (
    SitesNotAvailableError,
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
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
) -> SiteListResponse:
    """List sites owned by the authenticated user."""
    try:
        return await sites_service.list_sites(
            username=current_user.user_name,
            query=q.strip() if q and q.strip() else None,
            offset=offset,
            limit=limit,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.post("/{siteid}/publish", response_model=SiteResponse)
async def publish_site(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Publish an owned site by switching its project network to outer."""
    try:
        return await sites_service.update_site_network(
            siteid,
            username=current_user.user_name,
            network="outer",
        )
    except HTTPException:
        raise
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put("/{siteid}/network", response_model=SiteResponse)
async def update_site_network(
    siteid: str,
    request: SiteNetworkUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Update an owned site network scope."""
    try:
        return await sites_service.update_site_network(
            siteid,
            username=current_user.user_name,
            network=request.network,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put("/{siteid}", response_model=SiteResponse)
async def update_site(
    siteid: str,
    request: SiteUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Update an owned site name."""
    sitename = (request.sitename or request.name or "").strip()
    if not sitename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "validation_error",
                "message": "Site name is required",
            },
        )
    try:
        return await sites_service.update_site_name(
            siteid,
            username=current_user.user_name,
            sitename=sitename,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.delete("/{siteid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_site(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Delete an owned site project."""
    try:
        await sites_service.delete_site(siteid, username=current_user.user_name)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)

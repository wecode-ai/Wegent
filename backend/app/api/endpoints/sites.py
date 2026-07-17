# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend proxy endpoints for the Sites service."""

from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.core import security
from app.models.user import User
from app.schemas.site import SiteListResponse, SiteResponse
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


def _ensure_site_owner(site: SiteResponse, current_user: User) -> None:
    if site.username != current_user.user_name:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "site_not_found", "message": "Site not found"},
        )


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
    """Publish an owned site to the public internet."""
    try:
        site = await sites_service.get_site(siteid)
        _ensure_site_owner(site, current_user)
        return await sites_service.publish_site(siteid)
    except HTTPException:
        raise
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
    """Delete an owned site registration and its public entry."""
    try:
        site = await sites_service.get_site(siteid)
        _ensure_site_owner(site, current_user)
        await sites_service.delete_site(siteid)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)

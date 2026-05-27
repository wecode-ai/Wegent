# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.resource_library import ResourceLibraryListing
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryInstallResponse,
    ResourceLibraryListingCreate,
    ResourceLibraryListingResponse,
    ResourceLibraryListResponse,
)
from app.services.resource_library import resource_library_service

router = APIRouter()


def _to_listing_response(
    listing: ResourceLibraryListing,
    *,
    is_installed: bool = False,
) -> ResourceLibraryListingResponse:
    return ResourceLibraryListingResponse.model_validate(
        {
            **listing.__dict__,
            "is_installed": is_installed,
            "current_version": None,
        }
    )


@router.get("/listings", response_model=ResourceLibraryListResponse)
def list_resource_library_listings(
    resource_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryListResponse:
    skip = (page - 1) * limit
    items, total = resource_library_service.list_listings(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        keyword=keyword,
        skip=skip,
        limit=limit,
    )
    return ResourceLibraryListResponse(
        total=total,
        items=[_to_listing_response(item) for item in items],
    )


@router.post(
    "/listings",
    response_model=ResourceLibraryListingResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_resource_library_listing(
    payload: ResourceLibraryListingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryListingResponse:
    listing = resource_library_service.create_listing(
        db,
        user_id=current_user.id,
        payload=payload,
    )
    return _to_listing_response(listing)


@router.get("/listings/{listing_id}", response_model=ResourceLibraryListingResponse)
def get_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryListingResponse:
    listing = resource_library_service.get_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
    )
    return _to_listing_response(listing)


@router.post(
    "/listings/{listing_id}/install",
    response_model=ResourceLibraryInstallResponse,
    status_code=status.HTTP_201_CREATED,
)
def install_resource_library_listing(
    listing_id: int,
    payload: ResourceLibraryInstallCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryInstallResponse:
    install = resource_library_service.install_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        payload=payload,
    )
    return ResourceLibraryInstallResponse.model_validate(install)


@router.post(
    "/listings/{listing_id}/archive",
    response_model=ResourceLibraryListingResponse,
)
def archive_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryListingResponse:
    listing = resource_library_service.archive_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        is_admin=getattr(current_user, "role", None) == "admin",
    )
    return _to_listing_response(listing)

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.resource_library import ResourceLibraryInstall, ResourceLibraryListing
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryInstallListResponse,
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


def _to_install_response(
    install: ResourceLibraryInstall,
    *,
    listing: ResourceLibraryListing | None = None,
) -> ResourceLibraryInstallResponse:
    listing_response = (
        _to_listing_response(listing, is_installed=True) if listing else None
    )
    return ResourceLibraryInstallResponse.model_validate(
        {
            **install.__dict__,
            "listing": listing_response,
            "requires_configuration": getattr(
                install,
                "requires_configuration",
                False,
            ),
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
    installed_listing_ids = resource_library_service.get_installed_listing_ids(
        db,
        user_id=current_user.id,
        listing_ids=[item.id for item in items],
    )
    return ResourceLibraryListResponse(
        total=total,
        items=[
            _to_listing_response(
                item,
                is_installed=item.id in installed_listing_ids,
            )
            for item in items
        ],
    )


@router.get("/users/me/installs", response_model=ResourceLibraryInstallListResponse)
def list_my_resource_library_installs(
    resource_type: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryInstallListResponse:
    skip = (page - 1) * limit
    installs, total = resource_library_service.list_user_installs(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        skip=skip,
        limit=limit,
    )
    listings_by_id = resource_library_service.get_listings_by_ids(
        db,
        listing_ids=[install.listing_id for install in installs],
    )
    return ResourceLibraryInstallListResponse(
        total=total,
        items=[
            _to_install_response(
                install,
                listing=listings_by_id.get(install.listing_id),
            )
            for install in installs
        ],
    )


@router.get("/users/me/published", response_model=ResourceLibraryListResponse)
def list_my_resource_library_published(
    resource_type: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> ResourceLibraryListResponse:
    skip = (page - 1) * limit
    items, total = resource_library_service.list_user_published(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        skip=skip,
        limit=limit,
    )
    installed_listing_ids = resource_library_service.get_installed_listing_ids(
        db,
        user_id=current_user.id,
        listing_ids=[item.id for item in items],
    )
    return ResourceLibraryListResponse(
        total=total,
        items=[
            _to_listing_response(
                item,
                is_installed=item.id in installed_listing_ids,
            )
            for item in items
        ],
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
    installed_listing_ids = resource_library_service.get_installed_listing_ids(
        db,
        user_id=current_user.id,
        listing_ids=[listing.id],
    )
    return _to_listing_response(
        listing,
        is_installed=listing.id in installed_listing_ids,
    )


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
    listing = resource_library_service.get_listing(
        db,
        listing_id=install.listing_id,
        user_id=current_user.id,
    )
    return _to_install_response(install, listing=listing)


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

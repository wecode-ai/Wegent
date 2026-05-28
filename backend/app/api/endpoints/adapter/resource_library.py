# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resource Library API endpoints."""

from typing import Optional

from fastapi import APIRouter, Depends, Query, Response, status
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
    ResourceLibraryVersionCreate,
    ResourceLibraryVersionResponse,
)
from app.services.resource_library import resource_library_service

router = APIRouter()


def _parse_tags(tags: Optional[str]) -> list[str] | None:
    if not tags:
        return None
    parsed = [tag.strip() for tag in tags.split(",") if tag.strip()]
    return parsed or None


def _listing_response(
    db: Session,
    listing: ResourceLibraryListing,
    *,
    user_id: int,
) -> ResourceLibraryListingResponse:
    current_version = None
    if listing.current_version_id:
        current_version = resource_library_service.get_current_version(db, listing)
    return ResourceLibraryListingResponse.model_validate(
        {
            "id": listing.id,
            "resource_type": listing.resource_type,
            "name": listing.name,
            "display_name": listing.display_name or listing.name,
            "description": listing.description,
            "icon": listing.icon,
            "tags": listing.tags or [],
            "publisher_user_id": listing.publisher_user_id,
            "status": listing.status,
            "current_version_id": listing.current_version_id,
            "current_version": current_version,
            "install_count": listing.install_count,
            "is_installed": resource_library_service.get_install_for_user(
                db, listing_id=listing.id, user_id=user_id
            )
            is not None,
            "created_at": listing.created_at,
            "updated_at": listing.updated_at,
        }
    )


def _install_response(
    db: Session,
    install: ResourceLibraryInstall,
    *,
    user_id: int,
    include_listing: bool = False,
) -> ResourceLibraryInstallResponse:
    listing_response = None
    if include_listing:
        listing = resource_library_service.get_listing(
            db,
            listing_id=install.listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        listing_response = _listing_response(db, listing, user_id=user_id)

    return ResourceLibraryInstallResponse.model_validate(
        {
            "id": install.id,
            "listing_id": install.listing_id,
            "version_id": install.version_id,
            "user_id": install.user_id,
            "resource_type": install.resource_type,
            "listing": listing_response,
            "installed_kind_id": install.installed_kind_id,
            "installed_reference": install.installed_reference or {},
            "install_status": install.install_status,
            "error_message": install.error_message,
            "requires_configuration": bool(
                (install.installed_reference or {}).get("requires_configuration", False)
            ),
            "installed_at": install.installed_at,
            "updated_at": install.updated_at,
        }
    )


@router.get("/listings", response_model=ResourceLibraryListResponse)
def list_resource_library_listings(
    resource_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    tags: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    skip = (page - 1) * limit
    items, total = resource_library_service.list_listings(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        keyword=keyword,
        tags=_parse_tags(tags),
        skip=skip,
        limit=limit,
    )
    return ResourceLibraryListResponse(
        total=total,
        page=page,
        limit=limit,
        items=[_listing_response(db, item, user_id=current_user.id) for item in items],
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
):
    listing = resource_library_service.create_listing(
        db,
        user_id=current_user.id,
        payload=payload,
    )
    return _listing_response(db, listing, user_id=current_user.id)


@router.get("/listings/{listing_id}", response_model=ResourceLibraryListingResponse)
def get_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    listing = resource_library_service.get_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
    )
    return _listing_response(db, listing, user_id=current_user.id)


@router.post(
    "/listings/{listing_id}/versions", response_model=ResourceLibraryVersionResponse
)
def create_resource_library_listing_version(
    listing_id: int,
    payload: ResourceLibraryVersionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    return resource_library_service.create_version(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        payload=payload,
    )


@router.post(
    "/listings/{listing_id}/archive", response_model=ResourceLibraryListingResponse
)
def archive_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    listing = resource_library_service.archive_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        is_admin=current_user.role == "admin",
    )
    return _listing_response(db, listing, user_id=current_user.id)


@router.post(
    "/listings/{listing_id}/install", response_model=ResourceLibraryInstallResponse
)
def install_resource_library_listing(
    listing_id: int,
    payload: ResourceLibraryInstallCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    install = resource_library_service.install_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        payload=payload,
    )
    return _install_response(db, install, user_id=current_user.id)


@router.get("/users/me/installs", response_model=ResourceLibraryInstallListResponse)
def list_my_resource_library_installs(
    resource_type: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    skip = (page - 1) * limit
    items, total = resource_library_service.list_installs(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        status_filter=status_filter,
        skip=skip,
        limit=limit,
    )
    return ResourceLibraryInstallListResponse(
        total=total,
        page=page,
        limit=limit,
        items=[
            _install_response(db, item, user_id=current_user.id, include_listing=True)
            for item in items
        ],
    )


@router.get("/users/me/published", response_model=ResourceLibraryListResponse)
def list_my_resource_library_published(
    resource_type: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    skip = (page - 1) * limit
    items, total = resource_library_service.list_published(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        status_filter=status_filter,
        skip=skip,
        limit=limit,
    )
    return ResourceLibraryListResponse(
        total=total,
        page=page,
        limit=limit,
        items=[_listing_response(db, item, user_id=current_user.id) for item in items],
    )


@router.post(
    "/installs/{install_id}/upgrade", response_model=ResourceLibraryInstallResponse
)
def upgrade_resource_library_install(
    install_id: int,
    version_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    install = resource_library_service.upgrade_install(
        db,
        install_id=install_id,
        user_id=current_user.id,
        version_id=version_id,
    )
    return _install_response(db, install, user_id=current_user.id, include_listing=True)


@router.delete("/installs/{install_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_resource_library_install(
    install_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    resource_library_service.remove_install(
        db,
        install_id=install_id,
        user_id=current_user.id,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)

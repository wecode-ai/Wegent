# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.resource_library import (
    RESOURCE_LIBRARY_STATUS_ARCHIVED,
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
from app.schemas.resource_library import ResourceLibraryListingCreate


class ResourceLibraryService:
    """Application service for resource library listings and versions."""

    def create_listing(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> ResourceLibraryListing:
        manifest = payload.manifest_options.get("manifest") or {
            "resource_type": payload.resource_type,
            "source_id": payload.source_id,
        }
        listing = ResourceLibraryListing(
            resource_type=payload.resource_type,
            name=payload.name,
            display_name=payload.display_name,
            description=payload.description,
            icon=payload.icon,
            tags=payload.tags,
            publisher_user_id=user_id,
            status=RESOURCE_LIBRARY_STATUS_PUBLISHED,
        )
        db.add(listing)
        db.flush()

        version = ResourceLibraryVersion(
            listing_id=listing.id,
            version=payload.version,
            manifest=manifest,
            source_kind_id=payload.source_id,
            is_current=True,
        )
        db.add(version)
        db.flush()

        listing.current_version_id = version.id
        db.commit()
        db.refresh(listing)
        return listing

    def list_listings(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        keyword: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryListing], int]:
        query = db.query(ResourceLibraryListing).filter(
            ResourceLibraryListing.status == RESOURCE_LIBRARY_STATUS_PUBLISHED
        )
        if resource_type:
            query = query.filter(ResourceLibraryListing.resource_type == resource_type)
        if keyword:
            pattern = f"%{keyword}%"
            query = query.filter(
                or_(
                    ResourceLibraryListing.name.ilike(pattern),
                    ResourceLibraryListing.display_name.ilike(pattern),
                    ResourceLibraryListing.description.ilike(pattern),
                )
            )

        total = query.count()
        items = (
            query.order_by(ResourceLibraryListing.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return items, total

    def get_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        include_archived_for_owner: bool = False,
    ) -> ResourceLibraryListing:
        listing = (
            db.query(ResourceLibraryListing)
            .filter(ResourceLibraryListing.id == listing_id)
            .first()
        )
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource not found",
            )
        if listing.status == RESOURCE_LIBRARY_STATUS_ARCHIVED:
            can_view = (
                include_archived_for_owner and listing.publisher_user_id == user_id
            )
            if not can_view:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource not found",
                )
        return listing

    def archive_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        is_admin: bool = False,
    ) -> ResourceLibraryListing:
        listing = self.get_listing(
            db,
            listing_id=listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        if listing.publisher_user_id != user_id and not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not allowed",
            )

        listing.status = RESOURCE_LIBRARY_STATUS_ARCHIVED
        db.commit()
        db.refresh(listing)
        return listing


resource_library_service = ResourceLibraryService()

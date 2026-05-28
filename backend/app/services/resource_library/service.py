# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Application service for Resource Library listings, versions, and installs."""

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.resource_library import (
    INSTALL_STATUS_FAILED,
    INSTALL_STATUS_INSTALLED,
    INSTALL_STATUS_REMOVED,
    RESOURCE_LIBRARY_STATUS_ARCHIVED,
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryListingCreate,
    ResourceLibraryVersionCreate,
)
from app.services.resource_library.installers import ResourceLibraryInstaller
from app.services.resource_library.manifest_builders import ResourceManifestBuilder


class ResourceLibraryService:
    """Service boundary for the Resource Library domain."""

    def __init__(
        self,
        manifest_builder: ResourceManifestBuilder | None = None,
        installer: ResourceLibraryInstaller | None = None,
    ) -> None:
        self.manifest_builder = manifest_builder or ResourceManifestBuilder()
        self.installer = installer or ResourceLibraryInstaller()

    def create_listing(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> ResourceLibraryListing:
        self._ensure_listing_name_available(
            db,
            resource_type=payload.resource_type,
            name=payload.name,
            publisher_user_id=user_id,
        )
        manifest = self.manifest_builder.build(
            db,
            user_id=user_id,
            resource_type=payload.resource_type,
            source_id=payload.source_id,
            options=payload.manifest_options,
        )

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
            source_binary_id=self._source_binary_id(manifest),
            is_current=True,
        )
        db.add(version)
        db.flush()

        listing.current_version_id = version.id
        db.commit()
        db.refresh(listing)
        return listing

    def create_version(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: ResourceLibraryVersionCreate,
    ) -> ResourceLibraryVersion:
        listing = self.get_listing(
            db,
            listing_id=listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        if listing.publisher_user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed"
            )

        manifest = self.manifest_builder.build(
            db,
            user_id=user_id,
            resource_type=listing.resource_type,
            source_id=payload.source_id,
            options=payload.manifest_options,
        )

        (
            db.query(ResourceLibraryVersion)
            .filter(ResourceLibraryVersion.listing_id == listing.id)
            .update({"is_current": False})
        )
        version = ResourceLibraryVersion(
            listing_id=listing.id,
            version=payload.version,
            manifest=manifest,
            source_kind_id=payload.source_id,
            source_binary_id=self._source_binary_id(manifest),
            is_current=True,
        )
        db.add(version)
        db.flush()
        listing.current_version_id = version.id
        listing.status = RESOURCE_LIBRARY_STATUS_PUBLISHED
        db.commit()
        db.refresh(version)
        return version

    def list_listings(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        keyword: Optional[str] = None,
        tags: Optional[list[str]] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryListing], int]:
        query = db.query(ResourceLibraryListing).filter(
            ResourceLibraryListing.status == RESOURCE_LIBRARY_STATUS_PUBLISHED
        )
        if resource_type:
            query = query.filter(ResourceLibraryListing.resource_type == resource_type)
        if keyword:
            pattern = f"%{keyword.strip()}%"
            query = query.filter(
                or_(
                    ResourceLibraryListing.name.ilike(pattern),
                    ResourceLibraryListing.display_name.ilike(pattern),
                    ResourceLibraryListing.description.ilike(pattern),
                )
            )
        if tags:
            # JSON containment is not portable across SQLite/MySQL in tests, so keep
            # filtering in Python after narrowing the SQL query.
            all_items = query.order_by(ResourceLibraryListing.updated_at.desc()).all()
            filtered = [
                item for item in all_items if set(tags).issubset(set(item.tags or []))
            ]
            return filtered[skip : skip + limit], len(filtered)

        total = query.count()
        items = (
            query.order_by(ResourceLibraryListing.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return items, total

    def list_published(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        status_filter: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryListing], int]:
        query = db.query(ResourceLibraryListing).filter(
            ResourceLibraryListing.publisher_user_id == user_id
        )
        if resource_type:
            query = query.filter(ResourceLibraryListing.resource_type == resource_type)
        if status_filter:
            query = query.filter(ResourceLibraryListing.status == status_filter)
        total = query.count()
        items = (
            query.order_by(ResourceLibraryListing.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return items, total

    def list_installs(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        status_filter: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryInstall], int]:
        query = db.query(ResourceLibraryInstall).filter(
            ResourceLibraryInstall.user_id == user_id
        )
        if resource_type:
            query = query.filter(ResourceLibraryInstall.resource_type == resource_type)
        if status_filter:
            query = query.filter(ResourceLibraryInstall.install_status == status_filter)
        total = query.count()
        items = (
            query.order_by(ResourceLibraryInstall.updated_at.desc())
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
                status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
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

    def get_current_version(
        self, db: Session, listing: ResourceLibraryListing
    ) -> ResourceLibraryVersion:
        version = None
        if listing.current_version_id:
            version = (
                db.query(ResourceLibraryVersion)
                .filter(ResourceLibraryVersion.id == listing.current_version_id)
                .first()
            )
        if not version:
            version = (
                db.query(ResourceLibraryVersion)
                .filter(
                    ResourceLibraryVersion.listing_id == listing.id,
                    ResourceLibraryVersion.is_current == True,
                )
                .first()
            )
        if not version:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Current resource version not found",
            )
        return version

    def get_install_for_user(
        self, db: Session, *, listing_id: int, user_id: int
    ) -> ResourceLibraryInstall | None:
        return (
            db.query(ResourceLibraryInstall)
            .filter(
                ResourceLibraryInstall.listing_id == listing_id,
                ResourceLibraryInstall.user_id == user_id,
                ResourceLibraryInstall.install_status == INSTALL_STATUS_INSTALLED,
            )
            .first()
        )

    def install_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: ResourceLibraryInstallCreate,
    ) -> ResourceLibraryInstall:
        listing = self.get_listing(db, listing_id=listing_id, user_id=user_id)
        version = self._resolve_version(
            db, listing=listing, version_id=payload.version_id
        )
        existing = (
            db.query(ResourceLibraryInstall)
            .filter(
                ResourceLibraryInstall.listing_id == listing.id,
                ResourceLibraryInstall.user_id == user_id,
            )
            .first()
        )
        if existing and existing.install_status == INSTALL_STATUS_INSTALLED:
            return existing

        try:
            result = self.installer.install(
                db,
                user_id=user_id,
                listing=listing,
                version=version,
                target_namespace=payload.target_namespace or "default",
                options=payload.install_options,
            )
            install = existing or ResourceLibraryInstall(
                listing_id=listing.id,
                user_id=user_id,
                resource_type=listing.resource_type,
                version_id=version.id,
                installed_reference={},
            )
            install.version_id = version.id
            install.installed_kind_id = result.installed_kind_id
            install.installed_reference = result.installed_reference
            install.install_status = INSTALL_STATUS_INSTALLED
            install.error_message = None
            if not existing:
                listing.install_count = (listing.install_count or 0) + 1
                db.add(install)
            db.commit()
            db.refresh(install)
            return install
        except Exception as exc:
            install = existing or ResourceLibraryInstall(
                listing_id=listing.id,
                version_id=version.id,
                user_id=user_id,
                resource_type=listing.resource_type,
                installed_reference={},
            )
            install.version_id = version.id
            install.install_status = INSTALL_STATUS_FAILED
            install.error_message = str(exc)
            db.add(install)
            db.commit()
            db.refresh(install)
            raise

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
                status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed"
            )
        listing.status = RESOURCE_LIBRARY_STATUS_ARCHIVED
        db.commit()
        db.refresh(listing)
        return listing

    def upgrade_install(
        self,
        db: Session,
        *,
        install_id: int,
        user_id: int,
        version_id: Optional[int] = None,
    ) -> ResourceLibraryInstall:
        install = self._get_user_install(db, install_id=install_id, user_id=user_id)
        listing = self.get_listing(db, listing_id=install.listing_id, user_id=user_id)
        version = self._resolve_version(db, listing=listing, version_id=version_id)
        install.version_id = version.id
        install.install_status = INSTALL_STATUS_INSTALLED
        install.error_message = None
        db.commit()
        db.refresh(install)
        return install

    def remove_install(
        self,
        db: Session,
        *,
        install_id: int,
        user_id: int,
    ) -> ResourceLibraryInstall:
        install = self._get_user_install(db, install_id=install_id, user_id=user_id)
        install.install_status = INSTALL_STATUS_REMOVED
        db.commit()
        db.refresh(install)
        return install

    def _get_user_install(
        self, db: Session, *, install_id: int, user_id: int
    ) -> ResourceLibraryInstall:
        install = (
            db.query(ResourceLibraryInstall)
            .filter(
                ResourceLibraryInstall.id == install_id,
                ResourceLibraryInstall.user_id == user_id,
            )
            .first()
        )
        if not install:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Install not found"
            )
        return install

    def _resolve_version(
        self,
        db: Session,
        *,
        listing: ResourceLibraryListing,
        version_id: Optional[int],
    ) -> ResourceLibraryVersion:
        if version_id:
            version = (
                db.query(ResourceLibraryVersion)
                .filter(
                    ResourceLibraryVersion.id == version_id,
                    ResourceLibraryVersion.listing_id == listing.id,
                )
                .first()
            )
            if not version:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource version not found",
                )
            return version
        return self.get_current_version(db, listing)

    def _ensure_listing_name_available(
        self,
        db: Session,
        *,
        resource_type: str,
        name: str,
        publisher_user_id: int,
    ) -> None:
        existing = (
            db.query(ResourceLibraryListing)
            .filter(
                ResourceLibraryListing.resource_type == resource_type,
                ResourceLibraryListing.name == name,
                ResourceLibraryListing.publisher_user_id == publisher_user_id,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Resource listing name already exists",
            )

    def _source_binary_id(self, manifest: dict) -> int | None:
        source = manifest.get("source")
        if isinstance(source, dict):
            binary_id = source.get("binary_id")
            return int(binary_id) if binary_id else None
        return None


resource_library_service = ResourceLibraryService()

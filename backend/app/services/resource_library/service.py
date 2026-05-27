# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.resource_library import (
    INSTALL_STATUS_FAILED,
    INSTALL_STATUS_INSTALLED,
    RESOURCE_LIBRARY_STATUS_ARCHIVED,
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    RESOURCE_TYPE_AGENT,
    RESOURCE_TYPE_MCP,
    RESOURCE_TYPE_SKILL,
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryListingCreate,
)
from app.services.resource_library.installers import (
    AgentResourceInstaller,
    McpResourceInstaller,
    SkillResourceInstaller,
)
from app.services.resource_library.manifest_builders import ResourceManifestBuilder


class ResourceLibraryService:
    """Application service for resource library listings and versions."""

    def __init__(
        self,
        manifest_builder: ResourceManifestBuilder | None = None,
        installers: dict[str, object] | None = None,
    ):
        self.manifest_builder = manifest_builder or ResourceManifestBuilder()
        self.installers = installers or {
            RESOURCE_TYPE_AGENT: AgentResourceInstaller(),
            RESOURCE_TYPE_SKILL: SkillResourceInstaller(),
            RESOURCE_TYPE_MCP: McpResourceInstaller(),
        }

    def get_installer(self, resource_type: str) -> object:
        """Return the installer registered for a resource type."""
        installer = self.installers.get(resource_type)
        if not installer:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported resource type",
            )
        return installer

    def create_listing(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> ResourceLibraryListing:
        self._ensure_listing_name_available(db, user_id=user_id, payload=payload)
        manifest = self.manifest_builder.build(
            db,
            user_id=user_id,
            resource_type=payload.resource_type,
            source_id=payload.source_id,
            options=payload.manifest_options,
        )
        source = manifest.get("source") or {}

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
        try:
            db.add(listing)
            db.flush()

            version = ResourceLibraryVersion(
                listing_id=listing.id,
                version=payload.version,
                manifest=manifest,
                source_kind_id=source.get("kind_id"),
                source_binary_id=source.get("binary_id"),
                is_current=True,
            )
            db.add(version)
            db.flush()

            listing.current_version_id = version.id
            db.commit()
            db.refresh(listing)
            return listing
        except IntegrityError as exc:
            db.rollback()
            raise self._listing_conflict() from exc

    def _ensure_listing_name_available(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> None:
        existing = (
            db.query(ResourceLibraryListing)
            .filter(
                ResourceLibraryListing.resource_type == payload.resource_type,
                ResourceLibraryListing.name == payload.name,
                ResourceLibraryListing.publisher_user_id == user_id,
            )
            .first()
        )
        if existing:
            raise self._listing_conflict()

    def _listing_conflict(self) -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resource listing already exists",
        )

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

    def install_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: ResourceLibraryInstallCreate,
    ) -> ResourceLibraryInstall:
        listing = self.get_listing(db, listing_id=listing_id, user_id=user_id)
        self._ensure_listing_not_installed(
            db,
            listing_id=listing.id,
            user_id=user_id,
        )
        version = self._resolve_install_version(
            db,
            listing=listing,
            version_id=payload.version_id,
        )
        installer = self.get_installer(listing.resource_type)

        try:
            install_result = installer.install(
                db,
                user_id=user_id,
                listing=listing,
                version=version,
                target_namespace=payload.target_namespace or "default",
                options=payload.install_options,
            )
            install = ResourceLibraryInstall(
                listing_id=listing.id,
                version_id=version.id,
                user_id=user_id,
                resource_type=listing.resource_type,
                installed_kind_id=install_result.installed_kind_id,
                installed_reference=install_result.installed_reference,
                install_status=INSTALL_STATUS_INSTALLED,
            )
            listing.install_count = (listing.install_count or 0) + 1
            db.add(install)
            db.add(listing)
            db.commit()
            db.refresh(install)
            install.requires_configuration = install_result.requires_configuration
            return install
        except HTTPException as exc:
            self._record_failed_install(
                db,
                listing=listing,
                version=version,
                user_id=user_id,
                error_message=str(exc.detail),
            )
            raise
        except IntegrityError as exc:
            db.rollback()
            raise self._install_conflict() from exc
        except Exception as exc:
            self._record_failed_install(
                db,
                listing=listing,
                version=version,
                user_id=user_id,
                error_message=str(exc),
            )
            raise

    def _ensure_listing_not_installed(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
    ) -> None:
        existing = (
            db.query(ResourceLibraryInstall)
            .filter(
                ResourceLibraryInstall.listing_id == listing_id,
                ResourceLibraryInstall.user_id == user_id,
            )
            .first()
        )
        if existing:
            raise self._install_conflict()

    def _install_conflict(self) -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resource listing already installed",
        )

    def _resolve_install_version(
        self,
        db: Session,
        listing: ResourceLibraryListing,
        version_id: int | None,
    ) -> ResourceLibraryVersion:
        query = db.query(ResourceLibraryVersion).filter(
            ResourceLibraryVersion.listing_id == listing.id
        )
        if version_id is not None:
            version = query.filter(ResourceLibraryVersion.id == version_id).first()
        elif listing.current_version_id is not None:
            version = query.filter(
                ResourceLibraryVersion.id == listing.current_version_id,
                ResourceLibraryVersion.is_current.is_(True),
            ).first()
        else:
            version = query.filter(ResourceLibraryVersion.is_current.is_(True)).first()

        if not version:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Resource version not found",
            )
        return version

    def _record_failed_install(
        self,
        db: Session,
        *,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        user_id: int,
        error_message: str,
    ) -> None:
        listing_id = listing.id
        version_id = version.id
        resource_type = listing.resource_type
        db.rollback()
        failed_install = ResourceLibraryInstall(
            listing_id=listing_id,
            version_id=version_id,
            user_id=user_id,
            resource_type=resource_type,
            installed_reference={},
            install_status=INSTALL_STATUS_FAILED,
            error_message=error_message,
        )
        db.add(failed_install)
        db.commit()


resource_library_service = ResourceLibraryService()

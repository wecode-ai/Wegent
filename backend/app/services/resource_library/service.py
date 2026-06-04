# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Application service for Resource Library discovery and share acceptance."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType
from app.schemas.resource_library import (
    ResourceLibraryListingCreate,
    ResourceLibraryVersionCreate,
)

RESOURCE_LIBRARY_KIND = "ResourceLibraryListing"
RESOURCE_LIBRARY_NAMESPACE = "resource-library"
RESOURCE_TYPE_AGENT = "agent"
RESOURCE_TYPE_SKILL = "skill"
RESOURCE_LIBRARY_STATUS_PUBLISHED = "published"
RESOURCE_LIBRARY_STATUS_ARCHIVED = "archived"
INSTALL_STATUS_INSTALLED = "installed"
INSTALL_STATUS_REMOVED = "removed"

SOURCE_KIND_BY_RESOURCE_TYPE = {
    RESOURCE_TYPE_AGENT: "Team",
    RESOURCE_TYPE_SKILL: "Skill",
}

SHARE_RESOURCE_TYPE_BY_RESOURCE_TYPE = {
    RESOURCE_TYPE_AGENT: ResourceType.TEAM.value,
    RESOURCE_TYPE_SKILL: "Skill",
}

logger = logging.getLogger(__name__)


@dataclass
class ResourceLibraryVersionRecord:
    """Compatibility view for the resource library API shape."""

    id: int
    listing_id: int
    version: str
    changelog: str | None
    package_url: str | None
    manifest: dict[str, Any] | None
    is_current: bool
    created_at: datetime
    updated_at: datetime | None


@dataclass
class ResourceLibraryInstallRecord:
    """Compatibility view backed by ResourceMember."""

    id: int
    listing_id: int
    version_id: int
    user_id: int
    resource_type: str
    listing: Kind | None
    installed_kind_id: int | None
    installed_reference: dict[str, Any]
    install_status: str
    error_message: str | None
    installed_at: datetime
    updated_at: datetime


class ResourceLibraryService:
    """Service boundary for the Resource Library share directory."""

    def create_listing(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> Kind:
        self._ensure_listing_name_available(
            db,
            resource_type=payload.resource_type,
            name=payload.name,
            publisher_user_id=user_id,
        )
        source = self._get_publishable_source(
            db,
            user_id=user_id,
            resource_type=payload.resource_type,
            source_id=payload.source_id,
        )

        listing = Kind(
            user_id=user_id,
            kind=RESOURCE_LIBRARY_KIND,
            name=payload.name,
            namespace=RESOURCE_LIBRARY_NAMESPACE,
            json=self._build_listing_json(payload, source),
            is_active=True,
        )
        db.add(listing)
        db.commit()
        db.refresh(listing)
        self._sync_discovery_listing(db, listing)
        return listing

    def create_version(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: ResourceLibraryVersionCreate,
    ) -> ResourceLibraryVersionRecord:
        listing = self.get_listing(
            db,
            listing_id=listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        if listing.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed"
            )

        spec = self._listing_spec(listing)
        source = self._get_publishable_source(
            db,
            user_id=user_id,
            resource_type=spec["resourceType"],
            source_id=payload.source_id,
        )
        spec["sourceKindId"] = source.id
        spec["sourceKind"] = source.kind
        spec["version"] = payload.version
        listing.json["spec"] = spec
        self._set_listing_status(listing, RESOURCE_LIBRARY_STATUS_PUBLISHED)
        flag_modified(listing, "json")
        db.commit()
        db.refresh(listing)
        self._sync_discovery_listing(db, listing)
        return self.get_current_version(db, listing)

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
    ) -> tuple[list[Kind], int]:
        listings = self._query_listings(db)
        filtered = [
            listing
            for listing in listings
            if self._listing_status(listing) == RESOURCE_LIBRARY_STATUS_PUBLISHED
            and self._source_for_listing(db, listing) is not None
            and self._matches_listing_filters(
                listing, resource_type=resource_type, keyword=keyword, tags=tags
            )
        ]
        return filtered[skip : skip + limit], len(filtered)

    def list_published(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        status_filter: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[Kind], int]:
        listings = self._query_listings(db).filter(Kind.user_id == user_id).all()
        filtered = [
            listing
            for listing in listings
            if (not status_filter or self._listing_status(listing) == status_filter)
            and self._matches_listing_filters(
                listing, resource_type=resource_type, keyword=None, tags=None
            )
        ]
        return filtered[skip : skip + limit], len(filtered)

    def list_installs(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        status_filter: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryInstallRecord], int]:
        listings = [
            listing
            for listing in self._query_listings(db)
            if self._listing_status(listing) == RESOURCE_LIBRARY_STATUS_PUBLISHED
            and self._matches_listing_filters(
                listing, resource_type=resource_type, keyword=None, tags=None
            )
        ]
        installs = []
        for listing in listings:
            member = self._get_accepted_member_for_listing(
                db, listing=listing, user_id=user_id
            )
            if not member:
                continue
            record = self._install_record(
                db, listing=listing, user_id=user_id, member=member
            )
            if status_filter and record.install_status != status_filter:
                continue
            installs.append(record)

        installs.sort(key=lambda item: item.updated_at, reverse=True)
        return installs[skip : skip + limit], len(installs)

    def get_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        include_archived_for_owner: bool = False,
    ) -> Kind:
        listing = (
            db.query(Kind)
            .filter(
                Kind.id == listing_id,
                Kind.kind == RESOURCE_LIBRARY_KIND,
                Kind.is_active == True,
            )
            .first()
        )
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found"
            )

        if self._listing_status(listing) == RESOURCE_LIBRARY_STATUS_ARCHIVED:
            can_view = include_archived_for_owner and listing.user_id == user_id
            if not can_view:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Resource not found",
                )

        return listing

    def get_current_version(
        self, db: Session, listing: Kind
    ) -> ResourceLibraryVersionRecord:
        spec = self._listing_spec(listing)
        return ResourceLibraryVersionRecord(
            id=listing.id,
            listing_id=listing.id,
            version=str(spec.get("version") or "1.0.0"),
            changelog=None,
            package_url=None,
            manifest=None,
            is_current=True,
            created_at=listing.created_at,
            updated_at=listing.updated_at,
        )

    def get_listing_status(self, listing: Kind) -> str:
        return self._listing_status(listing)

    def count_acceptances(self, db: Session, listing: Kind) -> int:
        return self._install_count(db, listing)

    def get_install_for_user(
        self, db: Session, *, listing_id: int, user_id: int
    ) -> ResourceLibraryInstallRecord | None:
        listing = self.get_listing(db, listing_id=listing_id, user_id=user_id)
        source = self._source_for_listing(db, listing)
        if not source:
            return None
        if source.user_id == user_id:
            return self._install_record(
                db, listing=listing, user_id=user_id, member=None
            )
        member = self._get_accepted_member_for_listing(
            db, listing=listing, user_id=user_id
        )
        if not member:
            return None
        return self._install_record(db, listing=listing, user_id=user_id, member=member)

    def install_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: object | None = None,
    ) -> ResourceLibraryInstallRecord:
        listing = self.get_listing(db, listing_id=listing_id, user_id=user_id)
        source = self._require_listing_source(db, listing)
        if source.user_id == user_id:
            return self._install_record(
                db, listing=listing, user_id=user_id, member=None
            )

        share_resource_type = self._share_resource_type(listing)
        existing = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == share_resource_type,
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
            )
            .first()
        )
        if existing:
            existing.status = MemberStatus.APPROVED.value
            existing.role = ResourceRole.Maintainer.value
            existing.invited_by_user_id = source.user_id
            existing.updated_at = datetime.now()
            db.commit()
            db.refresh(existing)
            return self._install_record(
                db, listing=listing, user_id=user_id, member=existing
            )

        member = ResourceMember(
            resource_type=share_resource_type,
            resource_id=source.id,
            entity_type="user",
            entity_id=str(user_id),
            role=ResourceRole.Maintainer.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=source.user_id,
            share_link_id=0,
            reviewed_by_user_id=0,
            copied_resource_id=0,
            requested_at=datetime.now(),
        )
        db.add(member)
        db.commit()
        db.refresh(member)
        return self._install_record(db, listing=listing, user_id=user_id, member=member)

    def archive_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        is_admin: bool = False,
    ) -> Kind:
        listing = self.get_listing(
            db,
            listing_id=listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        if listing.user_id != user_id and not is_admin:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed"
            )
        self._set_listing_status(listing, RESOURCE_LIBRARY_STATUS_ARCHIVED)
        flag_modified(listing, "json")
        db.commit()
        db.refresh(listing)
        self._remove_discovery_listing(db, listing)
        return listing

    def upgrade_install(
        self,
        db: Session,
        *,
        install_id: int,
        user_id: int,
        version_id: Optional[int] = None,
    ) -> ResourceLibraryInstallRecord:
        member = self._get_user_member(db, install_id=install_id, user_id=user_id)
        listing = self._listing_for_source_member(db, member)
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Install not found"
            )
        return self._install_record(db, listing=listing, user_id=user_id, member=member)

    def remove_install(
        self,
        db: Session,
        *,
        install_id: int,
        user_id: int,
    ) -> ResourceLibraryInstallRecord:
        member = self._get_user_member(db, install_id=install_id, user_id=user_id)
        listing = self._listing_for_source_member(db, member)
        if not listing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Install not found"
            )
        member.status = MemberStatus.REJECTED.value
        member.updated_at = datetime.now()
        db.commit()
        db.refresh(member)
        return self._install_record(db, listing=listing, user_id=user_id, member=member)

    def _sync_discovery_listing(self, db: Session, listing: Kind) -> None:
        try:
            from app.services.resource_library.discovery import (
                resource_library_discovery_service,
            )

            resource_library_discovery_service.sync_listing(db, listing)
        except Exception as exc:
            logger.warning(
                "Failed to sync Resource Library listing %s to discovery KB: %s",
                listing.id,
                exc,
                exc_info=True,
            )

    def _remove_discovery_listing(self, db: Session, listing: Kind) -> None:
        try:
            from app.services.resource_library.discovery import (
                resource_library_discovery_service,
            )

            resource_library_discovery_service.remove_listing_document(db, listing)
        except Exception as exc:
            logger.warning(
                "Failed to remove Resource Library listing %s from discovery KB: %s",
                listing.id,
                exc,
                exc_info=True,
            )

    def _query_listings(self, db: Session):
        return (
            db.query(Kind)
            .filter(
                Kind.kind == RESOURCE_LIBRARY_KIND,
                Kind.namespace == RESOURCE_LIBRARY_NAMESPACE,
                Kind.is_active == True,
            )
            .order_by(Kind.updated_at.desc(), Kind.id.desc())
        )

    def _build_listing_json(
        self, payload: ResourceLibraryListingCreate, source: Kind
    ) -> dict[str, Any]:
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": RESOURCE_LIBRARY_KIND,
            "metadata": {
                "name": payload.name,
                "namespace": RESOURCE_LIBRARY_NAMESPACE,
                "description": payload.description,
                "labels": {
                    "resource-library/status": RESOURCE_LIBRARY_STATUS_PUBLISHED,
                    "resource-library/resource-type": payload.resource_type,
                    "resource-library/source-kind": source.kind,
                    "resource-library/source-kind-id": str(source.id),
                },
            },
            "spec": {
                "resourceType": payload.resource_type,
                "sourceKind": source.kind,
                "sourceKindId": source.id,
                "sourceNamespace": source.namespace,
                "name": payload.name,
                "displayName": payload.display_name or payload.name,
                "description": payload.description,
                "icon": payload.icon,
                "tags": payload.tags,
                "version": payload.version,
            },
        }

    def _listing_spec(self, listing: Kind) -> dict[str, Any]:
        spec = listing.json.get("spec")
        return spec if isinstance(spec, dict) else {}

    def _listing_metadata(self, listing: Kind) -> dict[str, Any]:
        metadata = listing.json.get("metadata")
        return metadata if isinstance(metadata, dict) else {}

    def _listing_labels(self, listing: Kind) -> dict[str, Any]:
        labels = self._listing_metadata(listing).get("labels")
        return labels if isinstance(labels, dict) else {}

    def _listing_status(self, listing: Kind) -> str:
        return str(
            self._listing_labels(listing).get(
                "resource-library/status", RESOURCE_LIBRARY_STATUS_PUBLISHED
            )
        )

    def _set_listing_status(self, listing: Kind, next_status: str) -> None:
        metadata = self._listing_metadata(listing)
        labels = metadata.get("labels")
        if not isinstance(labels, dict):
            labels = {}
        labels["resource-library/status"] = next_status
        metadata["labels"] = labels
        listing.json["metadata"] = metadata

    def _matches_listing_filters(
        self,
        listing: Kind,
        *,
        resource_type: Optional[str],
        keyword: Optional[str],
        tags: Optional[list[str]],
    ) -> bool:
        spec = self._listing_spec(listing)
        if resource_type and resource_type != "all":
            if spec.get("resourceType") != resource_type:
                return False
        if keyword:
            needle = keyword.strip().lower()
            searchable = " ".join(
                str(value or "")
                for value in (
                    listing.name,
                    spec.get("displayName"),
                    spec.get("description"),
                )
            ).lower()
            if needle not in searchable:
                return False
        if tags:
            listing_tags = set(spec.get("tags") or [])
            if not set(tags).issubset(listing_tags):
                return False
        return True

    def _get_publishable_source(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: str,
        source_id: int,
    ) -> Kind:
        source_kind = SOURCE_KIND_BY_RESOURCE_TYPE.get(resource_type)
        if not source_kind:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Resource type is not publishable",
            )
        source = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.user_id == user_id,
                Kind.kind == source_kind,
                Kind.is_active == True,
            )
            .first()
        )
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source resource not found",
            )
        return source

    def _source_for_listing(self, db: Session, listing: Kind) -> Kind | None:
        spec = self._listing_spec(listing)
        source_id = spec.get("sourceKindId")
        source_kind = spec.get("sourceKind")
        if not source_id or not source_kind:
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.id == int(source_id),
                Kind.kind == str(source_kind),
                Kind.is_active == True,
            )
            .first()
        )

    def _require_listing_source(self, db: Session, listing: Kind) -> Kind:
        source = self._source_for_listing(db, listing)
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source resource not found",
            )
        return source

    def _share_resource_type(self, listing: Kind) -> str:
        resource_type = self._listing_spec(listing).get("resourceType")
        share_type = SHARE_RESOURCE_TYPE_BY_RESOURCE_TYPE.get(str(resource_type))
        if not share_type:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Resource type is not shareable",
            )
        return share_type

    def _get_accepted_member_for_listing(
        self, db: Session, *, listing: Kind, user_id: int
    ) -> ResourceMember | None:
        source = self._source_for_listing(db, listing)
        if not source or source.user_id == user_id:
            return None
        return (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == self._share_resource_type(listing),
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )

    def _install_record(
        self,
        db: Session,
        *,
        listing: Kind,
        user_id: int,
        member: ResourceMember | None,
    ) -> ResourceLibraryInstallRecord:
        source = self._require_listing_source(db, listing)
        timestamp = member.updated_at if member else listing.updated_at
        installed_at = member.created_at if member else listing.created_at
        status_value = INSTALL_STATUS_INSTALLED
        if member and member.status == MemberStatus.REJECTED.value:
            status_value = INSTALL_STATUS_REMOVED
        return ResourceLibraryInstallRecord(
            id=member.id if member else 0,
            listing_id=listing.id,
            version_id=listing.id,
            user_id=user_id,
            resource_type=str(self._listing_spec(listing).get("resourceType")),
            listing=listing,
            installed_kind_id=source.id,
            installed_reference={
                "kind": source.kind,
                "namespace": source.namespace,
                "name": source.name,
                "source_kind_id": source.id,
            },
            install_status=status_value,
            error_message=None,
            installed_at=installed_at,
            updated_at=timestamp,
        )

    def _get_user_member(
        self, db: Session, *, install_id: int, user_id: int
    ) -> ResourceMember:
        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.id == install_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
            )
            .first()
        )
        if not member:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Install not found"
            )
        return member

    def _listing_for_source_member(
        self, db: Session, member: ResourceMember
    ) -> Kind | None:
        for listing in self._query_listings(db):
            source = self._source_for_listing(db, listing)
            if (
                source
                and source.id == member.resource_id
                and self._share_resource_type(listing) == member.resource_type
            ):
                return listing
        return None

    def _install_count(self, db: Session, listing: Kind) -> int:
        source = self._source_for_listing(db, listing)
        if not source:
            return 0
        return (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == self._share_resource_type(listing),
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .count()
        )

    def _ensure_listing_name_available(
        self,
        db: Session,
        *,
        resource_type: str,
        name: str,
        publisher_user_id: int,
    ) -> None:
        existing = (
            db.query(Kind)
            .filter(
                Kind.kind == RESOURCE_LIBRARY_KIND,
                Kind.namespace == RESOURCE_LIBRARY_NAMESPACE,
                Kind.name == name,
                Kind.user_id == publisher_user_id,
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Resource listing name already exists",
            )


resource_library_service = ResourceLibraryService()

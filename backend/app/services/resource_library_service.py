# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability Center service backed by existing CRD resources."""

from __future__ import annotations

import base64
import json
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import Integer, and_, cast, func, or_, select, union_all
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.namespace import GroupRole
from app.schemas.resource_library import (
    ResourceLibraryAgentBindings,
    ResourceLibraryCreateListingRequest,
    ResourceLibraryDiscoveryList,
    ResourceLibraryInstall,
    ResourceLibraryInstallList,
    ResourceLibraryListing,
    ResourceLibraryListingList,
    ResourceLibraryPublicationUpdateRequest,
    ResourceLibraryVersion,
)
from app.services.group_permission import (
    check_group_permission,
)
from app.services.skill_binding_service import skill_binding_service

LEGACY_CAPABILITY_INSTALLATION_KIND = "CapabilityInstallation"
RESOURCE_KIND_BY_TYPE = {"agent": "Team", "skill": "Skill"}
RESOURCE_TYPE_BY_KIND = {value: key for key, value in RESOURCE_KIND_BY_TYPE.items()}


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resource_json_text(db: Session, path: str):
    value = func.json_extract(Kind.json, path)
    if db.get_bind().dialect.name == "mysql":
        value = func.json_unquote(value)
    return func.coalesce(value, "")


def _escape_sql_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _encode_discovery_cursor(updated_at: datetime, kind_id: int) -> str:
    payload = json.dumps(
        {"updated_at": updated_at.isoformat(), "kind_id": kind_id},
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_discovery_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(f"{cursor}{padding}").decode())
        updated_at = datetime.fromisoformat(payload["updated_at"])
        kind_id = int(payload["kind_id"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Invalid discovery cursor") from exc
    if updated_at.tzinfo is not None:
        updated_at = updated_at.astimezone(timezone.utc).replace(tzinfo=None)
    if kind_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid discovery cursor")
    return updated_at, kind_id


class ResourceLibraryService:
    """Publish, discover, and install Team and Skill capabilities."""

    def list_public(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: str | None,
        keyword: str | None,
        tags: list[str],
        limit: int,
        cursor: str | None = None,
        target_namespace: str = "default",
    ) -> ResourceLibraryDiscoveryList:
        kinds = (
            [RESOURCE_KIND_BY_TYPE[resource_type]]
            if resource_type
            else list(RESOURCE_TYPE_BY_KIND)
        )
        published_candidates = select(
            MarketplaceResource.kind_id.label("kind_id"),
            MarketplaceResource.updated_at.label("sort_time"),
            MarketplaceResource.install_count.label("install_count"),
        )
        if resource_type:
            published_candidates = published_candidates.where(
                MarketplaceResource.resource_type == resource_type
            )

        system_kinds = kinds
        if target_namespace != "default":
            system_kinds = [kind for kind in kinds if kind != "Team"]
        system_candidates = select(
            Kind.id.label("kind_id"),
            Kind.updated_at.label("sort_time"),
            cast(0, Integer).label("install_count"),
        ).where(
            Kind.user_id == 0,
            Kind.kind.in_(system_kinds),
            Kind.is_active == True,
        )
        candidates = union_all(
            published_candidates,
            system_candidates,
        ).subquery()
        query = (
            db.query(
                Kind,
                candidates.c.sort_time,
                candidates.c.install_count,
            )
            .join(candidates, candidates.c.kind_id == Kind.id)
            .filter(Kind.is_active == True)
        )

        if target_namespace == "default":
            installed_skill_ids = skill_binding_service.list_user_default_skill_ids(
                db, user_id
            )
            if installed_skill_ids:
                query = query.filter(
                    or_(
                        Kind.kind != "Skill",
                        Kind.id.notin_(installed_skill_ids),
                    )
                )

        normalized_keyword = (keyword or "").strip().lower()
        if normalized_keyword:
            keyword_pattern = f"%{_escape_sql_like(normalized_keyword)}%"
            searchable_fields = [
                Kind.name,
                _resource_json_text(db, "$.spec.capability.displayName"),
                _resource_json_text(db, "$.spec.displayName"),
                _resource_json_text(db, "$.metadata.displayName"),
                _resource_json_text(db, "$.spec.capability.description"),
                _resource_json_text(db, "$.spec.description"),
            ]
            query = query.filter(
                or_(
                    *[
                        func.lower(field).like(keyword_pattern, escape="\\")
                        for field in searchable_fields
                    ]
                )
            )

        for tag in {item.strip().lower() for item in tags if item.strip()}:
            encoded_tag = json.dumps(tag, ensure_ascii=False)[1:-1]
            tag_pattern = f'%"{_escape_sql_like(encoded_tag)}"%'
            query = query.filter(
                or_(
                    func.lower(_resource_json_text(db, "$.spec.capability.tags")).like(
                        tag_pattern, escape="\\"
                    ),
                    func.lower(_resource_json_text(db, "$.spec.tags")).like(
                        tag_pattern, escape="\\"
                    ),
                )
            )

        if cursor:
            cursor_time, cursor_kind_id = _decode_discovery_cursor(cursor)
            query = query.filter(
                or_(
                    candidates.c.sort_time < cursor_time,
                    and_(
                        candidates.c.sort_time == cursor_time,
                        Kind.id < cursor_kind_id,
                    ),
                )
            )

        rows = (
            query.order_by(candidates.c.sort_time.desc(), Kind.id.desc())
            .limit(limit + 1)
            .all()
        )
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        page_items = [row[0] for row in page_rows]
        install_counts = {row[0].id: row[2] for row in page_rows}
        next_cursor = None
        if has_more and page_rows:
            last_kind, last_sort_time, _ = page_rows[-1]
            next_cursor = _encode_discovery_cursor(
                last_sort_time,
                last_kind.id,
            )
        return ResourceLibraryDiscoveryList(
            items=[
                self.to_listing(
                    db,
                    item,
                    user_id=user_id,
                    install_count=install_counts.get(item.id),
                )
                for item in page_items
            ],
            has_more=has_more,
            next_cursor=next_cursor,
            limit=limit,
        )

    def get_public_listing(
        self, db: Session, *, listing_id: int, user_id: int
    ) -> ResourceLibraryListing:
        source = self._get_source(db, listing_id)
        if not self._is_public(source):
            raise HTTPException(status_code=404, detail="Capability not found")
        return self.to_listing(db, source, user_id=user_id)

    def get_manageable_publication(
        self,
        db: Session,
        *,
        listing_id: int,
        current_user: User,
    ) -> ResourceLibraryListing:
        """Get publication settings for a resource the current user can manage."""
        source = self._get_source(db, listing_id)
        self._require_publish_permission(db, source, current_user)
        return self.to_listing(db, source, user_id=current_user.id)

    def publish(
        self,
        db: Session,
        *,
        request: ResourceLibraryCreateListingRequest,
        current_user: User,
    ) -> ResourceLibraryListing:
        source = self._get_source(db, request.source_id)
        expected_kind = RESOURCE_KIND_BY_TYPE[request.resource_type]
        if source.kind != expected_kind:
            raise HTTPException(status_code=400, detail="Resource type does not match")
        self._require_publish_permission(db, source, current_user)
        if source.kind == "Team":
            self._validate_agent_dependencies(db, source)

        options = request.manifest_options
        capability = {
            "visibility": "public",
            "publishStatus": "published",
            "listingName": request.name.strip(),
            "displayName": request.display_name.strip(),
            "description": request.description,
            "icon": request.icon,
            "tags": self._normalize_tags(request.tags),
            "version": request.version.strip(),
            "publishedAt": _iso_now(),
            "publishedBy": current_user.id,
            "updatedBy": current_user.id,
            "updatedAt": _iso_now(),
            "allowPersonalInstall": bool(options.get("allow_personal_install", True)),
            "allowGroupInstall": bool(options.get("allow_group_install", True)),
        }
        self._set_capability(source, capability)
        self._sync_publication_index(db, source)
        db.commit()
        db.refresh(source)
        return self.to_listing(db, source, user_id=current_user.id)

    def update_publication(
        self,
        db: Session,
        *,
        listing_id: int,
        request: ResourceLibraryPublicationUpdateRequest,
        current_user: User,
    ) -> ResourceLibraryListing:
        source = self._get_source(db, listing_id)
        self._require_publish_permission(db, source, current_user)
        capability = self._capability(source)
        if not capability:
            capability = {
                **self._effective_capability(source),
                "listingName": source.name,
                "displayName": self._display_name(source),
                "description": self._description(source),
                "icon": self._icon(source),
                "tags": self._tags(source),
                "publishedAt": source.created_at.replace(
                    tzinfo=timezone.utc
                ).isoformat(),
                "publishedBy": source.user_id,
            }

        updates = request.model_dump(exclude_unset=True)
        field_map = {
            "display_name": "displayName",
            "description": "description",
            "icon": "icon",
            "version": "version",
            "allow_personal_install": "allowPersonalInstall",
            "allow_group_install": "allowGroupInstall",
        }
        for request_field, capability_field in field_map.items():
            if request_field in updates:
                capability[capability_field] = updates[request_field]
        if "tags" in updates:
            capability["tags"] = self._normalize_tags(updates["tags"] or [])
        if "target_groups" in updates:
            target_groups = self._normalize_group_names(updates["target_groups"] or [])
            previous_target_groups = self._normalize_group_names(
                capability.get("targetGroups") or []
            )
            if target_groups:
                capability["allowGroupInstall"] = True
            if source.kind == "Team":
                self._sync_agent_group_members(
                    db,
                    source=source,
                    group_names=target_groups,
                    installed_by=current_user.id,
                )
                self._delete_legacy_agent_installations(db, source.id)
                capability.pop("targetGroups", None)
            else:
                for group_name in target_groups:
                    skill_binding_service.add_group_skill(
                        db,
                        group_namespace=group_name,
                        skill_id=source.id,
                        created_by=current_user.id,
                        commit=False,
                    )
                for group_name in set(previous_target_groups) - set(target_groups):
                    skill_binding_service.remove_group_skill(
                        db,
                        group_namespace=group_name,
                        skill_id=source.id,
                        removed_by=current_user.id,
                        commit=False,
                    )
                capability["targetGroups"] = target_groups
        if "status" in updates:
            capability["publishStatus"] = updates["status"]
            capability["visibility"] = (
                "public" if updates["status"] == "published" else "private"
            )
        capability["updatedBy"] = current_user.id
        capability["updatedAt"] = _iso_now()
        self._set_capability(source, capability)
        self._sync_publication_index(db, source)
        db.commit()
        db.refresh(source)
        return self.to_listing(db, source, user_id=current_user.id)

    def list_published(
        self,
        db: Session,
        *,
        current_user: User,
        resource_type: str | None,
        page: int,
        limit: int,
    ) -> ResourceLibraryListingList:
        resources = self._query_resources(db, resource_type)
        manageable = [
            resource
            for resource in resources
            if self._capability_publisher_id(self._capability(resource))
            == current_user.id
            and self._can_publish(db, resource, current_user)
        ]
        manageable.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
        page_items = manageable[(page - 1) * limit : page * limit]
        return ResourceLibraryListingList(
            items=[
                self.to_listing(db, item, user_id=current_user.id)
                for item in page_items
            ],
            total=len(manageable),
            page=page,
            limit=limit,
        )

    def install(
        self,
        db: Session,
        *,
        listing_id: int,
        target_namespace: str,
        current_user: User,
    ) -> ResourceLibraryInstall:
        source = self._get_source(db, listing_id)
        if not self._is_public(source):
            raise HTTPException(status_code=404, detail="Capability not found")
        source = (
            db.query(Kind)
            .filter(Kind.id == source.id, Kind.is_active == True)
            .with_for_update()
            .one()
        )
        if source.kind == "Team" and source.user_id == 0:
            raise HTTPException(
                status_code=409,
                detail="System agents are globally available and cannot be installed",
            )
        capability = self._effective_capability(source)
        self._require_install_permission(
            db,
            capability=capability,
            target_namespace=target_namespace,
            user_id=current_user.id,
        )
        if source.kind == "Skill":
            return self._install_skill(
                db,
                source=source,
                target_namespace=target_namespace,
                current_user=current_user,
            )
        return self._install_agent(
            db,
            source=source,
            target_namespace=target_namespace,
            current_user=current_user,
        )

    def bind_agent(
        self,
        db: Session,
        *,
        agent_id: int,
        target_namespace: str,
        current_user: User,
    ) -> ResourceLibraryInstall:
        """Publish an Agent to a personal or group scope by reference."""
        source = self._get_source(db, agent_id, expected_kind="Team")
        self._require_publish_permission(db, source, current_user)
        if source.user_id == 0:
            raise HTTPException(
                status_code=409,
                detail="System agents are globally available and do not need bindings",
            )
        self._require_target_namespace_permission(
            db,
            target_namespace=target_namespace,
            user_id=current_user.id,
        )
        return self._bind_agent_reference(
            db,
            source=source,
            target_namespace=target_namespace,
            installed_by=current_user.id,
        )

    def get_agent_bindings(
        self,
        db: Session,
        *,
        agent_id: int,
        current_user: User,
    ) -> ResourceLibraryAgentBindings:
        """Return every effective scope that references one canonical Agent."""
        source = self._get_source(db, agent_id, expected_kind="Team")
        self._require_publish_permission(db, source, current_user)
        return self._agent_bindings_response(db, source, current_user.id)

    def sync_agent_bindings(
        self,
        db: Session,
        *,
        agent_id: int,
        group_names: list[str],
        current_user: User,
    ) -> ResourceLibraryAgentBindings:
        """Replace extra group references to one canonical Agent."""
        source = self._get_source(db, agent_id, expected_kind="Team")
        self._require_publish_permission(db, source, current_user)
        if source.user_id == 0:
            raise HTTPException(
                status_code=409,
                detail="System agents are globally available and do not need bindings",
            )
        self._sync_agent_group_members(
            db,
            source=source,
            group_names=self._normalize_group_names(group_names),
            installed_by=current_user.id,
        )
        self._delete_legacy_agent_installations(db, source.id)
        db.commit()
        return self._agent_bindings_response(db, source, current_user.id)

    def list_installs(
        self,
        db: Session,
        *,
        current_user: User,
        resource_type: str | None,
        page: int,
        limit: int,
    ) -> ResourceLibraryInstallList:
        installs = self._personal_install_responses(db, current_user.id, resource_type)
        installs.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
        page_items = installs[(page - 1) * limit : page * limit]
        return ResourceLibraryInstallList(
            items=page_items,
            total=len(installs),
            page=page,
            limit=limit,
        )

    def list_group_installs(
        self,
        db: Session,
        *,
        group_namespace: str,
        current_user: User,
        resource_type: str | None,
        page: int,
        limit: int,
    ) -> ResourceLibraryInstallList:
        if not check_group_permission(
            db, current_user.id, group_namespace, GroupRole.Reporter
        ):
            raise HTTPException(status_code=403, detail="Group access denied")

        installs: list[ResourceLibraryInstall] = []
        if resource_type in {None, "agent"}:
            installs.extend(
                self._group_agent_install_responses(
                    db,
                    group_namespace=group_namespace,
                    user_id=current_user.id,
                )
            )
        if resource_type in {None, "skill"}:
            installs.extend(
                self._skill_binding_responses(
                    db,
                    skill_binding_service.list_group_bindings(
                        db, group_namespace, current_user.id
                    ),
                    current_user.id,
                )
            )
        installs.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
        page_items = installs[(page - 1) * limit : page * limit]
        return ResourceLibraryInstallList(
            items=page_items,
            total=len(installs),
            page=page,
            limit=limit,
        )

    def to_listing(
        self,
        db: Session,
        source: Kind,
        *,
        user_id: int,
        install_count: int | None = None,
    ) -> ResourceLibraryListing:
        capability = self._effective_capability(source)
        resource_type = RESOURCE_TYPE_BY_KIND[source.kind]
        version = str(capability.get("version") or self._source_version(source))
        status = capability.get("publishStatus", "published")
        publisher_user_id = self._capability_publisher_id(capability)
        resolved_publisher_user_id = (
            source.user_id if publisher_user_id is None else publisher_user_id
        )
        publisher = (
            db.get(User, resolved_publisher_user_id)
            if resolved_publisher_user_id > 0
            else None
        )
        return ResourceLibraryListing(
            id=source.id,
            resource_type=resource_type,
            name=str(capability.get("listingName") or source.name),
            display_name=str(
                capability.get("displayName") or self._display_name(source)
            ),
            description=capability.get("description") or self._description(source),
            icon=capability.get("icon") or self._icon(source),
            tags=list(capability.get("tags") or self._tags(source)),
            publisher_user_id=resolved_publisher_user_id,
            publisher_user_name=publisher.user_name if publisher is not None else None,
            publisher_namespace=source.namespace,
            status="published" if status == "published" else "archived",
            current_version_id=source.id,
            current_version=ResourceLibraryVersion(
                id=source.id,
                listing_id=source.id,
                version=version,
                created_at=source.created_at,
                updated_at=source.updated_at,
            ),
            install_count=(
                install_count
                if install_count is not None
                else self._listing_install_count(db, source)
            ),
            is_installed=self._is_personally_installed(db, source, user_id),
            allow_personal_install=bool(capability.get("allowPersonalInstall", True)),
            allow_group_install=bool(capability.get("allowGroupInstall", True)),
            target_groups=(
                self._agent_group_names(db, source)
                if source.kind == "Team"
                else self._normalize_group_names(capability.get("targetGroups") or [])
            ),
            created_at=source.created_at,
            updated_at=source.updated_at,
        )

    def _install_skill(
        self,
        db: Session,
        *,
        source: Kind,
        target_namespace: str,
        current_user: User,
    ) -> ResourceLibraryInstall:
        if target_namespace == "default":
            was_installed = (
                source.id
                in skill_binding_service.list_user_default_skill_ids(
                    db, current_user.id
                )
            )
            binding = skill_binding_service.add_user_default_skill(
                db,
                user_id=current_user.id,
                skill_id=source.id,
                created_by=current_user.id,
                commit=False,
            )
        else:
            was_installed = skill_binding_service.is_skill_available_to_group(
                db,
                group_namespace=target_namespace,
                skill_id=source.id,
                user_id=current_user.id,
            )
            binding = skill_binding_service.add_group_skill(
                db,
                group_namespace=target_namespace,
                skill_id=source.id,
                created_by=current_user.id,
                commit=False,
            )
        if not was_installed:
            self._increment_publication_install_count(db, source.id)
        db.commit()
        db.refresh(binding)
        return self._skill_binding_response(db, binding, source, current_user.id)

    def _install_agent(
        self,
        db: Session,
        *,
        source: Kind,
        target_namespace: str,
        current_user: User,
    ) -> ResourceLibraryInstall:
        self._validate_agent_dependencies(db, source)
        return self._bind_agent_reference(
            db,
            source=source,
            target_namespace=target_namespace,
            installed_by=current_user.id,
        )

    def _bind_agent_reference(
        self,
        db: Session,
        *,
        source: Kind,
        target_namespace: str,
        installed_by: int,
        commit: bool = True,
    ) -> ResourceLibraryInstall:
        member, was_installed = self._ensure_agent_access_binding(
            db,
            source=source,
            target_namespace=target_namespace,
            installed_by=installed_by,
        )
        if not was_installed:
            self._increment_publication_install_count(db, source.id)
        self._delete_legacy_agent_installations(db, source.id)
        if commit:
            db.commit()
            db.refresh(member)
        return self._agent_member_response(
            db,
            member=member,
            source=source,
            target_namespace=target_namespace,
            user_id=installed_by,
        )

    def _ensure_agent_access_binding(
        self,
        db: Session,
        *,
        source: Kind,
        target_namespace: str,
        installed_by: int,
    ) -> tuple[ResourceMember, bool]:
        entity_type = "user"
        entity_id = str(installed_by)
        entity_display_name = ""
        if target_namespace != "default":
            namespace = (
                db.query(Namespace)
                .filter(
                    Namespace.name == target_namespace,
                    Namespace.is_active.is_(True),
                )
                .first()
            )
            if not namespace:
                raise HTTPException(status_code=404, detail="Target group not found")
            entity_type = "namespace"
            entity_id = str(namespace.id)
            entity_display_name = namespace.display_name or namespace.name

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == entity_type,
                ResourceMember.entity_id == entity_id,
            )
            .first()
        )
        if member:
            was_installed = member.status == MemberStatus.APPROVED.value
            member.status = MemberStatus.APPROVED.value
            if not has_permission(member.role, BaseRole.Reporter):
                member.role = BaseRole.Reporter.value
            member.reviewed_by_user_id = installed_by
            member.reviewed_at = datetime.utcnow()
            member.updated_at = datetime.utcnow()
            return member, was_installed

        member = ResourceMember.create(
            resource_type=ResourceType.TEAM.value,
            resource_id=source.id,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_display_name=entity_display_name,
            role=BaseRole.Reporter.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=installed_by,
            reviewed_by_user_id=installed_by,
            reviewed_at=datetime.utcnow(),
        )
        db.add(member)
        db.flush()
        return member, False

    def _agent_member_response(
        self,
        db: Session,
        *,
        member: ResourceMember,
        source: Kind,
        target_namespace: str,
        user_id: int,
    ) -> ResourceLibraryInstall:
        return ResourceLibraryInstall(
            id=member.id,
            listing_id=source.id,
            version_id=source.id,
            user_id=member.user_id,
            resource_type="agent",
            listing=self.to_listing(db, source, user_id=user_id),
            installed_kind_id=source.id,
            installed_reference={
                "namespace": target_namespace,
                "name": source.name,
                "kind": source.kind,
                "team_id": source.id,
                "resource_type": "agent",
            },
            installed_at=member.created_at,
            updated_at=member.updated_at,
        )

    def _sync_agent_group_members(
        self,
        db: Session,
        *,
        source: Kind,
        group_names: list[str],
        installed_by: int,
    ) -> None:
        intrinsic_group = source.namespace if source.namespace != "default" else None
        desired_names = {
            name for name in group_names if name and name != intrinsic_group
        }
        namespaces = (
            db.query(Namespace)
            .filter(
                Namespace.name.in_(desired_names),
                Namespace.is_active.is_(True),
            )
            .all()
            if desired_names
            else []
        )
        namespace_by_name = {namespace.name: namespace for namespace in namespaces}
        missing_names = desired_names - namespace_by_name.keys()
        if missing_names:
            raise HTTPException(status_code=404, detail="Target group not found")
        for group_name in desired_names:
            self._require_target_namespace_permission(
                db,
                target_namespace=group_name,
                user_id=installed_by,
            )

        current_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "namespace",
            )
            .all()
        )
        desired_ids = {
            str(namespace_by_name[group_name].id) for group_name in desired_names
        }
        for member in current_members:
            if member.entity_id not in desired_ids:
                db.delete(member)
        for group_name in desired_names:
            self._ensure_agent_access_binding(
                db,
                source=source,
                target_namespace=group_name,
                installed_by=installed_by,
            )
        db.flush()

    def _agent_bindings_response(
        self, db: Session, source: Kind, user_id: int
    ) -> ResourceLibraryAgentBindings:
        personal = source.namespace == "default" and source.user_id == user_id
        if not personal:
            personal = (
                db.query(ResourceMember.id)
                .filter(
                    ResourceMember.resource_type == ResourceType.TEAM.value,
                    ResourceMember.resource_id == source.id,
                    ResourceMember.entity_type == "user",
                    ResourceMember.entity_id == str(user_id),
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .first()
                is not None
            )
        return ResourceLibraryAgentBindings(
            agent_id=source.id,
            personal=personal,
            group_names=self._agent_group_names(db, source),
        )

    def _agent_group_names(self, db: Session, source: Kind) -> list[str]:
        group_names = [source.namespace] if source.namespace != "default" else []
        member_group_ids = [
            member.entity_id
            for member in db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "namespace",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        ]
        if member_group_ids:
            namespace_ids: list[int] = []
            for value in member_group_ids:
                try:
                    namespace_ids.append(int(value))
                except (TypeError, ValueError):
                    continue
            namespaces = (
                db.query(Namespace)
                .filter(
                    Namespace.id.in_(namespace_ids),
                    Namespace.is_active.is_(True),
                )
                .order_by(Namespace.id)
                .all()
            )
            group_names.extend(namespace.name for namespace in namespaces)
        return self._normalize_group_names(group_names)

    def _delete_legacy_agent_installations(self, db: Session, source_id: int) -> None:
        legacy_rows = (
            db.query(Kind)
            .filter(
                Kind.kind == LEGACY_CAPABILITY_INSTALLATION_KIND,
                Kind.is_active == True,
            )
            .all()
        )
        for row in legacy_rows:
            if self._nested_int(self._spec(row), "sourceRef", "kindId") == source_id:
                db.delete(row)

    def _skill_binding_response(
        self, db: Session, binding: Kind, source: Kind, user_id: int
    ) -> ResourceLibraryInstall:
        return ResourceLibraryInstall(
            id=binding.id,
            listing_id=source.id,
            version_id=source.id,
            user_id=binding.user_id,
            resource_type="skill",
            listing=self.to_listing(db, source, user_id=user_id),
            installed_kind_id=binding.id,
            installed_reference={
                "namespace": binding.namespace,
                "name": source.name,
                "kind": "SkillBinding",
                "skill_id": source.id,
                "resource_type": "skill",
            },
            installed_at=binding.created_at,
            updated_at=binding.updated_at,
        )

    def _skill_binding_responses(
        self,
        db: Session,
        bindings: Iterable[Kind],
        user_id: int,
    ) -> list[ResourceLibraryInstall]:
        binding_list = list(bindings)
        source_ids = {
            self._nested_int(self._spec(binding), "skillRef", "skillId")
            for binding in binding_list
        }
        source_ids.discard(0)
        sources = (
            db.query(Kind)
            .filter(
                Kind.id.in_(source_ids),
                Kind.kind == "Skill",
                Kind.is_active == True,
            )
            .all()
            if source_ids
            else []
        )
        source_by_id = {source.id: source for source in sources}
        return [
            self._skill_binding_response(db, binding, source_by_id[source_id], user_id)
            for binding in binding_list
            if (
                source_id := self._nested_int(
                    self._spec(binding), "skillRef", "skillId"
                )
            )
            in source_by_id
        ]

    def _personal_install_responses(
        self, db: Session, user_id: int, resource_type: str | None
    ) -> list[ResourceLibraryInstall]:
        result: list[ResourceLibraryInstall] = []
        if resource_type in {None, "agent"}:
            members = (
                db.query(ResourceMember)
                .filter(
                    ResourceMember.resource_type == ResourceType.TEAM.value,
                    ResourceMember.entity_type == "user",
                    ResourceMember.entity_id == str(user_id),
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .all()
            )
            source_by_id = {
                source.id: source
                for source in db.query(Kind)
                .filter(
                    Kind.id.in_([member.resource_id for member in members]),
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .all()
            }
            result.extend(
                self._agent_member_response(
                    db,
                    member=member,
                    source=source_by_id[member.resource_id],
                    target_namespace="default",
                    user_id=user_id,
                )
                for member in members
                if member.resource_id in source_by_id
            )
        if resource_type in {None, "skill"}:
            result.extend(
                self._skill_binding_responses(
                    db,
                    skill_binding_service.list_user_default_bindings(db, user_id),
                    user_id,
                )
            )
        return result

    def _group_agent_install_responses(
        self,
        db: Session,
        *,
        group_namespace: str,
        user_id: int,
    ) -> list[ResourceLibraryInstall]:
        namespace = (
            db.query(Namespace)
            .filter(
                Namespace.name == group_namespace,
                Namespace.is_active.is_(True),
            )
            .first()
        )
        if not namespace:
            return []

        members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id == str(namespace.id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        referenced_ids = {member.resource_id for member in members}
        sources = (
            db.query(Kind)
            .filter(
                Kind.kind == "Team",
                Kind.is_active == True,
                Kind.id.in_(referenced_ids),
            )
            .all()
            if referenced_ids
            else []
        )
        source_by_id = {source.id: source for source in sources}
        member_by_source_id = {
            member.resource_id: member
            for member in members
            if member.resource_id in source_by_id
        }
        result: list[ResourceLibraryInstall] = []
        for source_id, member in member_by_source_id.items():
            source = source_by_id[source_id]
            result.append(
                self._agent_member_response(
                    db,
                    member=member,
                    source=source,
                    target_namespace=group_namespace,
                    user_id=user_id,
                )
            )
        return result

    def _query_resources(self, db: Session, resource_type: str | None) -> list[Kind]:
        kinds = (
            [RESOURCE_KIND_BY_TYPE[resource_type]]
            if resource_type
            else list(RESOURCE_TYPE_BY_KIND)
        )
        return db.query(Kind).filter(Kind.kind.in_(kinds), Kind.is_active == True).all()

    def _validate_agent_dependencies(self, db: Session, source: Kind) -> None:
        members = self._spec(source).get("members", [])
        for member in members if isinstance(members, list) else []:
            bot_ref = member.get("botRef", {}) if isinstance(member, dict) else {}
            bot = self._find_referenced_kind(
                db,
                kind="Bot",
                name=bot_ref.get("name"),
                namespace=bot_ref.get("namespace", source.namespace),
                owner_id=source.user_id,
            )
            if not bot:
                raise HTTPException(status_code=400, detail="Agent Bot not found")
            bot_spec = self._spec(bot)
            for ref_field, dependency_kind in (
                ("shellRef", "Shell"),
                ("modelRef", "Model"),
            ):
                reference = bot_spec.get(ref_field)
                if not isinstance(reference, dict) or not reference.get("name"):
                    continue
                dependency = self._find_referenced_kind(
                    db,
                    kind=dependency_kind,
                    name=reference.get("name"),
                    namespace=reference.get("namespace", bot.namespace),
                    owner_id=source.user_id,
                )
                if not dependency:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Agent {dependency_kind} not found",
                    )

    def _find_referenced_kind(
        self,
        db: Session,
        *,
        kind: str,
        name: Any,
        namespace: Any,
        owner_id: int,
    ) -> Kind | None:
        if not name:
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.kind == kind,
                Kind.name == str(name),
                Kind.namespace == str(namespace or "default"),
                Kind.user_id.in_([owner_id, 0]),
                Kind.is_active == True,
            )
            .order_by(Kind.user_id.desc())
            .first()
        )

    def _require_install_permission(
        self,
        db: Session,
        *,
        capability: dict[str, Any],
        target_namespace: str,
        user_id: int,
    ) -> None:
        if target_namespace == "default":
            if not capability.get("allowPersonalInstall", True):
                raise HTTPException(status_code=403, detail="Personal install disabled")
            return
        if not capability.get("allowGroupInstall", True):
            raise HTTPException(status_code=403, detail="Group install disabled")
        self._require_target_namespace_permission(
            db,
            target_namespace=target_namespace,
            user_id=user_id,
        )

    def _require_target_namespace_permission(
        self,
        db: Session,
        *,
        target_namespace: str,
        user_id: int,
    ) -> None:
        if target_namespace == "default":
            return
        if not check_group_permission(
            db, user_id, target_namespace, GroupRole.Developer
        ):
            raise HTTPException(
                status_code=403,
                detail="Developer role is required to install into a group",
            )

    def _require_publish_permission(
        self, db: Session, source: Kind, current_user: User
    ) -> None:
        if not self._can_publish(db, source, current_user):
            raise HTTPException(status_code=403, detail="Publish permission denied")

    def _can_publish(self, db: Session, source: Kind, current_user: User) -> bool:
        if current_user.role == "admin":
            return True
        if source.user_id == current_user.id and source.namespace == "default":
            return True
        if source.namespace != "default":
            return check_group_permission(
                db, current_user.id, source.namespace, GroupRole.Maintainer
            )
        return False

    def _is_public(self, source: Kind) -> bool:
        capability = self._capability(source)
        if capability:
            return (
                capability.get("visibility") == "public"
                and capability.get("publishStatus") == "published"
            )
        return source.user_id == 0

    def _effective_capability(self, source: Kind) -> dict[str, Any]:
        capability = self._capability(source)
        if capability:
            return capability
        if source.user_id == 0:
            return {
                "visibility": "public",
                "publishStatus": "published",
                "version": self._source_version(source),
                "allowPersonalInstall": True,
                "allowGroupInstall": True,
            }
        return {
            "visibility": "group" if source.namespace != "default" else "private",
            "publishStatus": "draft",
            "version": self._source_version(source),
        }

    def _is_personally_installed(self, db: Session, source: Kind, user_id: int) -> bool:
        if source.kind == "Skill":
            return source.id in skill_binding_service.list_user_default_skill_ids(
                db, user_id
            )
        if source.user_id == 0:
            return True
        if source.namespace == "default" and source.user_id == user_id:
            return True
        return (
            db.query(ResourceMember.id)
            .filter(
                ResourceMember.resource_type == ResourceType.TEAM.value,
                ResourceMember.resource_id == source.id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
            is not None
        )

    def _listing_install_count(self, db: Session, source: Kind) -> int:
        publication = db.get(MarketplaceResource, source.id)
        return publication.install_count if publication else 0

    def _increment_publication_install_count(self, db: Session, source_id: int) -> None:
        (
            db.query(MarketplaceResource)
            .filter(MarketplaceResource.kind_id == source_id)
            .update(
                {
                    MarketplaceResource.install_count: (
                        MarketplaceResource.install_count + 1
                    )
                },
                synchronize_session="fetch",
            )
        )

    def _sync_publication_index(self, db: Session, source: Kind) -> None:
        publication = db.get(MarketplaceResource, source.id)
        should_index = source.user_id != 0 and self._is_public(source)
        if not should_index:
            if publication:
                db.delete(publication)
            return

        now = datetime.utcnow()
        if publication:
            publication.resource_type = RESOURCE_TYPE_BY_KIND[source.kind]
            publication.updated_at = now
            return
        db.add(
            MarketplaceResource(
                kind_id=source.id,
                resource_type=RESOURCE_TYPE_BY_KIND[source.kind],
                install_count=0,
                published_at=now,
                updated_at=now,
            )
        )

    def _set_capability(self, source: Kind, capability: dict[str, Any]) -> None:
        payload = deepcopy(source.json) if isinstance(source.json, dict) else {}
        spec = payload.setdefault("spec", {})
        spec["capability"] = capability
        source.json = payload
        flag_modified(source, "json")

    def _capability(self, source: Kind) -> dict[str, Any]:
        capability = self._spec(source).get("capability", {})
        return deepcopy(capability) if isinstance(capability, dict) else {}

    def _capability_publisher_id(self, capability: dict[str, Any]) -> int | None:
        published_by = capability.get("publishedBy")
        if isinstance(published_by, bool) or published_by is None:
            return None
        try:
            return int(published_by)
        except (TypeError, ValueError):
            return None

    def _normalize_group_names(self, values: Iterable[Any]) -> list[str]:
        """Normalize group namespaces while preserving the requested order."""
        result: list[str] = []
        seen: set[str] = set()
        for value in values:
            group_name = str(value).strip()
            if not group_name or group_name == "default" or group_name in seen:
                continue
            seen.add(group_name)
            result.append(group_name)
        return result

    def _spec(self, resource: Kind) -> dict[str, Any]:
        payload = resource.json if isinstance(resource.json, dict) else {}
        spec = payload.get("spec", {})
        return deepcopy(spec) if isinstance(spec, dict) else {}

    def _get_source(
        self, db: Session, source_id: int, expected_kind: str | None = None
    ) -> Kind:
        query = db.query(Kind).filter(Kind.id == source_id, Kind.is_active == True)
        if expected_kind:
            query = query.filter(Kind.kind == expected_kind)
        else:
            query = query.filter(Kind.kind.in_(list(RESOURCE_TYPE_BY_KIND)))
        source = query.first()
        if not source:
            raise HTTPException(status_code=404, detail="Capability resource not found")
        return source

    def _display_name(self, source: Kind) -> str:
        payload = source.json if isinstance(source.json, dict) else {}
        metadata = payload.get("metadata", {})
        spec = payload.get("spec", {})
        if source.kind == "Skill":
            return str(
                spec.get("displayName") or metadata.get("displayName") or source.name
            )
        return str(metadata.get("displayName") or source.name)

    def _description(self, source: Kind) -> str | None:
        return self._spec(source).get("description")

    def _icon(self, source: Kind) -> str | None:
        return self._spec(source).get("icon")

    def _tags(self, source: Kind) -> list[str]:
        tags = self._spec(source).get("tags", [])
        return [str(tag) for tag in tags] if isinstance(tags, list) else []

    def _source_version(self, source: Kind) -> str:
        return str(self._spec(source).get("version") or "1.0.0")

    def _normalize_tags(self, tags: list[str]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for raw_tag in tags:
            tag = raw_tag.strip()
            normalized = tag.lower()
            if not tag or normalized in seen:
                continue
            seen.add(normalized)
            result.append(tag[:50])
        return result[:20]

    def _nested_int(self, payload: dict[str, Any], parent: str, key: str) -> int:
        nested = payload.get(parent, {})
        value = nested.get(key) if isinstance(nested, dict) else None
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0


resource_library_service = ResourceLibraryService()

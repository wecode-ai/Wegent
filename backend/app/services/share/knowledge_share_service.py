# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Base share service for unified resource sharing.

Provides KnowledgeBase-specific implementation of the UnifiedShareService.
Includes permission check methods previously in KnowledgePermissionService.
"""

import logging
from collections import defaultdict
from datetime import datetime
from typing import Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import (
    MemberStatus,
    ResourceMember,
    ResourceRole,
)
from app.models.share_link import ResourceType, ShareLink
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.share import (
    BatchResourceMemberResponse,
    FailedMemberResponse,
    KBShareInfoResponse,
    MyKBPermissionResponse,
    MyPermissionSourcesResponse,
    PendingRequestInfo,
    ResourceMemberResponse,
)

# SchemaMemberRole is an alias to BaseRole for backward compatibility
# All role-related code should use BaseRole as the single source of truth
SchemaMemberRole = BaseRole
from app.schemas.namespace import GroupRole
from app.services.group_permission import (
    get_effective_role_in_group,
    get_restricted_analyst_groups,
    get_user_groups,
    is_restricted_analyst,
)
from app.services.knowledge.knowledge_access_policy import (
    get_user_knowledge_base_permission,
    meets_direct_access_requirement,
    resolve_knowledge_base_permission,
)
from app.services.knowledge.namespace_utils import (
    classify_namespace_level,
    is_organization_namespace,
    load_active_namespace_map,
)
from app.services.share.base_service import UnifiedShareService
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

logger = logging.getLogger(__name__)


class KnowledgeShareService(UnifiedShareService):
    """
    KnowledgeBase-specific share service.

    Knowledge bases are shared directly without copying.
    Members get access based on their permission level.
    """

    def __init__(self) -> None:
        super().__init__(ResourceType.KNOWLEDGE_BASE)

    def _get_resource(
        self, db: Session, resource_id: int, user_id: int
    ) -> Optional[Kind]:
        """
        Fetch KnowledgeBase resource.

        For Knowledge Bases, we check if resource exists and user has access via:
        1. Creator (user_id matches)
        2. Explicit shared access (ResourceMember)
        3. Organization membership (for organization knowledge bases)
        4. Team membership (for team knowledge bases)

        Note: For group KBs, Restricted Analysts are denied access regardless of
        explicit permissions (creator or ResourceMember grants). The KB's direct-
        access requirement is applied after these ACL checks.
        """
        logger.info(
            f"[_get_resource] Fetching KnowledgeBase: resource_id={resource_id}, user_id={user_id}"
        )

        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            logger.warning(
                f"[_get_resource] KnowledgeBase not found: resource_id={resource_id}"
            )
            return None

        logger.info(
            f"[_get_resource] KnowledgeBase found: id={kb.id}, "
            f"kb.user_id={kb.user_id}, namespace={kb.namespace}"
        )

        permission = resolve_knowledge_base_permission(db, kb, user_id)
        if not meets_direct_access_requirement(kb=kb, permission=permission):
            logger.warning(
                "[_get_resource] Access denied for KB %s and user %s",
                resource_id,
                user_id,
            )
            return None

        return kb

    def get_accessible_resources_by_ids(
        self,
        db: Session,
        resource_ids: Iterable[int],
        user_id: int,
    ) -> dict[int, Kind]:
        """Return requested knowledge bases accessible to one user in bounded batches."""
        requested_ids = sorted({int(resource_id) for resource_id in resource_ids})
        if not requested_ids:
            return {}

        resources = (
            db.query(Kind)
            .filter(
                Kind.id.in_(requested_ids),
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
            )
            .all()
        )
        if not resources:
            return {}

        namespace_map = load_active_namespace_map(
            db, [resource.namespace for resource in resources]
        )
        group_names = [
            resource.namespace
            for resource in resources
            if classify_namespace_level(
                resource.namespace,
                namespace_map.get(resource.namespace),
            )
            == "group"
        ]
        accessible_groups = set(get_user_groups(db, user_id))
        restricted_groups = get_restricted_analyst_groups(db, user_id, group_names)

        direct_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(self._resource_type_variants),
                ResourceMember.resource_id.in_(requested_ids),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(self._approved_status_variants),
            )
            .all()
        )
        direct_resource_ids = {
            member.resource_id
            for member in direct_members
            if member.get_effective_role() != ResourceRole.RestrictedAnalyst.value
        }
        entity_resource_ids = self._get_entity_accessible_resource_ids(
            db=db,
            resource_ids=requested_ids,
            user_id=user_id,
        )

        accessible: dict[int, Kind] = {}
        for resource in resources:
            namespace_level = classify_namespace_level(
                resource.namespace,
                namespace_map.get(resource.namespace),
            )
            is_restricted_group = resource.namespace in restricted_groups
            if is_restricted_group:
                continue
            if (
                resource.user_id == user_id
                or resource.id in direct_resource_ids
                or resource.id in entity_resource_ids
                or namespace_level == "organization"
                or (
                    namespace_level == "group"
                    and resource.namespace in accessible_groups
                )
            ):
                accessible[resource.id] = resource
        return accessible

    def _get_entity_accessible_resource_ids(
        self,
        *,
        db: Session,
        resource_ids: list[int],
        user_id: int,
    ) -> set[int]:
        """Resolve non-user resource memberships without per-resource queries."""
        entity_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(self._resource_type_variants),
                ResourceMember.resource_id.in_(resource_ids),
                ResourceMember.entity_type.notin_(["user", ""]),
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(self._approved_status_variants),
            )
            .all()
        )
        if not entity_members:
            return set()

        from app.services.share.external_entity_resolver import get_entity_resolver

        members_by_type: dict[str, list[ResourceMember]] = defaultdict(list)
        for member in entity_members:
            if member.entity_type:
                members_by_type[member.entity_type].append(member)

        accessible_ids: set[int] = set()
        for entity_type, members in members_by_type.items():
            resolver = get_entity_resolver(entity_type)
            if resolver is None:
                continue
            entity_ids = sorted(
                {member.entity_id for member in members if member.entity_id}
            )
            matched = resolver.match_entity_bindings(
                db,
                user_id,
                entity_type,
                entity_ids,
            )
            if not matched:
                continue
            accessible_ids.update(
                member.resource_id for member in members if member.entity_id in matched
            )
        return accessible_ids

    def _get_resource_name(self, resource: Kind) -> str:
        """Get KnowledgeBase display name."""
        return resource.name

    def _get_resource_owner_id(self, resource: Kind) -> int:
        """Get KnowledgeBase owner user ID."""
        return resource.user_id

    @trace_sync(
        span_name="knowledge_share.get_share_url_base",
        tracer_name="backend.services.share",
    )
    def _get_share_url_base(self) -> str:
        """Get base URL for KnowledgeBase share links."""

        # Use TASK_SHARE_BASE_URL consistent with Task sharing
        base_url = getattr(settings, "TASK_SHARE_BASE_URL", "http://localhost:3000")
        share_url = f"{base_url}/shared/knowledge"

        # Record tracing information
        add_span_event(
            "share_url_resolved",
            {"config_source": "TASK_SHARE_BASE_URL", "base_url": base_url},
        )
        set_span_attribute("share.base_url", share_url)

        return share_url

    def _on_member_approved(
        self, db: Session, member: ResourceMember, resource: Kind
    ) -> Optional[int]:
        """
        Hook called when a KnowledgeBase member is approved.

        For Knowledge Bases, we don't copy anything - members get direct access
        based on their permission level.
        """
        # No copy needed for Knowledge Bases
        logger.info(
            f"KnowledgeBase member approved: user={member.user_id}, "
            f"kb={resource.id}, role={member.role}"
        )
        return None

    # =========================================================================
    # Member addition overrides with KB-specific validation
    # =========================================================================

    def add_member(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        target_user_id: int,
        role: SchemaMemberRole,
        entity_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        entity_display_name: Optional[str] = None,
    ) -> ResourceMemberResponse:
        """Add a member to a KnowledgeBase with group-native KB protection.

        Prevents sharing a group-native KB back to its own group via
        entity-type membership, which would create a redundant record.
        """
        if entity_type == "namespace" and entity_id:
            kb = (
                db.query(Kind)
                .filter(
                    Kind.id == resource_id,
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active.is_(True),
                )
                .first()
            )
            if kb:
                try:
                    ns_id = int(entity_id)
                    from app.models.namespace import Namespace

                    target_ns = (
                        db.query(Namespace).filter(Namespace.id == ns_id).first()
                    )
                    if target_ns and kb.namespace == target_ns.name:
                        raise HTTPException(
                            status_code=400,
                            detail="Cannot share a knowledge base to its own group",
                        )
                except (ValueError, TypeError):
                    pass

        return super().add_member(
            db=db,
            resource_id=resource_id,
            current_user_id=current_user_id,
            target_user_id=target_user_id,
            role=role,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_display_name=entity_display_name,
        )

    def batch_add_members(
        self,
        db: Session,
        resource_id: int,
        current_user_id: int,
        members_data: List[
            Tuple[int, SchemaMemberRole, Optional[str], Optional[str], Optional[str]]
        ],
    ) -> BatchResourceMemberResponse:
        """Batch add members to a KnowledgeBase with group-native KB protection.

        Filters out entries that would share a group-native KB back to its
        own group; those entries are returned in the failed list.
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
            )
            .first()
        )

        filtered_members = []
        failed: List[FailedMemberResponse] = []
        for entry in members_data:
            _target_user_id, _role, ent_type, ent_id, _ent_display_name = entry
            if ent_type == "namespace" and ent_id and kb:
                try:
                    ns_id = int(ent_id)
                    from app.models.namespace import Namespace

                    target_ns = (
                        db.query(Namespace).filter(Namespace.id == ns_id).first()
                    )
                    if target_ns and kb.namespace == target_ns.name:
                        failed.append(
                            FailedMemberResponse(
                                user_id=0,
                                entity_type=ent_type,
                                entity_id=ent_id,
                                error="Cannot share a knowledge base to its own group",
                            )
                        )
                        continue
                except (ValueError, TypeError):
                    pass
            filtered_members.append(entry)

        result = super().batch_add_members(
            db=db,
            resource_id=resource_id,
            current_user_id=current_user_id,
            members_data=filtered_members,
        )

        result.failed.extend(failed)
        return result

    def get_user_kb_permission(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> Tuple[bool, Optional[str], bool]:
        """
        Get user's permission for a knowledge base.

        Returns:
            Tuple of (has_access, role, is_creator)
        """
        permission = get_user_knowledge_base_permission(
            db,
            knowledge_base_id,
            user_id,
        )
        return (
            permission.has_access,
            permission.role.value if permission.role else None,
            permission.is_creator,
        )

    def check_permission(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        required_role: SchemaMemberRole,
    ) -> bool:
        """Check permission using merged KB access semantics."""
        permission = get_user_knowledge_base_permission(
            db,
            resource_id,
            user_id,
        )
        if not permission.has_access:
            return False

        effective_role = (
            SchemaMemberRole.Owner if permission.is_creator else permission.role
        )
        if effective_role is None:
            return False

        return has_permission(effective_role, required_role)

    def can_manage_permissions(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """Check if user can manage permissions for a knowledge base."""
        permission = get_user_knowledge_base_permission(
            db,
            knowledge_base_id,
            user_id,
        )
        if permission.is_creator:
            return True
        return (
            permission.has_access
            and permission.role is not None
            and has_permission(permission.role, BaseRole.Maintainer)
        )

    def get_my_permission(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> MyKBPermissionResponse:
        """
        Get current user's permission for a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Current user ID

        Returns:
            MyKBPermissionResponse
        """
        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            return MyKBPermissionResponse(
                has_access=False,
                is_creator=False,
                pending_request=None,
            )

        permission = resolve_knowledge_base_permission(db, kb, user_id)
        explicit_perm = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == knowledge_base_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
            )
            .first()
        )

        pending_request = None

        if explicit_perm and not permission.is_denied:
            if explicit_perm.status == MemberStatus.PENDING.value:
                effective_role = explicit_perm.get_effective_role()
                pending_request = PendingRequestInfo(
                    id=explicit_perm.id,
                    role=SchemaMemberRole(effective_role),
                    requested_at=explicit_perm.requested_at,
                )

        # If user already has access and the pending role is not higher than
        # the current effective role, suppress the pending request to avoid
        # UX confusion (user already has access via entity permission, etc.)
        if pending_request and permission.has_access and permission.role:
            pending_role = (
                pending_request.role.value
                if hasattr(pending_request.role, "value")
                else str(pending_request.role)
            )
            if has_permission(permission.role, pending_role):
                pending_request = None

        has_access = meets_direct_access_requirement(kb=kb, permission=permission)

        return MyKBPermissionResponse(
            has_access=has_access,
            role=(
                SchemaMemberRole.Owner
                if permission.is_creator
                else (
                    SchemaMemberRole(permission.role.value)
                    if permission.role is not None
                    else None
                )
            ),
            is_creator=permission.is_creator,
            pending_request=pending_request,
        )

    def get_kb_share_info(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> KBShareInfoResponse:
        """
        Get knowledge base info for share page.

        Returns basic info about the KB and current user's permission status.
        This is used by the share link page to display KB info and handle
        permission requests.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Current user ID

        Returns:
            KBShareInfoResponse

        Raises:
            ValueError: If knowledge base not found
        """
        # Get KB basic info (allow access even without permission for share page)
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        spec = kb.json.get("spec", {})

        # Get current user's permission
        my_permission = self.get_my_permission(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )

        # Get creator info
        creator = db.query(User).filter(User.id == kb.user_id).first()
        creator_name = creator.user_name if creator else f"User {kb.user_id}"

        return KBShareInfoResponse(
            id=kb.id,
            name=spec.get("name", ""),
            description=spec.get("description"),
            namespace=kb.namespace,
            creator_id=kb.user_id,
            creator_name=creator_name,
            created_at=kb.created_at.isoformat() if kb.created_at else None,
            my_permission=my_permission,
        )

    def get_public_kb_info(
        self,
        db: Session,
        share_token: str,
    ) -> dict:
        """
        Get public knowledge base info by share token (no auth required).

        This method is used by the public share page to display KB info
        without requiring authentication.

        Args:
            db: Database session
            share_token: Encrypted share token

        Returns:
            Dict with public KB info

        Raises:
            ValueError: If token is invalid or KB not found
        """
        import urllib.parse

        # Decode token
        token_info = self._decode_share_token(share_token)
        if not token_info:
            raise ValueError("Invalid share token")

        resource_type, owner_id, resource_id = token_info

        # Validate resource type
        if resource_type != self.resource_type.value:
            raise ValueError("Invalid resource type")

        # Find share link by resource_id (more reliable than token matching)
        # The token in DB is URL-encoded, but FastAPI may have decoded the input
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == resource_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        if not share_link:
            raise ValueError("Share link not found or inactive")

        # Check expiration
        from datetime import datetime

        is_expired = False
        if share_link.expires_at and datetime.utcnow() > share_link.expires_at:
            is_expired = True

        # Get KB info
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            raise ValueError("Knowledge base not found")

        spec = kb.json.get("spec", {})

        # Get creator info
        creator = db.query(User).filter(User.id == kb.user_id).first()
        creator_name = creator.user_name if creator else f"User {kb.user_id}"

        # Get default_role from the model, fallback to Reporter
        default_role = getattr(share_link, "default_role", None)
        if not default_role:
            default_role = ResourceRole.Reporter.value

        return {
            "id": kb.id,
            "name": spec.get("name", ""),
            "namespace": kb.namespace,
            "description": spec.get("description"),
            "creator_id": kb.user_id,
            "creator_name": creator_name,
            "require_approval": share_link.require_approval,
            "default_role": default_role,
            "is_expired": is_expired,
        }

    def get_share_token_by_kb_id(
        self,
        db: Session,
        knowledge_base_id: int,
    ) -> str | None:
        """
        Get share token for a knowledge base by its ID.

        Used for redirecting old share links to new token-based format.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Share token if found, None otherwise
        """
        # Note: Database may store resource_type in different formats (e.g., "KNOWLEDGE_BASE" vs "KnowledgeBase")
        resource_type_variants = self._resource_type_variants

        share_link = (
            db.query(ShareLink)
            .filter(
                ShareLink.resource_type.in_(resource_type_variants),
                ShareLink.resource_id == knowledge_base_id,
                ShareLink.is_active == True,
            )
            .first()
        )

        return share_link.share_token if share_link else None

    # =========================================================================
    # Permission Sources
    # =========================================================================

    def get_my_permission_sources(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
    ) -> MyPermissionSourcesResponse:
        """
        Get all permission sources for the current user on a knowledge base.

        Delegates to the knowledge access policy for consistent permission logic.
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )
        if not kb:
            return MyPermissionSourcesResponse(
                has_access=False,
                is_creator=False,
                sources=[],
            )

        permission = resolve_knowledge_base_permission(
            db,
            kb,
            user_id,
            include_sources=True,
        )
        has_access = meets_direct_access_requirement(kb=kb, permission=permission)

        return MyPermissionSourcesResponse(
            has_access=has_access,
            is_creator=permission.is_creator,
            effective_role=(permission.role.value if permission.role else None),
            sources=list(permission.sources),
        )

    # =========================================================================
    # Cleanup Methods
    # =========================================================================

    def delete_members_for_kb(
        self,
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Delete all members for a knowledge base (called when KB is deleted).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.resource_id == knowledge_base_id,
            )
            .delete()
        )
        db.flush()
        return result

    def delete_members_for_user(
        self,
        db: Session,
        user_id: int,
    ) -> int:
        """
        Delete all KB members for a user (called when user is deleted).

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Number of deleted records
        """
        result = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
            )
            .delete()
        )
        db.flush()
        return result


# Singleton instance
knowledge_share_service = KnowledgeShareService()

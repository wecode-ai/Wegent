# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Base share service for unified resource sharing.

Provides KnowledgeBase-specific implementation of the UnifiedShareService.
Includes permission check methods previously in KnowledgePermissionService.
"""

import logging
from datetime import datetime
from typing import List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.share_link import ResourceType, ShareLink
from app.models.user import User
from app.schemas.base_role import BaseRole, get_highest_role, has_permission
from app.schemas.share import (
    BatchResourceMemberResponse,
    FailedMemberResponse,
    KBShareInfoResponse,
    MyKBPermissionResponse,
    MyPermissionSourcesResponse,
    PendingRequestInfo,
    PermissionSourceInfo,
    ResourceMemberResponse,
)

# SchemaMemberRole is an alias to BaseRole for backward compatibility
# All role-related code should use BaseRole as the single source of truth
SchemaMemberRole = BaseRole
from app.schemas.namespace import GroupRole
from app.services.group_permission import (
    get_effective_role_in_group,
    get_restricted_analyst_groups,
    is_restricted_analyst,
)
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.share.base_service import UnifiedShareService
from shared.models.knowledge import KnowledgeBaseToolAccessMode
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_sync

logger = logging.getLogger(__name__)


def get_knowledge_base_tool_access_mode_by_ids(
    db: Session,
    user_id: int,
    knowledge_base_ids: list[int],
) -> tuple[str, str]:
    """Resolve KB tool exposure mode from KB-specific and group permissions."""
    if not knowledge_base_ids:
        return KnowledgeBaseToolAccessMode.FULL, ""

    kbs = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active,
        )
        .all()
    )
    if not kbs:
        return KnowledgeBaseToolAccessMode.FULL, ""

    explicit_restricted_member = (
        db.query(ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
            ResourceMember.resource_id.in_([kb.id for kb in kbs]),
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status == MemberStatus.APPROVED.value,
            ResourceMember.role == ResourceRole.RestrictedAnalyst.value,
        )
        .first()
    )
    if explicit_restricted_member is not None:
        return (
            KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY,
            "Restricted Analysts may use knowledge base search only for high-level "
            "analysis. Document browsing remains blocked.",
        )

    group_names = [
        kb.namespace
        for kb in kbs
        if kb.namespace != "default" and not is_organization_namespace(db, kb.namespace)
    ]
    if get_restricted_analyst_groups(db, user_id, group_names):
        return (
            KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY,
            "Restricted Analysts may use knowledge base search only for high-level "
            "analysis. Document browsing remains blocked.",
        )

    return KnowledgeBaseToolAccessMode.FULL, ""


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
        explicit permissions (creator or ResourceMember grants).
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

        # For group knowledge bases, check Restricted Analyst status FIRST
        # This check must run before creator/explicit-share checks to prevent bypass
        if kb.namespace != "default" and not is_organization_namespace(
            db, kb.namespace
        ):
            if is_restricted_analyst(db, user_id, kb.namespace):
                logger.warning(
                    f"[_get_resource] User {user_id} is Restricted Analyst in group "
                    f"'{kb.namespace}', blocking access to KB {resource_id}"
                )
                return None

        # Check if user is creator
        if kb.user_id == user_id:
            logger.info(
                f"[_get_resource] User is creator: user_id={user_id} == kb.user_id={kb.user_id}"
            )
            return kb

        logger.info(
            f"[_get_resource] User is NOT creator: user_id={user_id} != kb.user_id={kb.user_id}"
        )

        # Check if user has explicit shared access
        resource_type_variants = self._resource_type_variants
        approved_status_variants = self._approved_status_variants

        member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(approved_status_variants),
            )
            .first()
        )
        if member:
            # RestrictedAnalyst is not allowed to access knowledge base details
            if member.get_effective_role() == ResourceRole.RestrictedAnalyst.value:
                logger.warning(
                    f"[_get_resource] User has explicit access but is RestrictedAnalyst: member_id={member.id}"
                )
                return None
            logger.info(
                f"[_get_resource] User has explicit shared access: member_id={member.id}"
            )
            return kb

        logger.info("[_get_resource] User has NO explicit shared access")

        # Check entity-type memberships (e.g., namespace)
        entity_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.resource_id == resource_id,
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(approved_status_variants),
            )
            .all()
        )
        if entity_members:
            from app.services.share.external_entity_resolver import (
                get_entity_resolver,
            )

            entity_groups: dict[str, list[str]] = {}
            for em in entity_members:
                if em.entity_type and em.entity_id:
                    entity_groups.setdefault(em.entity_type, []).append(em.entity_id)

            for entity_type_str, entity_ids in entity_groups.items():
                resolver = get_entity_resolver(entity_type_str)
                if resolver:
                    matched = resolver.match_entity_bindings(
                        db,
                        user_id,
                        entity_type_str,
                        entity_ids,
                    )
                    if matched:
                        logger.info(
                            f"[_get_resource] User {user_id} matched entity "
                            f"type='{entity_type_str}' via resolver"
                        )
                        return kb

        # For organization knowledge bases, all authenticated users have access
        if is_organization_namespace(db, kb.namespace):
            logger.info(
                f"[_get_resource] Organization KB - granting access to user_id={user_id}"
            )
            return kb

        # For team knowledge bases, check group permission
        if kb.namespace != "default":
            logger.info(
                f"[_get_resource] Checking team permission: namespace={kb.namespace}"
            )
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is not None:
                # RestrictedAnalyst is not allowed to access knowledge base details
                if role == GroupRole.RestrictedAnalyst:
                    logger.warning(
                        "[_get_resource] User has team role but is RestrictedAnalyst"
                    )
                    return None
                logger.info(f"[_get_resource] User has team role: role={role}")
                return kb
            logger.info(
                f"[_get_resource] User has NO team role in namespace={kb.namespace}"
            )
        else:
            logger.info(
                f"[_get_resource] KnowledgeBase is personal (namespace=default)"
            )

        logger.error(
            f"[_get_resource] User has NO access to KnowledgeBase: "
            f"resource_id={resource_id}, user_id={user_id}, "
            f"kb.user_id={kb.user_id}, namespace={kb.namespace}"
        )
        return None  # Only return KB for authorized users

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

    # =========================================================================
    # Permission Check Methods (integrated from KnowledgePermissionService)
    # =========================================================================

    # =====================================================================
    # Permission source helpers — each returns (roles, sources) and may
    # signal an early-return condition for Restricted Analyst.
    # =====================================================================

    def _source_creator(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        user: Optional[User],
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo]]:
        """Creator permission source."""
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        if kb.user_id == user_id:
            if include_sources:
                sources.append(
                    PermissionSourceInfo(
                        source_type="creator",
                        display_name=user.user_name if user else None,
                        role=BaseRole.Owner.value,
                        entity_type="user",
                        entity_id=str(user_id),
                    )
                )
            roles.append(BaseRole.Owner.value)
        return roles, sources

    def _source_direct_member(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        user: Optional[User],
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo], bool]:
        """Direct user-type ResourceMember permission source.

        Returns:
            (roles, sources, is_restricted_analyst)
        """
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        user_member = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(self._resource_type_variants),
                ResourceMember.resource_id == kb.id,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(self._approved_status_variants),
            )
            .first()
        )
        if user_member:
            effective_role = user_member.get_effective_role()
            if effective_role == ResourceRole.RestrictedAnalyst.value:
                return [], [], True
            if include_sources:
                source_type = self._resolve_source_type(user_member)
                sources.append(
                    PermissionSourceInfo(
                        source_type=source_type,
                        display_name=user.user_name if user else None,
                        role=effective_role,
                        entity_type="user",
                        entity_id=str(user_id),
                    )
                )
            roles.append(effective_role)
        return roles, sources, False

    def _source_organization(
        self,
        db: Session,
        kb: Kind,
        user: Optional[User],
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo]]:
        """Organization knowledge base permission source."""
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        if is_organization_namespace(db, kb.namespace):
            org_role = (
                ResourceRole.Owner.value
                if user and user.role == "admin"
                else ResourceRole.Reporter.value
            )
            if include_sources:
                sources.append(
                    PermissionSourceInfo(
                        source_type="organization",
                        display_name="Organization",
                        role=org_role,
                    )
                )
            roles.append(org_role)
        return roles, sources

    def _source_group_membership(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo], bool]:
        """Group membership permission source for team knowledge bases.

        Returns:
            (roles, sources, is_restricted_analyst)
        """
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        if kb.namespace == "default" or is_organization_namespace(db, kb.namespace):
            return roles, sources, False

        group_role = get_effective_role_in_group(db, user_id, kb.namespace)
        if group_role is None:
            return roles, sources, False

        if group_role == GroupRole.RestrictedAnalyst:
            return [], [], True

        role_mapping = {
            GroupRole.Owner: BaseRole.Owner.value,
            GroupRole.Maintainer: BaseRole.Maintainer.value,
            GroupRole.Developer: BaseRole.Developer.value,
            GroupRole.Reporter: BaseRole.Reporter.value,
        }
        mapped_role = role_mapping.get(group_role, BaseRole.Reporter.value)
        if include_sources:
            group = db.query(Namespace).filter(Namespace.name == kb.namespace).first()
            sources.append(
                PermissionSourceInfo(
                    source_type="group_membership",
                    display_name=(
                        group.display_name or group.name if group else kb.namespace
                    ),
                    role=mapped_role,
                )
            )
        roles.append(mapped_role)
        return roles, sources, False

    def _source_entity_permission(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo]]:
        """Entity-type ResourceMember permission source."""
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        entity_rows = (
            db.query(
                ResourceMember.entity_type,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(self._resource_type_variants),
                ResourceMember.resource_id == kb.id,
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(self._approved_status_variants),
            )
            .all()
        )
        if not entity_rows:
            return roles, sources

        from app.services.share.external_entity_resolver import get_entity_resolver

        entity_groups: dict[str, list[str]] = {}
        entity_role_map: dict[str, str] = {}
        for et, eid, role_str in entity_rows:
            if et and eid:
                entity_groups.setdefault(et, []).append(eid)
                entity_role_map[f"{et}:{eid}"] = role_str

        for entity_type_str, entity_ids in entity_groups.items():
            resolver = get_entity_resolver(entity_type_str)
            if not resolver:
                continue
            matched = resolver.match_entity_bindings(
                db, user_id, entity_type_str, entity_ids
            )
            if not matched:
                continue
            if include_sources:
                display_names = resolver.batch_get_display_names(db, list(matched))
            for eid in matched:
                key = f"{entity_type_str}:{eid}"
                role_str = entity_role_map.get(key)
                if not role_str:
                    continue
                if include_sources:
                    sources.append(
                        PermissionSourceInfo(
                            source_type="entity_permission",
                            display_name=display_names.get(eid),
                            role=role_str,
                            entity_type=entity_type_str,
                            entity_id=eid,
                        )
                    )
                roles.append(role_str)
        return roles, sources

    def _source_group_chat_binding(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        include_sources: bool,
    ) -> tuple[list[str], list[PermissionSourceInfo]]:
        """Group chat binding permission source for personal KBs."""
        roles: list[str] = []
        sources: list[PermissionSourceInfo] = []
        if kb.namespace == "default" and self._is_kb_bound_to_user_group_chat(
            db, kb.id, user_id
        ):
            if include_sources:
                sources.append(
                    PermissionSourceInfo(
                        source_type="group_chat_binding",
                        display_name="Group Chat",
                        role=ResourceRole.Reporter.value,
                    )
                )
            roles.append(ResourceRole.Reporter.value)
        return roles, sources

    def _compute_kb_access_core(
        self,
        db: Session,
        kb: Kind,
        user_id: int,
        include_sources: bool = True,
    ) -> tuple[bool, bool, Optional[str], list[PermissionSourceInfo]]:
        """
        Core permission computation shared by get_user_kb_permission and
        get_my_permission_sources. Collects ALL permission sources and computes
        the highest effective role via get_highest_role.

        Returns:
            Tuple of (has_access, is_creator, effective_role, sources)
        """
        sources: list[PermissionSourceInfo] = []
        roles: list[str] = []

        # Pre-fetch user once to avoid repeated queries
        user = db.query(User).filter(User.id == user_id).first()

        # 1. Creator
        is_creator = kb.user_id == user_id
        r, s = self._source_creator(db, kb, user_id, user, include_sources)
        roles.extend(r)
        sources.extend(s)

        # Creator bypasses Restricted Analyst check
        if not is_creator and kb.namespace != "default":
            if not is_organization_namespace(db, kb.namespace):
                if is_restricted_analyst(db, user_id, kb.namespace):
                    return False, is_creator, None, sources

        # 2. Direct user-type member
        r, s, restricted = self._source_direct_member(
            db, kb, user_id, user, include_sources
        )
        if restricted:
            return False, is_creator, None, sources
        roles.extend(r)
        sources.extend(s)

        # 3. Organization
        r, s = self._source_organization(db, kb, user, include_sources)
        roles.extend(r)
        sources.extend(s)

        # 4. Group membership
        r, s, restricted = self._source_group_membership(
            db, kb, user_id, include_sources
        )
        if restricted:
            return False, is_creator, None, sources
        roles.extend(r)
        sources.extend(s)

        # 5. Entity permission
        r, s = self._source_entity_permission(db, kb, user_id, include_sources)
        roles.extend(r)
        sources.extend(s)

        # 6. Group chat binding
        r, s = self._source_group_chat_binding(db, kb, user_id, include_sources)
        roles.extend(r)
        sources.extend(s)

        effective_role = get_highest_role(roles) if roles else None
        has_access = len(roles) > 0 or is_creator
        return has_access, is_creator, effective_role, sources

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
            return False, None, False

        has_access, is_creator, effective_role, _ = self._compute_kb_access_core(
            db, kb, user_id, include_sources=False
        )
        return has_access, effective_role, is_creator

    def check_permission(
        self,
        db: Session,
        resource_id: int,
        user_id: int,
        required_role: SchemaMemberRole,
    ) -> bool:
        """Check permission using merged KB access semantics."""
        from app.services.knowledge.knowledge_service import KnowledgeService

        has_access, role, is_creator = KnowledgeService._get_user_kb_permission(
            db, resource_id, user_id
        )
        if not has_access:
            return False

        effective_role = SchemaMemberRole.Owner if is_creator else role
        if effective_role is None:
            return False

        return has_permission(effective_role, required_role)

    def _is_kb_bound_to_user_group_chat(
        self, db: Session, kb_id: int, user_id: int
    ) -> bool:
        """Check if a knowledge base is bound to any group chat that the user is a member of.

        When a knowledge base is bound to a group chat, all members of that group chat
        should have access to the knowledge base (reporter permission level).

        Args:
            db: Database session
            kb_id: Knowledge base Kind.id
            user_id: User ID to check

        Returns:
            True if KB is bound to at least one group chat where user is a member
        """
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType
        from app.models.task import TaskResource

        # Query all group chat tasks where this KB is bound and user is a member
        # We need to check task.json->spec->knowledgeBaseRefs for the KB binding
        # First, get tasks where user is the owner
        owned_tasks = (
            db.query(TaskResource)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                TaskResource.user_id == user_id,
            )
            .all()
        )

        # Then, get tasks where user is an approved member via ResourceMember
        member_tasks = (
            db.query(TaskResource)
            .join(ResourceMember, ResourceMember.resource_id == TaskResource.id)
            .filter(
                TaskResource.kind == "Task",
                TaskResource.is_active == TaskResource.STATE_ACTIVE,
                ResourceMember.resource_type == ResourceType.TASK,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED,
            )
            .all()
        )

        # Combine owned and member tasks
        tasks_with_kb = list(owned_tasks) + list(member_tasks)

        for task in tasks_with_kb:
            task_json = task.json if isinstance(task.json, dict) else {}
            spec = task_json.get("spec", {})
            kb_refs = spec.get("knowledgeBaseRefs", []) or []

            for ref in kb_refs:
                # Check if this KB is bound (match by ID or by name+namespace)
                ref_id = ref.get("id")
                if ref_id == kb_id:
                    return True

        return False

    def can_manage_permissions(
        self,
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """Check if user can manage permissions for a knowledge base."""
        from app.services.knowledge.knowledge_service import KnowledgeService

        has_access, role, is_creator = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id
        )
        if is_creator:
            return True
        return (
            has_access
            and role is not None
            and has_permission(role, BaseRole.Maintainer)
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

        # For group knowledge bases, check Restricted Analyst status FIRST
        # This check must run before creator/explicit-share checks to prevent bypass
        is_restricted = False
        if kb.namespace != "default" and not is_organization_namespace(
            db, kb.namespace
        ):
            if is_restricted_analyst(db, user_id, kb.namespace):
                logger.warning(
                    f"[get_my_permission] User {user_id} is Restricted Analyst in group "
                    f"'{kb.namespace}', denying access to KB {knowledge_base_id}"
                )
                is_restricted = True

        # Check if user is creator
        is_creator = kb.user_id == user_id
        if is_creator and not is_restricted:
            return MyKBPermissionResponse(
                has_access=True,
                role=SchemaMemberRole.Owner,
                is_creator=True,
                pending_request=None,
            )

        # Check explicit permission
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

        if explicit_perm and not is_restricted:
            if explicit_perm.status == MemberStatus.PENDING.value:
                effective_role = explicit_perm.get_effective_role()
                pending_request = PendingRequestInfo(
                    id=explicit_perm.id,
                    role=SchemaMemberRole(effective_role),
                    requested_at=explicit_perm.requested_at,
                )

        from app.services.knowledge.knowledge_service import KnowledgeService

        has_access, merged_role, is_creator = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id, kb=kb
        )

        # If user already has access and the pending role is not higher than
        # the current effective role, suppress the pending request to avoid
        # UX confusion (user already has access via entity permission, etc.)
        if pending_request and has_access and merged_role:
            pending_role = (
                pending_request.role.value
                if hasattr(pending_request.role, "value")
                else str(pending_request.role)
            )
            if has_permission(merged_role, pending_role):
                pending_request = None

        return MyKBPermissionResponse(
            has_access=has_access,
            role=(
                SchemaMemberRole.Owner
                if is_creator
                else (
                    SchemaMemberRole(merged_role.value)
                    if merged_role is not None
                    else None
                )
            ),
            is_creator=is_creator,
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

        Delegates to _compute_kb_access_core for consistent permission logic.
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

        has_access, is_creator, effective_role, sources = self._compute_kb_access_core(
            db, kb, user_id, include_sources=True
        )

        return MyPermissionSourcesResponse(
            has_access=has_access,
            is_creator=is_creator,
            effective_role=effective_role,
            sources=sources,
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

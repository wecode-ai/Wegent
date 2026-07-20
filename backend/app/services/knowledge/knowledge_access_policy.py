# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base ACL resolution and action-specific access policies."""

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import (
    APPROVED_MEMBER_STATUS_VALUES,
    KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES,
    ResourceMember,
)
from app.models.user import User
from app.schemas.base_role import BaseRole, get_highest_role
from app.schemas.namespace import GroupRole
from app.schemas.share import PermissionSourceInfo
from app.services.external_entity_resolver import get_entity_resolver
from app.services.group_permission import (
    get_effective_role_in_group,
    get_restricted_analyst_groups,
    is_restricted_analyst,
)
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.knowledge.permission_policy import (
    can_manage_accessible_knowledge_base_documents,
)
from app.stores.tasks import task_store
from shared.models.knowledge import KnowledgeBaseToolAccessMode

DEFAULT_DIRECT_ACCESS_REQUIREMENT = "read"
RESTRICTED_ANALYST_REASON = (
    "Restricted Analysts may use knowledge base search only for high-level "
    "analysis. Document browsing remains blocked."
)


@dataclass(frozen=True)
class KnowledgeBasePermission:
    """Raw ACL facts before applying an action-specific access policy."""

    has_access: bool
    role: BaseRole | None
    is_creator: bool
    sources: tuple[PermissionSourceInfo, ...] = ()
    is_denied: bool = False


def resolve_knowledge_base_permission(
    db: Session,
    kb: Kind,
    user_id: int,
    *,
    include_sources: bool = False,
) -> KnowledgeBasePermission:
    """Resolve all ACL sources and explicit denials for one knowledge base."""
    sources: list[PermissionSourceInfo] = []
    roles: list[str] = []
    user = db.query(User).filter(User.id == user_id).first()
    is_creator = kb.user_id == user_id

    _append_creator_source(roles, sources, kb, user_id, user, include_sources)

    if (
        not is_creator
        and kb.namespace != "default"
        and not is_organization_namespace(db, kb.namespace)
        and is_restricted_analyst(db, user_id, kb.namespace)
    ):
        return KnowledgeBasePermission(
            False,
            None,
            is_creator,
            tuple(sources),
            is_denied=True,
        )

    if _append_direct_member_source(
        db, roles, sources, kb, user_id, user, include_sources
    ):
        return KnowledgeBasePermission(
            False,
            None,
            is_creator,
            tuple(sources),
            is_denied=True,
        )

    _append_organization_source(db, roles, sources, kb, user, include_sources)
    if _append_group_source(db, roles, sources, kb, user_id, include_sources):
        return KnowledgeBasePermission(False, None, is_creator, tuple(sources))
    _append_entity_sources(db, roles, sources, kb, user_id, include_sources)

    if kb.namespace == "default" and not roles:
        _append_group_chat_source(db, roles, sources, kb, user_id, include_sources)

    effective_role = get_highest_role(roles) if roles else None
    return KnowledgeBasePermission(
        has_access=bool(roles) or is_creator,
        role=BaseRole(effective_role) if effective_role else None,
        is_creator=is_creator,
        sources=tuple(sources),
    )


def get_user_knowledge_base_permission(
    db: Session,
    knowledge_base_id: int,
    user_id: int,
    *,
    kb: Kind | None = None,
) -> KnowledgeBasePermission:
    """Load a knowledge base and resolve its raw ACL facts."""
    knowledge_base = kb or (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if knowledge_base is None:
        return KnowledgeBasePermission(False, None, False)
    return resolve_knowledge_base_permission(db, knowledge_base, user_id)


def meets_direct_access_requirement(
    *,
    kb: Kind,
    permission: KnowledgeBasePermission,
) -> bool:
    """Return whether raw ACL facts allow page discovery and direct opening."""
    spec = kb.json.get("spec", {}) if isinstance(kb.json, dict) else {}
    requirement = spec.get(
        "directAccessRequirement",
        DEFAULT_DIRECT_ACCESS_REQUIREMENT,
    )
    if requirement == "read":
        return permission.has_access
    if requirement == "edit":
        return can_manage_accessible_knowledge_base_documents(
            has_access=permission.has_access,
            role=permission.role,
            is_creator=permission.is_creator,
        )
    return False


def can_directly_access_knowledge_base(
    db: Session,
    knowledge_base_id: int,
    user_id: int,
    *,
    kb: Kind | None = None,
) -> bool:
    """Return whether a user may discover or directly open a knowledge base."""
    knowledge_base = kb or (
        db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if knowledge_base is None:
        return False
    permission = resolve_knowledge_base_permission(db, knowledge_base, user_id)
    return meets_direct_access_requirement(kb=knowledge_base, permission=permission)


def get_knowledge_base_tool_access_mode_by_ids(
    db: Session,
    user_id: int,
    knowledge_base_ids: list[int],
) -> tuple[str, str]:
    """Resolve agent-tool exposure after applying explicit ACL denials."""
    if not knowledge_base_ids:
        return KnowledgeBaseToolAccessMode.FULL, ""

    kbs = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .all()
    )
    if not kbs:
        return KnowledgeBaseToolAccessMode.FULL, ""

    explicit_restricted_member = (
        db.query(ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
            ResourceMember.resource_id.in_([kb.id for kb in kbs]),
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            ResourceMember.role == BaseRole.RestrictedAnalyst.value,
        )
        .first()
    )
    if explicit_restricted_member is not None:
        return (
            KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY,
            RESTRICTED_ANALYST_REASON,
        )

    group_names = [
        kb.namespace
        for kb in kbs
        if kb.namespace != "default" and not is_organization_namespace(db, kb.namespace)
    ]
    if get_restricted_analyst_groups(db, user_id, group_names):
        return (
            KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY,
            RESTRICTED_ANALYST_REASON,
        )
    return KnowledgeBaseToolAccessMode.FULL, ""


def _append_creator_source(
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user_id: int,
    user: User | None,
    include_sources: bool,
) -> None:
    if kb.user_id != user_id:
        return
    roles.append(BaseRole.Owner.value)
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


def _append_direct_member_source(
    db: Session,
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user_id: int,
    user: User | None,
    include_sources: bool,
) -> bool:
    member = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
            ResourceMember.resource_id == kb.id,
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        .first()
    )
    if member is None:
        return False
    role = member.get_effective_role()
    if role == BaseRole.RestrictedAnalyst.value:
        return True
    roles.append(role)
    if include_sources:
        sources.append(
            PermissionSourceInfo(
                source_type=_resolve_source_type(member),
                display_name=user.user_name if user else None,
                role=role,
                entity_type="user",
                entity_id=str(user_id),
            )
        )
    return False


def _append_organization_source(
    db: Session,
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user: User | None,
    include_sources: bool,
) -> None:
    if not is_organization_namespace(db, kb.namespace):
        return
    role = (
        BaseRole.Owner.value
        if user and user.role == "admin"
        else BaseRole.Reporter.value
    )
    roles.append(role)
    if include_sources:
        sources.append(
            PermissionSourceInfo(
                source_type="organization",
                display_name="Organization",
                role=role,
            )
        )


def _append_group_source(
    db: Session,
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user_id: int,
    include_sources: bool,
) -> bool:
    if kb.namespace == "default" or is_organization_namespace(db, kb.namespace):
        return False
    group_role = get_effective_role_in_group(db, user_id, kb.namespace)
    if group_role is None:
        return False
    if group_role == GroupRole.RestrictedAnalyst:
        return True

    role_mapping = {
        GroupRole.Owner: BaseRole.Owner.value,
        GroupRole.Maintainer: BaseRole.Maintainer.value,
        GroupRole.Developer: BaseRole.Developer.value,
        GroupRole.Reporter: BaseRole.Reporter.value,
    }
    role = role_mapping.get(group_role, BaseRole.Reporter.value)
    roles.append(role)
    if include_sources:
        group = db.query(Namespace).filter(Namespace.name == kb.namespace).first()
        sources.append(
            PermissionSourceInfo(
                source_type="group_membership",
                display_name=(
                    group.display_name or group.name if group else kb.namespace
                ),
                role=role,
            )
        )
    return False


def _append_entity_sources(
    db: Session,
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user_id: int,
    include_sources: bool,
) -> None:
    rows = (
        db.query(
            ResourceMember.entity_type,
            ResourceMember.entity_id,
            ResourceMember.role,
        )
        .filter(
            ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
            ResourceMember.resource_id == kb.id,
            ResourceMember.entity_type != "user",
            ResourceMember.entity_type != "",
            ResourceMember.entity_id.isnot(None),
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        .all()
    )
    entity_groups: dict[str, list[str]] = {}
    role_map: dict[str, str] = {}
    for entity_type, entity_id, role in rows:
        if entity_type and entity_id:
            entity_groups.setdefault(entity_type, []).append(entity_id)
            role_map[f"{entity_type}:{entity_id}"] = role

    for entity_type, entity_ids in entity_groups.items():
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        matched_ids = resolver.match_entity_bindings(
            db, user_id, entity_type, entity_ids
        )
        display_names = (
            resolver.batch_get_display_names(db, list(matched_ids))
            if include_sources and matched_ids
            else {}
        )
        for entity_id in matched_ids:
            role = role_map.get(f"{entity_type}:{entity_id}")
            if not role:
                continue
            roles.append(role)
            if include_sources:
                sources.append(
                    PermissionSourceInfo(
                        source_type="entity_permission",
                        display_name=display_names.get(entity_id),
                        role=role,
                        entity_type=entity_type,
                        entity_id=entity_id,
                    )
                )


def _append_group_chat_source(
    db: Session,
    roles: list[str],
    sources: list[PermissionSourceInfo],
    kb: Kind,
    user_id: int,
    include_sources: bool,
) -> None:
    if not _is_kb_bound_to_user_group_chat(db, kb.id, user_id):
        return
    roles.append(BaseRole.Reporter.value)
    if include_sources:
        sources.append(
            PermissionSourceInfo(
                source_type="group_chat_binding",
                display_name="Group Chat",
                role=BaseRole.Reporter.value,
            )
        )


def _is_kb_bound_to_user_group_chat(
    db: Session,
    kb_id: int,
    user_id: int,
) -> bool:
    tasks = task_store.list_accessible_active_tasks_for_user(db, user_id=user_id)
    for task in tasks:
        task_json = task.json if isinstance(task.json, dict) else {}
        refs = task_json.get("spec", {}).get("knowledgeBaseRefs", []) or []
        if any(ref.get("id") == kb_id for ref in refs):
            return True
    return False


def _resolve_source_type(member: ResourceMember) -> str:
    if member.entity_type and member.entity_type != "user":
        return "entity_permission"
    if (
        member.share_link_id
        and member.share_link_id > 0
        and member.invited_by_user_id == 0
    ):
        return "share_link"
    return "direct"

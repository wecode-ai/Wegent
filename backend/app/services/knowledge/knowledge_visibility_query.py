# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SQL projection of knowledge-base ACL and direct-access policies."""

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import (
    APPROVED_MEMBER_STATUS_VALUES,
    KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES,
    ResourceMember,
)
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.knowledge import ResourceScope
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.external_entity_resolver import (
    get_all_entity_types,
    get_entity_resolver,
)
from app.services.group_permission import (
    get_effective_role_in_group,
    get_effective_roles_in_groups,
    get_user_groups,
)
from app.services.knowledge.knowledge_access_policy import (
    get_task_bound_knowledge_base_ids,
)

if TYPE_CHECKING:
    from app.models.resource_member import ResourceMember as ResourceMemberModel


@dataclass(frozen=True)
class EntityAuthorizedKbsResult:
    """KBs and permission metadata matched through entity bindings."""

    entity_kbs: list[Kind]
    entity_personal_kb_ids: set[int]
    entity_shared_to_me_kbs: list[Kind]
    shared_into_group_kbs: list[Kind]
    member_group_map: dict[int, list[str]]
    member_role_map: dict[int, list[str]]
    member_inviter_map: dict[int, set[int]]
    member_type_map: dict[int, list[str]]
    member_entity_id_map: dict[int, list[str]]


@dataclass(frozen=True)
class DirectAccessPermissionContext:
    """Permission inputs reused within one knowledge-list request."""

    user: User
    accessible_groups: frozenset[str]
    organization_names: frozenset[str]
    group_roles: dict[str, GroupRole]
    accessible_namespace_ids: frozenset[str]
    external_member_role_map: dict[int, tuple[str, ...]]
    task_bound_kb_ids: frozenset[int]
    direct_members: tuple["ResourceMemberModel", ...] = ()
    entity_result: EntityAuthorizedKbsResult | None = None


def build_direct_access_query_context(
    db: Session,
    user_id: int,
    *,
    candidate_ids: list[int] | None = None,
) -> DirectAccessPermissionContext:
    """Load non-relational permission inputs for a direct-access query."""
    user = _get_user_or_raise(db, user_id)
    groups = get_user_groups(db, user_id)
    organization_names = _get_organization_names(db)
    group_roles = get_effective_roles_in_groups(
        db,
        user_id,
        [name for name in groups if name not in organization_names],
    )
    return DirectAccessPermissionContext(
        user=user,
        accessible_groups=frozenset(groups),
        organization_names=organization_names,
        group_roles=group_roles,
        accessible_namespace_ids=_get_accessible_namespace_ids(db, groups),
        external_member_role_map=collect_external_entity_member_roles(
            db,
            user_id,
            candidate_ids=candidate_ids,
        ),
        task_bound_kb_ids=get_task_bound_knowledge_base_ids(
            db,
            user_id,
            candidate_ids=candidate_ids,
        ),
    )


def build_direct_access_permission_context(
    db: Session,
    user_id: int,
    accessible_groups: list[str] | None = None,
    candidate_ids: list[int] | None = None,
) -> DirectAccessPermissionContext:
    """Load full permission metadata for grouped knowledge list responses."""
    user = _get_user_or_raise(db, user_id)
    groups = (
        accessible_groups
        if accessible_groups is not None
        else get_user_groups(db, user_id)
    )
    organization_names = _get_organization_names(db)
    group_roles = get_effective_roles_in_groups(
        db,
        user_id,
        [name for name in groups if name not in organization_names],
    )
    direct_member_query = db.query(ResourceMember).filter(
        ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
    )
    if candidate_ids is not None:
        direct_member_query = direct_member_query.filter(
            ResourceMember.resource_id.in_(candidate_ids)
        )
    entity_result = collect_entity_authorized_kbs(
        db,
        user_id,
        groups,
        candidate_ids=candidate_ids,
    )
    return DirectAccessPermissionContext(
        user=user,
        accessible_groups=frozenset(groups),
        organization_names=organization_names,
        group_roles=group_roles,
        accessible_namespace_ids=_get_accessible_namespace_ids(db, groups),
        external_member_role_map={
            kb_id: tuple(roles)
            for kb_id, roles in entity_result.member_role_map.items()
        },
        task_bound_kb_ids=get_task_bound_knowledge_base_ids(
            db,
            user_id,
            candidate_ids=candidate_ids,
        ),
        direct_members=tuple(direct_member_query.all()),
        entity_result=entity_result,
    )


def filter_directly_accessible_knowledge_bases(
    db: Session,
    knowledge_bases: list[Kind],
    user_id: int,
    permission_context: DirectAccessPermissionContext | None = None,
) -> list[Kind]:
    """Filter a bounded candidate set without per-KB permission queries."""
    if not knowledge_bases:
        return []
    candidate_ids = [kb.id for kb in knowledge_bases]
    context = permission_context or build_direct_access_query_context(
        db,
        user_id,
        candidate_ids=candidate_ids,
    )
    allowed_ids = {
        row[0]
        for row in apply_direct_access_filter(
            db,
            db.query(Kind.id).filter(Kind.id.in_(candidate_ids)),
            user_id,
            context,
        ).all()
    }
    return [kb for kb in knowledge_bases if kb.id in allowed_ids]


def collect_external_entity_member_roles(
    db: Session,
    user_id: int,
    *,
    candidate_ids: list[int] | None = None,
) -> dict[int, tuple[str, ...]]:
    """Collect roles from extension-defined entity resolvers only."""
    candidate_id_set = set(candidate_ids) if candidate_ids is not None else None
    role_map: dict[int, list[str]] = {}
    for entity_type in get_all_entity_types():
        if entity_type in {"namespace", "user"}:
            continue
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        resource_ids = resolver.get_resource_ids_by_entity(db, user_id, entity_type)
        if candidate_id_set is not None:
            resource_ids = [
                resource_id
                for resource_id in resource_ids
                if resource_id in candidate_id_set
            ]
        if not resource_ids:
            continue
        rows = (
            db.query(
                ResourceMember.resource_id,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.resource_id.in_(resource_ids),
                ResourceMember.entity_type == entity_type,
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            )
            .all()
        )
        matched_ids = set(
            resolver.match_entity_bindings(
                db,
                user_id,
                entity_type,
                [row.entity_id for row in rows if row.entity_id],
            )
        )
        for resource_id, entity_id, role in rows:
            if entity_id in matched_ids:
                role_map.setdefault(resource_id, []).append(
                    role or BaseRole.Reporter.value
                )
    return {kb_id: tuple(roles) for kb_id, roles in role_map.items()}


def collect_entity_authorized_kbs(
    db: Session,
    user_id: int,
    accessible_groups: list[str],
    candidate_ids: list[int] | None = None,
) -> EntityAuthorizedKbsResult:
    """Collect KBs accessible via namespace and extension entity bindings."""
    kb_ids: set[int] = set()
    group_map: dict[int, list[str]] = {}
    role_map: dict[int, list[str]] = {}
    inviter_map: dict[int, set[int]] = {}
    type_map: dict[int, list[str]] = {}
    entity_id_map: dict[int, list[str]] = {}
    candidate_id_set = set(candidate_ids) if candidate_ids is not None else None

    if accessible_groups:
        namespaces = (
            db.query(Namespace)
            .filter(
                Namespace.name.in_(accessible_groups),
                Namespace.is_active.is_(True),
            )
            .all()
        )
        namespace_names = {namespace.id: namespace.name for namespace in namespaces}
        if namespace_names:
            query = db.query(ResourceMember).filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_(
                    [str(namespace_id) for namespace_id in namespace_names]
                ),
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            )
            if candidate_ids is not None:
                query = query.filter(ResourceMember.resource_id.in_(candidate_ids))
            for member in query.all():
                _append_entity_member_metadata(
                    member,
                    "namespace",
                    namespace_names.get(int(member.entity_id or 0)),
                    kb_ids,
                    group_map,
                    role_map,
                    inviter_map,
                    type_map,
                    entity_id_map,
                )

    for entity_type in get_all_entity_types():
        if entity_type in {"namespace", "user"}:
            continue
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        resolved_ids = resolver.get_resource_ids_by_entity(db, user_id, entity_type)
        if candidate_id_set is not None:
            resolved_ids = [
                kb_id for kb_id in resolved_ids if kb_id in candidate_id_set
            ]
        if not resolved_ids:
            continue
        members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.entity_type == entity_type,
                ResourceMember.resource_id.in_(resolved_ids),
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            )
            .all()
        )
        matched_ids = set(
            resolver.match_entity_bindings(
                db,
                user_id,
                entity_type,
                [member.entity_id for member in members if member.entity_id],
            )
        )
        for member in members:
            if member.entity_id not in matched_ids:
                continue
            _append_entity_member_metadata(
                member,
                entity_type,
                None,
                kb_ids,
                group_map,
                role_map,
                inviter_map,
                type_map,
                entity_id_map,
            )

    entity_kbs = (
        db.query(Kind)
        .filter(
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
            Kind.id.in_(kb_ids),
        )
        .all()
        if kb_ids
        else []
    )
    personal_ids = {kb.id for kb in entity_kbs if kb.namespace == "default"}
    shared_into_group = [
        kb
        for kb in entity_kbs
        if any(group in accessible_groups for group in group_map.get(kb.id, []))
    ]
    shared_into_group_ids = {kb.id for kb in shared_into_group}
    shared_to_me = [
        kb
        for kb in entity_kbs
        if kb.user_id != user_id and kb.id not in shared_into_group_ids
    ]
    return EntityAuthorizedKbsResult(
        entity_kbs=entity_kbs,
        entity_personal_kb_ids=personal_ids,
        entity_shared_to_me_kbs=shared_to_me,
        shared_into_group_kbs=shared_into_group,
        member_group_map=group_map,
        member_role_map=role_map,
        member_inviter_map=inviter_map,
        member_type_map=type_map,
        member_entity_id_map=entity_id_map,
    )


def _append_entity_member_metadata(
    member: ResourceMember,
    entity_type: str,
    group_name: str | None,
    kb_ids: set[int],
    group_map: dict[int, list[str]],
    role_map: dict[int, list[str]],
    inviter_map: dict[int, set[int]],
    type_map: dict[int, list[str]],
    entity_id_map: dict[int, list[str]],
) -> None:
    kb_id = member.resource_id
    kb_ids.add(kb_id)
    if group_name is not None:
        group_map.setdefault(kb_id, []).append(group_name)
    role_map.setdefault(kb_id, []).append(member.get_effective_role())
    type_map.setdefault(kb_id, []).append(entity_type)
    entity_id_map.setdefault(kb_id, []).append(member.entity_id)
    if member.invited_by_user_id:
        inviter_map.setdefault(kb_id, set()).add(member.invited_by_user_id)


def apply_direct_access_filter(
    db: Session,
    query,
    user_id: int,
    context: DirectAccessPermissionContext,
):
    """Apply the direct-access policy as SQL predicates."""
    _validate_context_user(context, user_id)
    editable_roles = (
        BaseRole.Owner.value,
        BaseRole.Maintainer.value,
        BaseRole.Developer.value,
    )
    member_query = _approved_member_query(db)
    direct_editable = member_query.filter(
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(user_id),
        ResourceMember.role.in_(editable_roles),
    ).exists()

    edit_conditions = [Kind.user_id == user_id, direct_editable]
    if context.accessible_namespace_ids:
        edit_conditions.append(
            member_query.filter(
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_(context.accessible_namespace_ids),
                ResourceMember.role.in_(editable_roles),
            ).exists()
        )
    external_editable_ids = {
        kb_id
        for kb_id, roles in context.external_member_role_map.items()
        if any(has_permission(role, BaseRole.Developer) for role in roles)
    }
    if external_editable_ids:
        edit_conditions.append(Kind.id.in_(external_editable_ids))

    editable_group_names = [
        group_name
        for group_name, role in context.group_roles.items()
        if has_permission(role, BaseRole.Developer)
    ]
    if editable_group_names:
        edit_conditions.append(Kind.namespace.in_(editable_group_names))
    if context.user.role == "admin" and context.organization_names:
        edit_conditions.append(Kind.namespace.in_(context.organization_names))

    requirement = knowledge_base_json_text(db, "$.spec.directAccessRequirement")
    query = query.filter(
        or_(
            requirement == "",
            requirement == "read",
            and_(requirement == "edit", or_(*edit_conditions)),
        )
    )
    return apply_acl_deny_filter(db, query, user_id, context)


def apply_acl_deny_filter(
    db: Session,
    query,
    user_id: int,
    context: DirectAccessPermissionContext,
):
    """Apply explicit ACL denials shared by direct and agent access."""
    _validate_context_user(context, user_id)
    direct_restricted = (
        _approved_member_query(db)
        .filter(
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
            ResourceMember.role == BaseRole.RestrictedAnalyst.value,
        )
        .exists()
    )
    query = query.filter(~direct_restricted)

    restricted_group_names = [
        group_name
        for group_name, role in context.group_roles.items()
        if role == GroupRole.RestrictedAnalyst
    ]
    if restricted_group_names:
        query = query.filter(Kind.namespace.notin_(restricted_group_names))
    return query


def get_directly_accessible_knowledge_base_ids(
    db: Session,
    *,
    user_id: int,
    candidate_ids: list[int],
) -> set[int]:
    """Resolve direct access for a bounded set of knowledge base IDs."""
    candidate_ids = list(dict.fromkeys(candidate_ids))
    if not candidate_ids:
        return set()
    context = build_direct_access_query_context(
        db,
        user_id,
        candidate_ids=candidate_ids,
    )
    query = build_knowledge_base_visibility_query(
        db,
        user_id=user_id,
        scope=ResourceScope.ALL,
        permission_context=context,
    ).filter(Kind.id.in_(candidate_ids))
    query = apply_direct_access_filter(
        db,
        query.with_entities(Kind.id),
        user_id,
        context,
    )
    return {row[0] for row in query.all()}


def get_acl_accessible_knowledge_base_ids(
    db: Session,
    *,
    user_id: int,
    candidate_ids: list[int],
) -> set[int]:
    """Resolve raw ACL access without applying direct visibility policy."""
    candidate_ids = list(dict.fromkeys(candidate_ids))
    if not candidate_ids:
        return set()

    if user_id == 0:
        query = (
            db.query(Kind.id)
            .join(Namespace, Kind.namespace == Namespace.name)
            .filter(
                Kind.id.in_(candidate_ids),
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
                Namespace.level == GroupLevel.organization.value,
                Namespace.is_active.is_(True),
            )
        )
    else:
        context = build_direct_access_query_context(
            db,
            user_id,
            candidate_ids=candidate_ids,
        )
        query = build_knowledge_base_visibility_query(
            db,
            user_id=user_id,
            scope=ResourceScope.ALL,
            permission_context=context,
        ).filter(Kind.id.in_(candidate_ids))
        query = apply_acl_deny_filter(
            db,
            query.with_entities(Kind.id),
            user_id,
            context,
        )
    return {row[0] for row in query.all()}


def build_knowledge_base_visibility_query(
    db: Session,
    *,
    user_id: int,
    scope: ResourceScope,
    permission_context: DirectAccessPermissionContext,
    group_name: str | None = None,
):
    """Build the base SQL query for knowledge bases visible to a user."""
    _validate_context_user(permission_context, user_id)
    base_query = db.query(Kind).filter(
        Kind.kind == "KnowledgeBase",
        Kind.is_active.is_(True),
    )
    if scope == ResourceScope.PERSONAL:
        return _build_personal_query(
            db,
            base_query,
            user_id,
            permission_context,
        )
    if scope == ResourceScope.GROUP:
        if not group_name:
            raise ValueError("group_name is required when scope is GROUP")
        if get_effective_role_in_group(db, user_id, group_name) is None:
            return None
        return base_query.filter(Kind.namespace == group_name)
    if scope == ResourceScope.ORGANIZATION:
        return base_query.join(Namespace, Kind.namespace == Namespace.name).filter(
            Namespace.level == GroupLevel.organization.value,
            Namespace.is_active.is_(True),
        )
    return _build_all_query(db, base_query, user_id, permission_context)


def knowledge_base_json_text(db: Session, path: str):
    """Return a dialect-neutral text expression for a KB JSON value."""
    if db.get_bind().dialect.name == "mysql":
        value = func.json_unquote(func.json_extract(Kind.json, path))
    else:
        value = func.json_extract(Kind.json, path)
    return func.coalesce(value, "")


def _build_personal_query(
    db: Session,
    base_query,
    user_id: int,
    context: DirectAccessPermissionContext,
):
    conditions = [(Kind.user_id == user_id) & (Kind.namespace == "default")]
    shared_access = _shared_access_condition(db, context)
    if shared_access is not None:
        conditions.append(shared_access)
    task_bound_access = _task_bound_access_condition(context)
    if task_bound_access is not None:
        conditions.append(task_bound_access)
    return base_query.filter(or_(*conditions))


def _build_all_query(
    db: Session,
    base_query,
    user_id: int,
    context: DirectAccessPermissionContext,
):
    conditions = [(Kind.user_id == user_id) & (Kind.namespace == "default")]
    if context.accessible_groups:
        conditions.append(Kind.namespace.in_(context.accessible_groups))
    if context.organization_names:
        conditions.append(Kind.namespace.in_(context.organization_names))
    shared_access = _shared_access_condition(db, context)
    if shared_access is not None:
        conditions.append(shared_access)
    task_bound_access = _task_bound_access_condition(context)
    if task_bound_access is not None:
        conditions.append(task_bound_access)
    return base_query.filter(or_(*conditions))


def _task_bound_access_condition(context: DirectAccessPermissionContext):
    if not context.task_bound_kb_ids:
        return None
    return and_(
        Kind.namespace == "default",
        Kind.id.in_(context.task_bound_kb_ids),
    )


def _shared_access_condition(
    db: Session,
    context: DirectAccessPermissionContext,
):
    member_query = _approved_member_query(db)
    conditions = [
        member_query.filter(
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(context.user.id),
        ).exists()
    ]
    if context.accessible_namespace_ids:
        conditions.append(
            member_query.filter(
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_(context.accessible_namespace_ids),
            ).exists()
        )
    if context.external_member_role_map:
        conditions.append(Kind.id.in_(tuple(context.external_member_role_map)))
    return or_(*conditions)


def _approved_member_query(db: Session):
    return db.query(ResourceMember.id).filter(
        ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
        ResourceMember.resource_id == Kind.id,
        ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
    )


def _get_user_or_raise(db: Session, user_id: int) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise ValueError("User not found")
    return user


def _get_organization_names(db: Session) -> frozenset[str]:
    return frozenset(
        row[0]
        for row in db.query(Namespace.name)
        .filter(
            Namespace.level == GroupLevel.organization.value,
            Namespace.is_active.is_(True),
        )
        .all()
    )


def _get_accessible_namespace_ids(
    db: Session,
    groups: list[str],
) -> frozenset[str]:
    return frozenset(
        str(row[0])
        for row in db.query(Namespace.id)
        .filter(
            Namespace.name.in_(groups),
            Namespace.is_active.is_(True),
        )
        .all()
    )


def _validate_context_user(
    context: DirectAccessPermissionContext,
    user_id: int,
) -> None:
    if context.user.id != user_id:
        raise ValueError("Permission context user does not match request user")

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SQL projection of knowledge-base ACL and direct-access policies."""

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, cast

from sqlalchemy import String, func, or_
from sqlalchemy.orm import Query, Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import (
    APPROVED_MEMBER_STATUS_VALUES,
    KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES,
    ResourceMember,
)
from app.models.user import User
from app.schemas.base_role import get_highest_role
from app.schemas.knowledge import ResourceScope
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.external_entity_resolver import (
    EntityMembershipUnavailable,
    get_all_entity_types,
    get_entity_resolver,
)
from app.services.group_permission import (
    get_effective_roles_in_groups,
)

if TYPE_CHECKING:
    from app.models.resource_member import ResourceMember as ResourceMemberModel
    from app.services.knowledge.permission_context import KnowledgePermissionContext


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
    group_roles: dict[str, GroupRole]
    listed_group_roles: dict[str, GroupRole | None]
    direct_members: tuple["ResourceMemberModel", ...] = ()
    entity_result: EntityAuthorizedKbsResult | None = None
    allowed_ids: frozenset[int] | None = None


def _potential_discovery_shares(
    db: Session,
    user_id: int,
    namespace_ids: frozenset[str],
    candidate_ids: list[int] | Query | None = None,
):
    """Use scalar binding identities to narrow candidates before loading libraries."""
    from app.services.external_entity_resolver import EntityMembershipUnavailable

    members = _approved_member_query(db)
    conditions = [
        members.filter(
            ResourceMember.entity_type == "user",
            ResourceMember.entity_id == str(user_id),
        ).exists()
    ]
    if namespace_ids:
        conditions.append(
            members.filter(
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_(namespace_ids),
            ).exists()
        )
    for entity_type in get_all_entity_types():
        if entity_type in {"user", "namespace"}:
            continue
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        identities_query = db.query(ResourceMember.entity_id).filter(
            ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
            ResourceMember.entity_type == entity_type,
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        if candidate_ids is not None:
            identities_query = identities_query.filter(
                ResourceMember.resource_id.in_(candidate_ids)
            )
        identities = [row[0] for row in identities_query.distinct().all()]
        if not identities:
            continue
        try:
            possible = resolver.match_entity_bindings(
                db, user_id, entity_type, identities
            )
        except EntityMembershipUnavailable as failure:
            possible = list(set(failure.matched_ids) | set(failure.unknown_ids))
        if possible:
            conditions.append(
                members.filter(
                    ResourceMember.entity_type == entity_type,
                    ResourceMember.entity_id.in_(possible),
                ).exists()
            )
    return or_(*conditions)


def _personal_discovery_decision(
    db: Session,
    kb: Kind,
    user_id: int,
    facts: "KnowledgePermissionContext",
    memberships: list[tuple[str, str, str | None, str | None]],
    allow_empty_requirement: bool = False,
) -> bool:
    """Evaluate personal scope and opening together under the same possible facts."""
    from app.services.external_entity_resolver import EntityMembershipUnavailable
    from app.services.knowledge.knowledge_access_policy import (
        resolve_direct_access_decision,
    )
    from app.services.knowledge.permission_context import permission_scenarios

    decisions = set()
    for scenario in permission_scenarios(db, kb, facts, memberships=memberships):
        shared = any(
            (m.entity_type == "user" and m.entity_id == str(user_id))
            or (
                m.entity_type != "user"
                and m.entity_id in scenario.matched_entities.get(m.entity_type, set())
            )
            for m in facts.members.get(kb.id, [])
        )
        in_scope = (kb.user_id == user_id and kb.namespace == "default") or shared
        decisions.add(
            in_scope
            and resolve_direct_access_decision(
                db,
                kb,
                user_id,
                context=scenario,
                allow_empty_requirement=allow_empty_requirement,
            )
        )
    if len(decisions) != 1:
        raise EntityMembershipUnavailable([], [])
    return decisions.pop()


def build_knowledge_discovery_query(
    db: Session,
    user_id: int,
    candidate_ids: list[int] | Query | None = None,
    *,
    scope: ResourceScope = ResourceScope.ALL,
    exclude_organizations: bool = False,
    group_name: str | None = None,
    raw_acl: bool = False,
    allow_empty_requirement: bool = False,
    include_inherited_groups: bool = True,
    unavailable: dict[int, EntityMembershipUnavailable] | None = None,
) -> tuple[Query, "KnowledgePermissionContext"]:
    """Filter relevant SQL candidates before batched opening and scope decisions."""
    from app.services.external_entity_resolver import entity_resolution_scope
    from app.services.group_member_helper import iter_user_groups_with_roles
    from app.services.knowledge.knowledge_access_policy import (
        resolve_acl_access_decision,
        resolve_direct_access_decision,
    )
    from app.services.knowledge.permission_context import (
        build_knowledge_permission_context,
    )

    if scope == ResourceScope.GROUP and not group_name:
        raise ValueError("group_name is required when scope is GROUP")
    organizations = _get_organization_names(db)
    query = db.query(Kind).filter(
        Kind.kind == "KnowledgeBase",
        Kind.is_active.is_(True),
    )
    if exclude_organizations:
        query = query.filter(~Kind.namespace.in_(organizations))
    if candidate_ids is not None:
        query = query.filter(Kind.id.in_(candidate_ids))
    membership_names = None
    if candidate_ids is not None:
        relevant = {name for (name,) in query.with_entities(Kind.namespace).all()}
        relevant.update(
            name
            for (name,) in db.query(Namespace.name)
            .join(
                ResourceMember,
                ResourceMember.entity_id == func.cast(Namespace.id, String),
            )
            .filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.resource_id.in_(candidate_ids),
                ResourceMember.entity_type == "namespace",
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
                Namespace.is_active.is_(True),
            )
            .all()
        )
        membership_names = sorted(
            {
                "/".join(name.split("/")[:depth])
                for name in relevant
                if name != "default"
                for depth in range(1, name.count("/") + 2)
            }
        )
    with entity_resolution_scope(db):
        unknown: list[tuple[str, str, str, str, EntityMembershipUnavailable]] = []
        memberships = iter_user_groups_with_roles(
            db,
            user_id,
            deduplicate=False,
            group_names=membership_names,
            unavailable_memberships=unknown,
        )
        roots = {row[0] for row in memberships} | {row[0] for row in unknown}
        group_filter = or_(
            False,
            *[
                or_(
                    Namespace.name == name,
                    (
                        Namespace.name.startswith(name + "/", autoescape=True)
                        if include_inherited_groups
                        else False
                    ),
                )
                for name in roots
            ],
        )
        group_names = (
            {
                row[0]
                for row in db.query(Namespace.name)
                .filter(Namespace.is_active.is_(True), group_filter)
                .all()
            }
            if roots
            else set()
        )
        namespace_ids = _get_accessible_namespace_ids(db, list(group_names))
        conditions = [
            (Kind.user_id == user_id) & (Kind.namespace == "default"),
            _potential_discovery_shares(db, user_id, namespace_ids, candidate_ids),
        ]
        if scope == ResourceScope.ALL:
            if group_names:
                conditions.append(Kind.namespace.in_(group_names))
            if not exclude_organizations and organizations:
                conditions.append(Kind.namespace.in_(organizations))
        if scope == ResourceScope.GROUP:
            query = query.filter(Kind.namespace == group_name)
        elif scope == ResourceScope.ORGANIZATION:
            query = query.filter(Kind.namespace.in_(organizations))
        else:
            query = query.filter(or_(*conditions))
        libraries = query.all()
        facts = build_knowledge_permission_context(
            db, libraries, user_id, organizations
        )
        facts = replace(facts, memberships=tuple(memberships))
        allowed = []
        for kb in libraries:
            try:
                if scope == ResourceScope.GROUP:
                    from app.services.knowledge.permission_context import (
                        permission_scenarios,
                    )

                    outcomes = {
                        bool(scenario.scope_group_roles.get(kb.namespace))
                        and resolve_direct_access_decision(
                            db,
                            kb,
                            user_id,
                            context=scenario,
                            allow_empty_requirement=allow_empty_requirement,
                        )
                        for scenario in permission_scenarios(
                            db, kb, facts, memberships=memberships
                        )
                    }
                    if len(outcomes) != 1:
                        raise EntityMembershipUnavailable([], [])
                    visible = outcomes.pop()
                elif raw_acl:
                    visible = resolve_acl_access_decision(
                        db, kb, user_id, context=facts
                    )
                elif scope == ResourceScope.PERSONAL:
                    visible = _personal_discovery_decision(
                        db, kb, user_id, facts, memberships, allow_empty_requirement
                    )
                else:
                    visible = resolve_direct_access_decision(
                        db,
                        kb,
                        user_id,
                        context=facts,
                        allow_empty_requirement=allow_empty_requirement,
                    )
            except EntityMembershipUnavailable as failure:
                if unavailable is None:
                    raise
                unavailable[cast(int, kb.id)] = failure
                continue
            if visible:
                allowed.append(kb.id)
    return query.filter(Kind.id.in_(allowed)), facts


def build_direct_access_permission_context(
    db: Session,
    user_id: int,
    candidate_ids: list[int] | None = None,
    *,
    include_inherited_groups: bool = True,
) -> DirectAccessPermissionContext:
    """Load full permission metadata for grouped knowledge list responses."""
    query, facts = build_knowledge_discovery_query(
        db,
        user_id,
        candidate_ids,
        allow_empty_requirement=True,
        include_inherited_groups=include_inherited_groups,
    )
    libraries = query.all()
    allowed_ids = frozenset(kb.id for kb in libraries)
    names = [
        row[0]
        for row in db.query(Namespace.name).filter(Namespace.is_active.is_(True)).all()
    ]
    roles = get_effective_roles_in_groups(
        db, user_id, names, memberships=list(facts.memberships)
    )
    listed_roles: dict[str, GroupRole | None] = {}
    for name, role, _, _ in facts.memberships:
        known_role = listed_roles.get(name)
        listed_roles[name] = GroupRole(
            get_highest_role([known_role, role]) if known_role is not None else role
        )
    # Retaining a creator's native group does not establish a group role.
    creator_groups: set[str] = set()
    for kb in libraries:
        if kb.user_id == user_id and kb.namespace in facts.group_failures:
            creator_groups.add(kb.namespace)
            listed_roles.setdefault(kb.namespace, None)
    groups = sorted(set(roles) | creator_groups)
    direct_members = tuple(
        member
        for kb_id, members in facts.members.items()
        if kb_id in allowed_ids
        for member in members
        if member.entity_type == "user" and member.entity_id == str(user_id)
    )
    entity_result = collect_entity_authorized_kbs(
        db, user_id, groups, list(allowed_ids), facts=facts
    )
    return DirectAccessPermissionContext(
        user=_get_user_or_raise(db, user_id),
        accessible_groups=frozenset(groups),
        group_roles=roles,
        listed_group_roles=listed_roles,
        direct_members=direct_members,
        entity_result=entity_result,
        allowed_ids=allowed_ids,
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
    if permission_context is not None and permission_context.allowed_ids is not None:
        _validate_context_user(permission_context, user_id)
        return [kb for kb in knowledge_bases if kb.id in permission_context.allowed_ids]
    from app.services.external_entity_resolver import entity_resolution_scope
    from app.services.knowledge.knowledge_access_policy import (
        resolve_direct_access_decision,
    )
    from app.services.knowledge.permission_context import (
        build_knowledge_permission_context,
    )

    with entity_resolution_scope(db):
        facts = build_knowledge_permission_context(
            db, knowledge_bases, user_id, _get_organization_names(db)
        )
        return [
            kb
            for kb in knowledge_bases
            if resolve_direct_access_decision(
                db, kb, user_id, context=facts, allow_empty_requirement=True
            )
        ]


def collect_entity_authorized_kbs(
    db: Session,
    user_id: int,
    accessible_groups: list[str],
    candidate_ids: list[int] | None = None,
    *,
    facts: "KnowledgePermissionContext",
) -> EntityAuthorizedKbsResult:
    """Collect KBs accessible via namespace and extension entity bindings."""
    kb_ids: set[int] = set()
    group_map: dict[int, list[str]] = {}
    role_map: dict[int, list[str]] = {}
    inviter_map: dict[int, set[int]] = {}
    type_map: dict[int, list[str]] = {}
    entity_id_map: dict[int, list[str]] = {}
    namespace_names = {
        str(row.id): row.name
        for row in db.query(Namespace)
        .filter(Namespace.name.in_(accessible_groups), Namespace.is_active.is_(True))
        .all()
    }
    for kb_id in candidate_ids or []:
        for member in facts.members.get(kb_id, []):
            entity_type = member.entity_type
            if entity_type in {"user", "", None}:
                continue
            if member.entity_id not in facts.matched_entities.get(entity_type, set()):
                continue
            _append_entity_member_metadata(
                member,
                entity_type,
                (
                    namespace_names.get(member.entity_id)
                    if entity_type == "namespace"
                    else None
                ),
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
    query, _ = build_knowledge_discovery_query(
        db, user_id, candidate_ids, allow_empty_requirement=True
    )
    return {row[0] for row in query.with_entities(Kind.id).all()}


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
        query, _ = build_knowledge_discovery_query(
            db, user_id, candidate_ids, raw_acl=True
        )
        query = query.with_entities(Kind.id)
    return {row[0] for row in query.all()}


def knowledge_base_json_text(db: Session, path: str):
    """Return a dialect-neutral text expression for a KB JSON value."""
    if db.get_bind().dialect.name == "mysql":
        value = func.json_unquote(func.json_extract(Kind.json, path))
    else:
        value = func.json_extract(Kind.json, path)
    return func.coalesce(value, "")


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

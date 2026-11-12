# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base ACL resolution and action-specific access policies."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

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
from app.services.external_entity_resolver import (
    EntityFact,
    EntityMembershipUnavailable,
    entity_resolution_scope,
    get_entity_resolver,
)
from app.services.group_permission import (
    get_effective_role_in_group,
    get_restricted_analyst_groups,
    is_restricted_analyst,
)
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.knowledge.permission_context import (
    KnowledgePermissionContext,
    permission_scenarios,
)
from app.services.knowledge.permission_policy import (
    can_manage_accessible_knowledge_base_documents,
)
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


class KnowledgePermissionUnavailable(EntityMembershipUnavailable):
    """Expose ACL bounds so an action can decide whether missing facts matter."""

    def __init__(
        self,
        failure: EntityMembershipUnavailable,
        possibilities: list[KnowledgeBasePermission],
    ):
        super().__init__(failure.unknown_ids, failure.matched_ids)
        self.possibilities = possibilities


def resolve_knowledge_base_permission(
    db: Session,
    kb: Kind,
    user_id: int,
    *,
    include_sources: bool = False,
    context: KnowledgePermissionContext | None = None,
) -> KnowledgeBasePermission:
    """Return a precise merged role when unrelated lower facts cannot change it."""
    with entity_resolution_scope(db):
        try:
            return _resolve_knowledge_base_permission(
                db, kb, user_id, include_sources=include_sources, context=context
            )
        except KnowledgePermissionUnavailable:
            raise
        except EntityMembershipUnavailable:
            if include_sources or context is not None:
                raise
            from app.services.knowledge.permission_context import (
                build_knowledge_permission_context,
            )

            organizations = (
                frozenset({cast(str, kb.namespace)})
                if is_organization_namespace(db, cast(str, kb.namespace))
                else frozenset()
            )
            facts = build_knowledge_permission_context(db, [kb], user_id, organizations)
            return _resolve_knowledge_base_permission(db, kb, user_id, context=facts)


def _resolve_knowledge_base_permission(
    db: Session,
    kb: Kind,
    user_id: int,
    *,
    include_sources: bool = False,
    context: KnowledgePermissionContext | None = None,
) -> KnowledgeBasePermission:
    """Resolve all ACL sources and explicit denials for one knowledge base."""
    if context is not None and (context.user_id != user_id or include_sources):
        raise ValueError("Permission context requires the same user and no sources")
    sources: list[PermissionSourceInfo] = []
    roles: list[str] = []
    user = (
        context.user if context else db.query(User).filter(User.id == user_id).first()
    )
    is_creator = cast(int, kb.user_id) == user_id

    _append_creator_source(roles, sources, kb, user_id, user, include_sources)

    if (
        not is_creator
        and not (context and cast(str, kb.namespace) in context.group_failures)
        and cast(str, kb.namespace) != "default"
        and not (
            cast(str, kb.namespace) in context.organization_names
            if context
            else is_organization_namespace(db, cast(str, kb.namespace))
        )
        and (
            cast(str, kb.namespace) in context.restricted_groups
            if context
            else is_restricted_analyst(db, user_id, cast(str, kb.namespace))
        )
    ):
        return KnowledgeBasePermission(
            False,
            None,
            is_creator,
            tuple(sources),
            is_denied=True,
        )

    if _append_direct_member_source(
        db, roles, sources, kb, user_id, user, include_sources, context
    ):
        return KnowledgeBasePermission(
            False,
            None,
            is_creator,
            tuple(sources),
            is_denied=True,
        )

    if context and cast(str, kb.namespace) in context.group_failures:
        return _resolve_uncertain_group_permission(db, kb, user_id, context)

    _append_organization_source(db, roles, sources, kb, user, include_sources, context)
    if _append_group_source(db, roles, sources, kb, user_id, include_sources, context):
        return KnowledgeBasePermission(False, None, is_creator, tuple(sources))
    _append_entity_sources(db, roles, sources, kb, user_id, include_sources, context)

    effective_role = get_highest_role(roles) if roles else None
    return KnowledgeBasePermission(
        has_access=bool(roles) or is_creator,
        role=BaseRole(effective_role) if effective_role else None,
        is_creator=is_creator,
        sources=tuple(sources),
    )


def _resolve_uncertain_group_permission(
    db: Session, kb: Kind, user_id: int, context: KnowledgePermissionContext
) -> KnowledgeBasePermission:
    failure = context.group_failures[cast(str, kb.namespace)][0]
    possibilities = [
        resolve_knowledge_base_permission(db, kb, user_id, context=candidate)
        for candidate in permission_scenarios(db, kb, context)
    ]
    if all(permission == possibilities[0] for permission in possibilities):
        return possibilities[0]
    raise KnowledgePermissionUnavailable(failure, possibilities)


def _permission_for_roles(
    roles: list[str], is_creator: bool
) -> KnowledgeBasePermission:
    highest = get_highest_role(roles)
    return KnowledgeBasePermission(
        bool(roles) or is_creator, BaseRole(highest) if highest else None, is_creator
    )


_DEFAULT_KB_ACCESS_ERROR = "Default knowledge bases are not directly accessible"
_DEFAULT_KB_SCOPE_ERROR = "Group bots can only bind knowledge bases from the current group or the organization"


def _binding_outcomes(
    db: Session,
    libraries: list[Kind],
    user_id: int,
    namespace: str,
    target_id: int | None,
    scenario: KnowledgePermissionContext,
) -> tuple[bool, bool]:
    group_member = any(row[0] == namespace for row in scenario.memberships)
    accessible = all(
        resolve_direct_access_decision(db, kb, user_id, context=scenario)
        for kb in libraries
    )
    placed = namespace == "default" or all(
        (
            kb.namespace in scenario.organization_names
            or (
                group_member
                and (
                    kb.namespace == namespace
                    or any(
                        member.entity_type == "namespace"
                        and member.entity_id == str(target_id)
                        for member in scenario.members.get(cast(int, kb.id), [])
                    )
                )
            )
        )
        and resolve_direct_access_decision(
            db, kb, user_id, context=scenario, allow_empty_requirement=True
        )
        for kb in libraries
    )
    return accessible, placed


def _binding_fact_components(
    libraries: list[Kind], context: KnowledgePermissionContext, namespace: str
) -> list[list[Kind]]:
    """Keep independent pending library bindings out of the same state product."""
    components: list[tuple[list[Kind], set[EntityFact]]] = []
    has_group = any(row[0] == namespace for row in context.memberships)
    for kb in libraries:
        facts: set[EntityFact] = set()
        names = {cast(str, kb.namespace)} | ({namespace} if not has_group else set())
        for name in names:
            failure = context.group_failures.get(name)
            for _, _, kind, eid in failure[2] if failure else []:
                facts.update(
                    context.entity_dependencies.get(
                        (kind, eid), frozenset({(kind, eid)})
                    )
                )
        for member in context.members.get(cast(int, kb.id), []):
            kind, eid = cast(str, member.entity_type), cast(str, member.entity_id)
            entity_failure = context.entity_failures.get(kind)
            if entity_failure and eid in entity_failure.unknown_ids:
                facts.update(
                    context.entity_dependencies.get(
                        (kind, eid), frozenset({(kind, eid)})
                    )
                )
        group = [kb]
        remaining = []
        for related, dependencies in components:
            if facts & dependencies:
                group.extend(related)
                facts.update(dependencies)
            else:
                remaining.append((related, dependencies))
        # Merging can connect an earlier component through a later dependency.
        while any(facts & dependencies for _, dependencies in remaining):
            independent = []
            for related, dependencies in remaining:
                if facts & dependencies:
                    group.extend(related)
                    facts.update(dependencies)
                else:
                    independent.append((related, dependencies))
            remaining = independent
        components = [*remaining, (group, facts)]
    return [libraries for libraries, _ in components]


def default_knowledge_base_binding_error(
    db: Session, kb_ids: list[int], user_id: int, namespace: str
) -> str | None:
    """Resolve the complete binding action, retaining original known denial messages."""
    from app.services.knowledge.knowledge_visibility_query import (
        _get_organization_names,
    )
    from app.services.knowledge.permission_context import (
        build_knowledge_permission_context,
        permission_scenarios,
    )

    with entity_resolution_scope(db):
        libraries = (
            db.query(Kind)
            .filter(
                Kind.id.in_(kb_ids),
                Kind.kind == "KnowledgeBase",
                Kind.is_active.is_(True),
            )
            .all()
        )
        if len(libraries) != len(set(kb_ids)):
            return _DEFAULT_KB_ACCESS_ERROR
        group_names = (namespace,) if namespace != "default" else ()
        context = build_knowledge_permission_context(
            db,
            libraries,
            user_id,
            frozenset(_get_organization_names(db)),
            additional_group_names=group_names,
        )
        target_id = (
            db.query(Namespace.id)
            .filter(Namespace.name == namespace, Namespace.is_active.is_(True))
            .scalar()
            if group_names
            else None
        )

        def outcomes(candidates: list[Kind]) -> set[tuple[bool, bool]]:
            if namespace == "default":
                try:
                    return {
                        (
                            all(
                                resolve_direct_access_decision(
                                    db, kb, user_id, context=context
                                )
                                for kb in candidates
                            ),
                            True,
                        )
                    }
                except EntityMembershipUnavailable:
                    pass
            return {
                _binding_outcomes(
                    db,
                    candidates,
                    user_id,
                    namespace,
                    target_id,
                    scenario,
                )
                for scenario in permission_scenarios(
                    db,
                    candidates,
                    context,
                    additional_group_names=group_names,
                    placement_namespace_ids=(
                        frozenset({str(target_id)}) if target_id else frozenset()
                    ),
                )
            }

        pending = []
        denials = set()
        for kb in libraries:
            results = outcomes([kb])
            allowed = {access and placed for access, placed in results}
            if allowed == {False}:
                denials.add(
                    _DEFAULT_KB_ACCESS_ERROR
                    if any(not access for access, _ in results)
                    else _DEFAULT_KB_SCOPE_ERROR
                )
            if len(allowed) > 1:
                pending.append(kb)
        if denials:
            return (
                _DEFAULT_KB_ACCESS_ERROR
                if _DEFAULT_KB_ACCESS_ERROR in denials
                else _DEFAULT_KB_SCOPE_ERROR
            )
        unknown = False
        for component in _binding_fact_components(pending, context, namespace):
            results = outcomes(component)
            allowed = {access and placed for access, placed in results}
            if allowed == {False}:
                denials.add(
                    _DEFAULT_KB_ACCESS_ERROR
                    if any(not access for access, _ in results)
                    else _DEFAULT_KB_SCOPE_ERROR
                )
            unknown |= len(allowed) > 1
        if denials:
            return (
                _DEFAULT_KB_ACCESS_ERROR
                if _DEFAULT_KB_ACCESS_ERROR in denials
                else _DEFAULT_KB_SCOPE_ERROR
            )
        if unknown:
            failures = list(context.entity_failures.values()) + [
                value[0] for value in context.group_failures.values()
            ]
            assert failures
            raise failures[0]
        return None


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
    allow_empty_requirement: bool = False,
) -> bool:
    """Return whether raw ACL facts allow page discovery and direct opening."""
    spec: dict[str, Any] = kb.json.get("spec", {}) if isinstance(kb.json, dict) else {}
    requirement = spec.get(
        "directAccessRequirement",
        DEFAULT_DIRECT_ACCESS_REQUIREMENT,
    )
    if requirement == "read" or (allow_empty_requirement and requirement in {None, ""}):
        return permission.has_access
    if requirement == "edit":
        return can_manage_accessible_knowledge_base_documents(
            has_access=permission.has_access,
            role=permission.role,
            is_creator=permission.is_creator,
        )
    return False


def resolve_knowledge_permission_action(
    db: Session,
    knowledge_base_id: int,
    user_id: int,
    predicate: Callable[[KnowledgeBasePermission], bool],
    *,
    kb: Kind | None = None,
    context: KnowledgePermissionContext | None = None,
) -> bool:
    """Project existing ACL possibilities onto one complete resource action."""
    library = (
        kb
        or db.query(Kind)
        .filter(
            Kind.id == knowledge_base_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active.is_(True),
        )
        .first()
    )
    if library is None:
        return False
    with entity_resolution_scope(db):
        try:
            permission = resolve_knowledge_base_permission(
                db, library, user_id, context=context
            )
        except KnowledgePermissionUnavailable as failure:
            decisions = {predicate(candidate) for candidate in failure.possibilities}
            if len(decisions) != 1:
                raise
            return decisions.pop()
        return predicate(permission)


def resolve_acl_access_decision(
    db: Session, kb: Kind, user_id: int, *, context: KnowledgePermissionContext
) -> bool:
    """Resolve agent-use ACL without imposing the direct-opening requirement."""
    return resolve_knowledge_permission_action(
        db,
        cast(int, kb.id),
        user_id,
        lambda permission: permission.has_access and not permission.is_denied,
        kb=kb,
        context=context,
    )


def resolve_direct_access_decision(
    db: Session,
    kb: Kind,
    user_id: int,
    *,
    context: KnowledgePermissionContext | None = None,
    allow_empty_requirement: bool = False,
) -> bool:
    """Resolve opening without requiring an irrelevant precise role."""
    spec = cast(dict[str, Any], kb.json or {}).get("spec", {})
    if spec.get("directAccessRequirement", "read") not in {
        "read",
        "edit",
        *((None, "") if allow_empty_requirement else ()),
    }:
        return False
    return resolve_knowledge_permission_action(
        db,
        cast(int, kb.id),
        user_id,
        lambda permission: meets_direct_access_requirement(
            kb=kb,
            permission=permission,
            allow_empty_requirement=allow_empty_requirement,
        ),
        kb=kb,
        context=context,
    )


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
    return resolve_direct_access_decision(db, knowledge_base, user_id)


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
            ResourceMember.resource_id.in_([cast(int, kb.id) for kb in kbs]),
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
        cast(str, kb.namespace)
        for kb in kbs
        if cast(str, kb.namespace) != "default"
        and not is_organization_namespace(db, cast(str, kb.namespace))
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
    if cast(int, kb.user_id) != user_id:
        return
    roles.append(BaseRole.Owner.value)
    if include_sources:
        sources.append(
            PermissionSourceInfo(
                source_type="creator",
                display_name=cast(str | None, user.user_name if user else None),
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
    context: KnowledgePermissionContext | None = None,
) -> bool:
    member = (
        next(
            (
                member
                for member in context.members.get(cast(int, kb.id), [])
                if member.entity_type == "user" and member.entity_id == str(user_id)
            ),
            None,
        )
        if context
        else (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.resource_id == cast(int, kb.id),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            )
            .first()
        )
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
                display_name=cast(str | None, user.user_name if user else None),
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
    context: KnowledgePermissionContext | None = None,
) -> None:
    organization = (
        (cast(str, kb.namespace) in context.organization_names)
        if context
        else is_organization_namespace(db, cast(str, kb.namespace))
    )
    if not organization:
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
    context: KnowledgePermissionContext | None = None,
) -> bool:
    organization = (
        (cast(str, kb.namespace) in context.organization_names)
        if context
        else is_organization_namespace(db, cast(str, kb.namespace))
    )
    if cast(str, kb.namespace) == "default" or organization:
        return False
    group_role = (
        context.group_roles.get(cast(str, kb.namespace))
        if context
        else get_effective_role_in_group(db, user_id, cast(str, kb.namespace))
    )
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
        group = (
            db.query(Namespace)
            .filter(Namespace.name == cast(str, kb.namespace))
            .first()
        )
        sources.append(
            PermissionSourceInfo(
                source_type="group_membership",
                display_name=cast(
                    str, group.display_name or group.name if group else kb.namespace
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
    context: KnowledgePermissionContext | None = None,
) -> None:
    rows = (
        [
            (member.entity_type, member.entity_id, member.role)
            for member in context.members.get(cast(int, kb.id), [])
            if member.entity_type not in {"user", "", None} and member.entity_id
        ]
        if context
        else (
            db.query(
                ResourceMember.entity_type,
                ResourceMember.entity_id,
                ResourceMember.role,
            )
            .filter(
                ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
                ResourceMember.resource_id == cast(int, kb.id),
                ResourceMember.entity_type != "user",
                ResourceMember.entity_type != "",
                ResourceMember.entity_id.isnot(None),
                ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
            )
            .all()
        )
    )
    entity_groups: dict[str, list[str]] = {}
    role_map: dict[str, str] = {}
    for entity_type, entity_id, role in rows:
        if entity_type and entity_id:
            entity_groups.setdefault(cast(str, entity_type), []).append(
                cast(str, entity_id)
            )
            role_map[f"{entity_type}:{entity_id}"] = cast(str, role)

    unknown_roles: list[str] = []
    unavailable = None
    for entity_type, entity_ids in entity_groups.items():
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        failure = context.entity_failures.get(entity_type) if context else None
        try:
            matched_ids = (
                [
                    entity_id
                    for entity_id in entity_ids
                    if entity_id in context.matched_entities.get(entity_type, set())
                ]
                if context
                else resolver.match_entity_bindings(
                    db, user_id, entity_type, entity_ids
                )
            )
        except EntityMembershipUnavailable as exc:
            failure = exc
            matched_ids = exc.matched_ids
        if failure:
            unavailable = failure
            unknown_roles.extend(
                role_map[f"{entity_type}:{eid}"]
                for eid in entity_ids
                if eid in failure.unknown_ids
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

    if include_sources and unavailable and unknown_roles:
        raise unavailable

    if unavailable and get_highest_role(roles) != get_highest_role(
        roles + unknown_roles
    ):
        raise KnowledgePermissionUnavailable(
            unavailable,
            [
                _permission_for_roles(roles, cast(int, kb.user_id) == user_id),
                _permission_for_roles(
                    roles + unknown_roles, cast(int, kb.user_id) == user_id
                ),
            ],
        )


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

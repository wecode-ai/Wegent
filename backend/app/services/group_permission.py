# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import Iterator
from typing import Callable, Optional, cast

from sqlalchemy.orm import Query, Session

from app.models.namespace import Namespace
from app.schemas.base_role import has_permission
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.execution_permission_scope import is_execution_resource_scope
from app.services.external_entity_resolver import (
    EntityFact,
    EntityMembershipUnavailable,
    entity_resolution_scope,
    get_entity_resolution_context,
)
from app.services.group_member_helper import (
    iter_user_groups_with_roles,
)

RoleResolver = Callable[[Session, int, str], Optional[GroupRole]]
_RESTRICTED_KB_REASON = (
    "Restricted Analysts cannot access knowledge base content. "
    "You can view conversations but cannot retrieve document content, "
    "structure, or summaries from group knowledge bases."
)


def get_user_role_in_group(
    db: Session, user_id: int, group_name: str
) -> Optional[GroupRole]:
    """
    Get user's role in a specific group.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name

    Returns:
        GroupRole if user is a member, None otherwise
    """
    from app.services.group_member_helper import (
        get_user_role_in_group as helper_get_role,
    )

    role_str = helper_get_role(db, user_id, group_name)
    if role_str:
        try:
            return GroupRole(role_str)
        except ValueError:
            return None
    return None


GroupRoleBinding = tuple[int, GroupRole, frozenset[EntityFact]]
GroupMembership = tuple[str, str, str | None, str | None]
UnavailableGroupMembership = tuple[str, str, str, str, EntityMembershipUnavailable]


def _possible_group_roles(bindings: list[GroupRoleBinding]) -> set[GroupRole | None]:
    """Find feasible nearest-layer winners without enumerating fact combinations."""
    known = [(depth, role) for depth, role, facts in bindings if not facts]
    possible: set[GroupRole | None] = set() if known else {None}
    for depth, role in {(depth, role) for depth, role, _ in bindings}:
        if any(
            known_depth > depth
            or (
                known_depth == depth
                and known_role != role
                and has_permission(known_role, role)
            )
            for known_depth, known_role in known
        ):
            continue
        # Every deeper membership and stronger same-layer role must be absent.
        forbidden = set().union(
            *(
                facts
                for other_depth, other_role, facts in bindings
                if other_depth > depth
                or (
                    other_depth == depth
                    and other_role != role
                    and has_permission(other_role, role)
                )
            )
        )
        if any(
            other_depth == depth
            and other_role == role
            and (not facts or facts - forbidden)
            for other_depth, other_role, facts in bindings
        ):
            possible.add(role)
    return possible


def _group_role_possibilities(
    group_name: str,
    memberships: list[GroupMembership],
    unknown: list[UnavailableGroupMembership],
    *,
    include_namespace_entities: bool,
    present: frozenset[EntityFact] = frozenset(),
    absent: frozenset[EntityFact] = frozenset(),
) -> tuple[set[GroupRole | None], EntityMembershipUnavailable | None]:
    """Retain source exclusions and dependencies when projecting group facts."""
    parts = group_name.split("/")
    chain = {"/".join(parts[:depth]): depth for depth in range(1, len(parts) + 1)}
    # Scalar group grants exclude namespace bindings, as before.
    relevant = [
        row
        for row in memberships
        if row[0] in chain and (include_namespace_entities or row[2] != "namespace")
    ]
    confirmed: set[EntityFact] = {
        (kind, eid)
        for _, _, kind, eid in relevant
        if kind is not None and eid is not None
    }
    bindings: list[GroupRoleBinding] = []
    for name, role, _, _ in relevant:
        try:
            bindings.append((chain[name], GroupRole(role), frozenset()))
        except ValueError:
            continue
    failure = None
    dependencies: dict[str, frozenset[EntityFact]] = {}
    for name, role, entity_type, entity_id, unavailable in unknown:
        if name not in chain or (
            not include_namespace_entities and entity_type == "namespace"
        ):
            continue
        try:
            group_role = GroupRole(role)
        except ValueError:
            continue
        facts = unavailable.dependencies.get(
            entity_id, frozenset({(entity_type, entity_id)})
        )
        if facts & (confirmed | present):
            facts = frozenset()
        else:
            facts = facts - absent
            if not facts:
                continue
        bindings.append((chain[name], group_role, facts))
        failure = unavailable
        dependencies[entity_id] = dependencies.get(entity_id, frozenset()) | facts
    if dependencies:
        failure = EntityMembershipUnavailable(
            sorted(dependencies), [], dependencies=dependencies
        )
    return _possible_group_roles(bindings), failure


def _load_group_memberships(
    db: Session,
    user_id: int,
    chain_names: list[str],
) -> tuple[list[GroupMembership], list[UnavailableGroupMembership]]:
    """Reuse raw memberships only inside the caller's existing fact scope."""
    context = get_entity_resolution_context(db)
    assert context is not None
    key = f"group-memberships:{user_id}:{is_execution_resource_scope()}:{context.read_only}"
    batches = cast(
        dict[
            frozenset[str],
            tuple[list[GroupMembership], list[UnavailableGroupMembership]],
        ],
        context.facts.setdefault(key, {}),
    )
    requested = frozenset(chain_names)
    for names, values in batches.items():
        if requested.issubset(names):
            return values
    unknown: list[UnavailableGroupMembership] = []
    memberships = iter_user_groups_with_roles(
        db,
        user_id,
        deduplicate=False,
        group_names=chain_names,
        unavailable_memberships=unknown,
    )
    batches[requested] = (memberships, unknown)
    return memberships, unknown


def _group_role_projections(
    db: Session,
    user_id: int,
    group_names: list[str],
    *,
    include_namespace_entities: bool,
    absent: frozenset[EntityFact] = frozenset(),
    inherit: bool = True,
) -> Iterator[tuple[str, set[GroupRole | None], EntityMembershipUnavailable | None]]:
    """Resolve only requested groups and ancestors, sharing one external scope."""
    if not group_names:
        return
    chain_names = {
        "/".join(name.split("/")[:depth])
        for name in group_names
        for depth in range(1, name.count("/") + 2)
    }
    if not inherit:
        chain_names = set(group_names)
    unknown: list[UnavailableGroupMembership] = []
    with entity_resolution_scope(db):
        memberships, unknown = _load_group_memberships(db, user_id, sorted(chain_names))
    for name in dict.fromkeys(group_names):
        roles, failure = _group_role_possibilities(
            name,
            memberships if inherit else [row for row in memberships if row[0] == name],
            unknown if inherit else [row for row in unknown if row[0] == name],
            include_namespace_entities=include_namespace_entities,
            absent=absent,
        )
        yield name, roles, failure


def check_group_permission(
    db: Session,
    user_id: int,
    group_name: str,
    required_role: GroupRole,
    *,
    absent: frozenset[EntityFact] = frozenset(),
) -> bool:
    """
    Check if user has required permission level in a group.

    Permission hierarchy: Owner > Maintainer > Developer > Reporter > RestrictedAnalyst
    A user with a higher role can perform actions of lower roles.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name
        required_role: Minimum required role

    Returns:
        True if user has permission, False otherwise
    """
    return check_group_permissions(
        db, user_id, [group_name], required_role, absent=absent
    )[group_name]


def check_group_permissions(
    db: Session,
    user_id: int,
    group_names: list[str],
    required_role: GroupRole,
    *,
    include_namespace_entities: bool = False,
    absent: frozenset[EntityFact] = frozenset(),
) -> dict[str, bool]:
    """Project a shared batch of membership facts onto one action threshold."""
    decisions = group_permission_decisions(
        db,
        user_id,
        group_names,
        required_role,
        include_namespace_entities=include_namespace_entities,
        absent=absent,
    )
    result = {}
    for name, decision in decisions.items():
        if isinstance(decision, EntityMembershipUnavailable):
            raise decision
        result[name] = decision
    return result


def group_permission_decisions(
    db: Session,
    user_id: int,
    group_names: list[str],
    required_role: GroupRole,
    *,
    include_namespace_entities: bool = False,
    absent: frozenset[EntityFact] = frozenset(),
) -> dict[str, bool | EntityMembershipUnavailable]:
    """Retain unknown outcomes until a caller completes its resource selection."""
    result: dict[str, bool | EntityMembershipUnavailable] = {}
    for name, roles, failure in _group_role_projections(
        db,
        user_id,
        list(dict.fromkeys(group_names)),
        include_namespace_entities=include_namespace_entities,
        absent=absent,
    ):
        decisions = {
            role is not None and has_permission(role, required_role) for role in roles
        }
        if len(decisions) == 1:
            result[name] = decisions.pop()
        else:
            assert failure is not None
            result[name] = failure
    return result


def check_view_group_permission(
    db: Session,
    user_id: int,
    group_name: str,
    required_role: GroupRole,
    *,
    user_role: str | None = None,
    group_level: str | None = None,
) -> bool:
    """Apply the existing organization-admin fallback to the whole action."""
    _, roles, failure = next(
        _group_role_projections(
            db, user_id, [group_name], include_namespace_entities=False
        )
    )
    decisions = {
        (
            has_permission(role, required_role)
            if role is not None
            else user_role == "admin" and group_level == GroupLevel.organization.value
        )
        for role in roles
    }
    if len(decisions) != 1:
        assert failure is not None
        raise failure
    return decisions.pop()


def get_user_groups(db: Session, user_id: int) -> list[str]:
    """
    Get all group names that user has access to, including inherited permissions
    from parent groups and entity-derived memberships.

    Permission inheritance logic:
    - If user is a member of 'aaa', they have access to 'aaa/bbb', 'aaa/bbb/ccc', etc.
    - Direct memberships take precedence over inherited permissions

    Args:
        db: Database session
        user_id: User ID

    Returns:
        List of group names (without duplicates)
    """
    names = [
        name
        for (name,) in db.query(Namespace.name)
        .filter(Namespace.is_active.is_(True))
        .all()
    ]
    groups = []
    for name, roles, failure in _group_role_projections(
        db, user_id, names, include_namespace_entities=True
    ):
        membership = {role is not None for role in roles}
        if len(membership) != 1:
            assert failure is not None
            raise failure
        if membership.pop():
            groups.append(name)
    return sorted(groups)


def get_user_group_roles(db: Session, user_id: int) -> dict[str, GroupRole]:
    """Get effective roles for every active group with one membership fetch."""
    group_names = [
        name
        for (name,) in db.query(Namespace.name)
        .filter(Namespace.is_active.is_(True))
        .all()
    ]
    return get_effective_roles_in_groups(db, user_id, group_names)


def get_effective_role_in_group(
    db: Session, user_id: int, group_name: str
) -> Optional[GroupRole]:
    """
    Get user's effective role in a group, considering direct membership,
    entity-derived memberships, and inheritance from parent groups.

    Resolution rules:
    - The nearest group with a membership overrides its ancestors.
    - At that level, direct and non-namespace entity grants take the highest role.
    - Return 503 only when unavailable facts can change the precise role.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name

    Returns:
        GroupRole if user has access (direct, entity, or inherited), None otherwise
    """
    _, roles, failure = next(
        _group_role_projections(
            db, user_id, [group_name], include_namespace_entities=False
        )
    )
    if len(roles) == 1:
        return roles.pop()
    assert failure is not None
    raise failure


def get_view_role_in_group(
    db: Session,
    user_id: int,
    group_name: str,
    user_role: str | None = None,
    group_level: str | None = None,
    role_resolver: RoleResolver | None = None,
) -> Optional[GroupRole]:
    """Return the role that should be used for group read/view access."""
    resolver = role_resolver or get_effective_role_in_group
    role = resolver(db, user_id, group_name)
    if role is not None:
        return role

    if user_role == "admin" and group_level == GroupLevel.organization.value:
        return GroupRole.Owner

    return None


def check_user_group_permission(
    user_id: int, group_name: str, min_role: str = "Reporter"
) -> bool:
    """
    Check if user has required permission level in a group.
    This is a standalone function that manages its own DB session.

    Permission hierarchy: Owner > Maintainer > Developer > Reporter > RestrictedAnalyst
    A user with a higher role can perform actions of lower roles.

    Args:
        user_id: User ID
        group_name: Group name (namespace)
        min_role: Minimum required role as string ("Reporter", "Developer", "Maintainer", "Owner")

    Returns:
        True if user has permission, False otherwise
    """
    from app.db.session import SessionLocal

    # Convert string role to GroupRole enum
    try:
        required_role = GroupRole(min_role)
    except ValueError:
        return False

    with SessionLocal() as db:
        return check_group_permission(db, user_id, group_name, required_role)


def is_restricted_analyst(db: Session, user_id: int, group_name: str) -> bool:
    """
    Check if user is a Restricted Analyst in the specified group.

    Restricted Analysts have limited access to knowledge base content.
    They can view conversations but cannot access document content,
    document structure, or summaries.

    Args:
        db: Database session
        user_id: User ID
        group_name: Group name (namespace)

    Returns:
        True if user is a Restricted Analyst in the group, False otherwise
    """
    return group_name in get_restricted_analyst_groups(db, user_id, [group_name])


def get_explicit_roles_for_group_query(
    db: Session, user_id: int, names: Query
) -> dict[str, GroupRole]:
    """Resolve displayed roles only for memberships matching the namespace query."""
    with entity_resolution_scope(db):
        unknown: list[UnavailableGroupMembership] = []
        memberships = iter_user_groups_with_roles(
            db,
            user_id,
            deduplicate=False,
            group_names=names,
            unavailable_memberships=unknown,
        )
        by_name: dict[str, list[GroupMembership]] = {}
        pending: dict[str, list[UnavailableGroupMembership]] = {}
        for membership in memberships:
            by_name.setdefault(membership[0], []).append(membership)
        for unresolved in unknown:
            pending.setdefault(unresolved[0], []).append(unresolved)
        roles = {}
        for name in by_name.keys() | pending.keys():
            possible, failure = _group_role_possibilities(
                name,
                by_name.get(name, []),
                pending.get(name, []),
                include_namespace_entities=True,
            )
            if len(possible) != 1:
                assert failure is not None
                raise failure
            role = possible.pop()
            if role is not None:
                roles[name] = role
        return roles


def get_effective_roles_in_groups(
    db: Session,
    user_id: int,
    group_names: list[str],
    *,
    memberships: list[tuple[str, str, Optional[str], Optional[str]]] | None = None,
    inherit: bool = True,
) -> dict[str, GroupRole]:
    """Get effective roles for multiple groups with a single membership fetch.

    Covers direct user memberships, entity-derived memberships, and parent
    group inheritance. Uses iter_user_groups_with_roles for the user-side
    batch resolution to avoid N x namespace resolver calls.
    """
    if not group_names:
        return {}

    from app.schemas.base_role import get_highest_role

    if memberships is None:
        resolved = {}
        for name, possible_roles, failure in _group_role_projections(
            db, user_id, group_names, include_namespace_entities=True, inherit=inherit
        ):
            if len(possible_roles) != 1:
                assert failure is not None
                raise failure
            projected_role = possible_roles.pop()
            if projected_role is not None:
                resolved[name] = projected_role
        return resolved

    # Batch fetch all user memberships (direct + entity)
    all_memberships = memberships

    # group_name -> list of role strings
    role_map: dict[str, list[str]] = {}
    for group_name, role, _src_type, _src_id in all_memberships:
        role_map.setdefault(group_name, []).append(role)

    effective_roles: dict[str, GroupRole] = {}
    for group_name in dict.fromkeys(group_names):
        roles = role_map.get(group_name, [])

        # Parent group inheritance
        if inherit and not roles and "/" in group_name:
            parts = group_name.split("/")
            for i in range(len(parts) - 1, 0, -1):
                parent_name = "/".join(parts[:i])
                parent_roles = role_map.get(parent_name)
                if parent_roles:
                    roles = parent_roles
                    break

        if roles:
            highest = get_highest_role(roles)
            try:
                effective_roles[group_name] = GroupRole(highest)
            except ValueError:
                continue

    return effective_roles


def get_restricted_analyst_groups(
    db: Session, user_id: int, group_names: list[str]
) -> set[str]:
    """Return group names where the user's effective role is RestrictedAnalyst."""
    restricted = set()
    for name, roles, failure in _group_role_projections(
        db, user_id, group_names, include_namespace_entities=True
    ):
        decisions = {role == GroupRole.RestrictedAnalyst for role in roles}
        if len(decisions) != 1:
            assert failure is not None
            raise failure
        if decisions.pop():
            restricted.add(name)
    return restricted


def has_restricted_analyst_group(
    db: Session, user_id: int, group_names: list[str]
) -> bool:
    """Resolve the combined redaction condition over shared group facts."""
    return _any_group_role_action(
        db,
        user_id,
        group_names,
        lambda role: role == GroupRole.RestrictedAnalyst,
        include_namespace_entities=True,
    )


def check_any_group_permission(
    db: Session,
    user_id: int,
    group_names: list[str],
    required_role: GroupRole,
    *,
    include_namespace_entities: bool = False,
) -> bool:
    """Resolve an action granted by any relevant namespace, retaining dependencies."""
    return _any_group_role_action(
        db,
        user_id,
        group_names,
        lambda role: role is not None and has_permission(role, required_role),
        include_namespace_entities=include_namespace_entities,
    )


def _any_group_role_action(
    db: Session,
    user_id: int,
    group_names: list[str],
    predicate: Callable[[GroupRole | None], bool],
    *,
    include_namespace_entities: bool,
) -> bool:
    """Keep correlations when projecting a union of existing group actions."""
    names = list(dict.fromkeys(group_names))
    if not names:
        return False
    chain = sorted(
        {
            "/".join(name.split("/")[:depth])
            for name in names
            for depth in range(1, name.count("/") + 2)
        }
    )
    unknown: list[UnavailableGroupMembership] = []
    with entity_resolution_scope(db):
        memberships, unknown = _load_group_memberships(db, user_id, chain)
    unknown = [
        row for row in unknown if include_namespace_entities or row[2] != "namespace"
    ]
    facts = frozenset().union(
        *(
            failure.dependencies.get(eid, frozenset({(kind, eid)}))
            for _, _, kind, eid, failure in unknown
        )
    )

    def restricted_states(
        present: frozenset[EntityFact], absent: frozenset[EntityFact]
    ) -> list[set[bool]]:
        return [
            {
                predicate(role)
                for role in _group_role_possibilities(
                    name,
                    memberships,
                    unknown,
                    include_namespace_entities=include_namespace_entities,
                    present=present,
                    absent=absent,
                )[0]
            }
            for name in names
        ]

    initial = restricted_states(frozenset(), frozenset())
    if not any(True in states for states in initial):
        return False

    def can_avoid(
        present: frozenset[EntityFact], absent: frozenset[EntityFact]
    ) -> bool:
        pending = [(present, absent)]
        while pending:
            included, excluded = pending.pop()
            states = restricted_states(included, excluded)
            if any(state == {True} for state in states):
                continue
            if all(state == {False} for state in states):
                return True
            uncertain_names = [
                name for name, state in zip(names, states) if len(state) > 1
            ]
            relevant = frozenset().union(
                *(
                    failure.dependencies.get(eid, frozenset({(kind, eid)}))
                    for group, _, kind, eid, failure in unknown
                    if any(
                        name == group or name.startswith(group + "/")
                        for name in uncertain_names
                    )
                )
            )
            fact = next(iter(relevant - included - excluded))
            pending.append((included, excluded | {fact}))
            pending.append((included | {fact}, excluded))
        return False

    # Complete extreme assignments handle large independent sets without recursion.
    if any(
        all(state == {False} for state in restricted_states(present, absent))
        for present, absent in [(facts, frozenset()), (frozenset(), facts)]
    ):
        raise unknown[0][4]
    if can_avoid(frozenset(), frozenset()):
        raise unknown[0][4]
    return True


def check_knowledge_base_access_for_restricted_analyst(
    db: Session,
    user_id: int,
    knowledge_base_namespace: str,
) -> tuple[bool, str]:
    """
    Check if a user can access knowledge base content.

    For Restricted Analysts, they are prevented from accessing non-default (group)
    knowledge bases but are allowed to access the default (personal) namespace
    and shared personal KBs. This prevents them from extracting document content
    through conversation while maintaining access to their own personal KBs.

    Args:
        db: Database session
        user_id: User ID
        knowledge_base_namespace: Knowledge base namespace (group name or 'default')

    Returns:
        Tuple of (has_access, reason)
        - has_access: True if user can access KB content
        - reason: Explanation if access is denied
    """
    # Check if user is a Restricted Analyst in this group (for group KBs)
    if knowledge_base_namespace != "default":
        if is_restricted_analyst(db, user_id, knowledge_base_namespace):
            return (
                False,
                _RESTRICTED_KB_REASON,
            )

    return True, ""


def check_knowledge_base_access_for_restricted_analyst_by_ids(
    db: Session,
    user_id: int,
    knowledge_base_ids: list[int],
) -> tuple[bool, str]:
    """
    Check if a user can access knowledge base content by KB IDs.

    For Restricted Analysts, they are prevented from accessing non-default (group)
    knowledge bases but are allowed to access the default (personal) namespace
    and shared personal KBs. This prevents them from extracting document content
    through conversation while maintaining access to their own personal KBs.

    Args:
        db: Database session
        user_id: User ID
        knowledge_base_ids: List of knowledge base IDs to check

    Returns:
        Tuple of (has_access, reason)
        - has_access: True if user can access KB content
        - reason: Explanation if access is denied
    """
    from app.models.kind import Kind

    if not knowledge_base_ids:
        return True, ""

    # Get knowledge bases to check their namespaces
    kbs = (
        db.query(Kind)
        .filter(
            Kind.id.in_(knowledge_base_ids),
            Kind.kind == "KnowledgeBase",
            Kind.is_active,
        )
        .all()
    )

    names = list(
        dict.fromkeys(
            cast(str, kb.namespace) for kb in kbs if kb.namespace != "default"
        )
    )
    if has_restricted_analyst_group(db, user_id, names):
        return False, _RESTRICTED_KB_REASON
    return True, ""

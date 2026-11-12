"""Bounded native ACL facts; policy remains in knowledge_access_policy."""

from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from typing import cast

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import (
    APPROVED_MEMBER_STATUS_VALUES,
    KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES,
    ResourceMember,
)
from app.models.user import User
from app.schemas.base_role import get_highest_role
from app.schemas.namespace import GroupRole
from app.services.external_entity_resolver import (
    EntityFact,
    EntityMembershipUnavailable,
    get_entity_resolver,
)
from app.services.group_member_helper import iter_user_groups_with_roles
from app.services.group_permission import get_effective_roles_in_groups

Membership = tuple[str, str, str | None, str | None]
EntityMembership = tuple[str, str, str, str]


@dataclass(frozen=True)
class KnowledgePermissionContext:
    user_id: int
    user: User | None
    organization_names: frozenset[str]
    group_roles: dict[str, GroupRole]
    restricted_groups: frozenset[str]
    members: dict[int, list[ResourceMember]]
    matched_entities: dict[str, set[str]]
    entity_failures: dict[str, EntityMembershipUnavailable] = field(
        default_factory=dict
    )
    group_failures: dict[
        str,
        tuple[EntityMembershipUnavailable, list[Membership], list[EntityMembership]],
    ] = field(default_factory=dict)
    entity_dependencies: dict[EntityFact, frozenset[EntityFact]] = field(
        default_factory=dict
    )
    memberships: tuple[Membership, ...] = ()
    scope_group_roles: dict[str, GroupRole | None] = field(default_factory=dict)


def build_knowledge_permission_context(
    db: Session,
    libraries: list[Kind],
    user_id: int,
    organization_names: frozenset[str],
    *,
    additional_group_names: tuple[str, ...] = (),
) -> KnowledgePermissionContext:
    """Load candidate bindings once and reuse the existing group batch resolver."""
    user = db.query(User).filter(User.id == user_id).first()
    group_names = list(
        dict.fromkeys(
            cast(str, kb.namespace)
            for kb in libraries
            if kb.namespace != "default" and kb.namespace not in organization_names
        )
    )
    group_names = list(dict.fromkeys([*group_names, *additional_group_names]))
    unavailable_memberships: list[
        tuple[str, str, str, str, EntityMembershipUnavailable]
    ] = []
    memberships = (
        iter_user_groups_with_roles(
            db,
            user_id,
            deduplicate=False,
            group_names=sorted(
                {
                    "/".join(name.split("/")[:depth])
                    for name in group_names
                    for depth in range(1, len(name.split("/")) + 1)
                }
            ),
            unavailable_memberships=unavailable_memberships,
        )
        if group_names
        else []
    )
    group_failures = {}
    dependencies: dict[EntityFact, frozenset[EntityFact]] = {}
    for _, _, entity_type, entity_id, failure in unavailable_memberships:
        if entity_id in failure.dependencies:
            dependencies[(entity_type, entity_id)] = failure.dependencies[entity_id]
    for name in group_names:
        relevant = [
            row
            for row in unavailable_memberships
            if name == row[0] or name.startswith(row[0] + "/")
        ]
        if relevant:
            group_failures[name] = (
                relevant[0][4],
                [
                    row
                    for row in memberships
                    if name == row[0] or name.startswith(row[0] + "/")
                ],
                [row[:4] for row in relevant],
            )
    all_roles = get_effective_roles_in_groups(
        db, user_id, group_names, memberships=memberships
    )
    # Scalar restriction checks include namespace members, but role grants do not.
    group_roles = get_effective_roles_in_groups(
        db,
        user_id,
        group_names,
        memberships=[row for row in memberships if row[2] != "namespace"],
    )
    rows = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type.in_(KNOWLEDGE_BASE_RESOURCE_TYPE_VALUES),
            ResourceMember.resource_id.in_([kb.id for kb in libraries]),
            ResourceMember.status.in_(APPROVED_MEMBER_STATUS_VALUES),
        )
        .all()
    )
    members: dict[int, list[ResourceMember]] = {}
    entities: dict[str, set[str]] = {}
    for member in rows:
        members.setdefault(cast(int, member.resource_id), []).append(member)
        if member.entity_type not in {"user", "", None} and member.entity_id:
            entities.setdefault(cast(str, member.entity_type), set()).add(
                cast(str, member.entity_id)
            )
    matched = {}
    failures = {}
    for entity_type, entity_ids in entities.items():
        resolver = get_entity_resolver(entity_type)
        try:
            matched[entity_type] = (
                set(
                    resolver.match_entity_bindings(
                        db, user_id, entity_type, sorted(entity_ids)
                    )
                )
                if resolver
                else set()
            )
        except EntityMembershipUnavailable as exc:
            matched[entity_type] = set(exc.matched_ids)
            failures[entity_type] = exc
            dependencies.update(
                ((entity_type, entity_id), facts)
                for entity_id, facts in exc.dependencies.items()
            )
    return KnowledgePermissionContext(
        user_id,
        user,
        organization_names,
        group_roles,
        frozenset(
            name
            for name, role in all_roles.items()
            if role == GroupRole.RestrictedAnalyst
        ),
        members,
        matched,
        failures,
        group_failures,
        dependencies,
        tuple(memberships),
        dict(all_roles),
    )


def permission_scenarios(
    db: Session,
    kb: Kind | list[Kind],
    context: KnowledgePermissionContext,
    *,
    memberships: list[Membership] | None = None,
    additional_group_names: tuple[str, ...] = (),
    placement_namespace_ids: frozenset[str] = frozenset(),
) -> Iterator[KnowledgePermissionContext]:
    """Project shared unknown identities consistently across candidate libraries."""
    libraries = kb if isinstance(kb, list) else [kb]
    names = list(
        dict.fromkeys(
            [cast(str, item.namespace) for item in libraries]
            + list(additional_group_names)
        )
    )
    known_memberships = (
        list(context.memberships) if memberships is None else memberships
    )
    unavailable: list[EntityMembership] = []
    for name in names:
        if name in context.group_failures:
            _, known, unknown = context.group_failures[name]
            known_memberships.extend(known)
            unavailable.extend(unknown)
    known_memberships = list(dict.fromkeys(known_memberships))
    bindings: dict[EntityFact, list[Membership]] = {}
    aliases: dict[EntityFact, set[EntityFact]] = {}
    for group, role, entity_type, entity_id in dict.fromkeys(unavailable):
        alias = (entity_type, entity_id)
        for fact in context.entity_dependencies.get(alias, frozenset({alias})):
            bindings.setdefault(fact, []).append((group, role, entity_type, entity_id))
            aliases.setdefault(fact, set()).add(alias)
    entity_roles: dict[int, dict[EntityFact, str]] = {
        cast(int, item.id): {
            (cast(str, member.entity_type), cast(str, member.entity_id)): cast(
                str, member.role
            )
            for member in context.members.get(cast(int, item.id), [])
            if member.entity_type not in {"user", "", None} and member.entity_id
        }
        for item in libraries
    }
    for roles in entity_roles.values():
        for fact in roles:
            failure = context.entity_failures.get(fact[0])
            if failure and fact[1] in failure.unknown_ids:
                for source in context.entity_dependencies.get(fact, frozenset({fact})):
                    bindings.setdefault(source, [])
                    aliases.setdefault(source, set()).add(fact)

    states = [(known_memberships, context.matched_entities)]
    for (entity_type, entity_id), rows in bindings.items():
        candidates = []
        for known, matched in states:
            if entity_id not in matched.get(entity_type, set()):
                candidates.append((known, matched))
            included = dict(matched)
            for kind, eid in aliases[(entity_type, entity_id)] | {
                (entity_type, entity_id)
            }:
                included[kind] = included.get(kind, set()) | {eid}
            candidates.append((known + rows, included))
        # Keep all target role and placement projections; merge equivalent worlds.
        distinct = {}
        for known, matched in candidates:
            projections = tuple(
                (
                    _group_projection(db, context.user_id, name, known),
                    _group_projection(
                        db,
                        context.user_id,
                        name,
                        [row for row in known if row[2] != "namespace"],
                    ),
                    any(row[0] == name for row in known),
                )
                for name in names
            )
            library_roles = tuple(
                get_highest_role(
                    [
                        role
                        for (kind, eid), role in roles.items()
                        if eid in matched.get(kind, set())
                    ]
                )
                for roles in entity_roles.values()
            )
            # Retain only placement identities observed by the caller's action.
            placements = (
                frozenset(matched.get("namespace", set())) & placement_namespace_ids
            )
            distinct[(projections, library_roles, placements)] = (known, matched)
        states = list(distinct.values())

    for known, matched in states:
        group_roles = dict(context.group_roles)
        scope_roles = dict(context.scope_group_roles)
        restricted = set(context.restricted_groups)
        for name in names:
            _, restriction = _group_projection(db, context.user_id, name, known)
            _, grant = _group_projection(
                db,
                context.user_id,
                name,
                [row for row in known if row[2] != "namespace"],
            )
            group_roles.pop(name, None)
            if grant is not None:
                group_roles[name] = grant
            scope_roles[name] = restriction
            restricted.discard(name)
            if restriction == GroupRole.RestrictedAnalyst:
                restricted.add(name)
        yield replace(
            context,
            group_roles=group_roles,
            scope_group_roles=scope_roles,
            restricted_groups=frozenset(restricted),
            matched_entities=matched,
            memberships=tuple(known),
            entity_failures={},
            group_failures={
                k: v for k, v in context.group_failures.items() if k not in names
            },
        )


def _group_projection(
    db: Session, user_id: int, name: str, memberships: list[Membership]
) -> tuple[int, GroupRole | None]:
    """Retain inheritance depth so later facts can override only valid winners."""
    memberships = [
        row for row in memberships if name == row[0] or name.startswith(row[0] + "/")
    ]
    depth = max((row[0].count("/") for row in memberships), default=-1)
    role = get_effective_roles_in_groups(
        db, user_id, [name], memberships=memberships
    ).get(name)
    return depth, role

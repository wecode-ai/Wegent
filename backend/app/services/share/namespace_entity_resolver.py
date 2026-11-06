# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Namespace entity resolver implementation.

Concrete implementation of IExternalEntityResolver that handles
namespace entity type by checking group membership via ResourceMember.

When a ResourceMember record has entity_type='namespace' and
entity_id='<namespace_id>', it grants access to all members of that
namespace who have approved membership status.

Resolution chain:
- For direct user memberships: check entity_type='user' ResourceMember records
- For entity-derived memberships: check entity-type members (e.g., org_department)
  and delegate to the corresponding entity resolver to verify user membership
"""

import logging
from collections import defaultdict
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.services.external_entity_resolver import (
    IExternalEntityResolver,
    get_entity_resolver,
)
from app.services.group_member_helper import NAMESPACE_RESOURCE_TYPE

logger = logging.getLogger(__name__)


def _namespace_id(entity_id: str) -> Optional[int]:
    try:
        return int(entity_id)
    except (ValueError, TypeError):
        return None


def _load_namespace_members(
    db: Session, user_id: int, namespace_ids: set[int]
) -> list[ResourceMember]:
    """Read each reachable namespace once, batching each graph frontier."""
    visited: set[int] = set()
    pending = namespace_ids
    members: list[ResourceMember] = []
    while pending:
        visited.update(pending)
        rows = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.resource_id.in_(pending),
                ResourceMember.status == MemberStatus.APPROVED.value,
                or_(
                    ResourceMember.entity_type != "user",
                    ResourceMember.entity_id == str(user_id),
                ),
            )
            .all()
        )
        members.extend(rows)
        pending = {
            namespace_id
            for member in rows
            if member.entity_type == "namespace"
            and (namespace_id := _namespace_id(member.entity_id)) is not None
        } - visited
    return members


def _match_namespace_members(
    db: Session,
    user_id: int,
    members: list[ResourceMember],
    user_context: Optional[dict],
) -> set[int]:
    """Propagate verified user/entity membership; cycles alone grant nothing."""
    matched: set[int] = set()
    dependents: dict[int, set[int]] = defaultdict(set)
    entities: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    for member in members:
        if member.entity_type == "user":
            matched.add(member.resource_id)
        elif member.entity_type == "namespace":
            namespace_id = _namespace_id(member.entity_id)
            if namespace_id is not None:
                dependents[namespace_id].add(member.resource_id)
        else:
            entities[member.entity_type][member.entity_id].add(member.resource_id)
    for entity_type, bindings in entities.items():
        resolver = get_entity_resolver(entity_type)
        if resolver is None:
            continue
        entity_ids = resolver.match_entity_bindings(
            db, user_id, entity_type, list(bindings), user_context
        )
        for entity_id in entity_ids:
            matched.update(bindings.get(entity_id, ()))
    pending = list(matched)
    while pending:
        for namespace_id in dependents.get(pending.pop(), ()):
            if namespace_id not in matched:
                matched.add(namespace_id)
                pending.append(namespace_id)
    return matched


class NamespaceEntityResolver(IExternalEntityResolver):
    """Resolves namespace entity bindings using ResourceMember membership.

    For a given user, this resolver checks if the user is a member of
    the namespaces specified in entity_ids by querying ResourceMember
    records with resource_type='Namespace'.

    Supports both direct user memberships (entity_type='user') and
    entity-derived memberships (e.g., org_department).
    """

    @property
    def requires_display_name_snapshot(self) -> bool:
        """Namespace names are always resolvable from the local DB."""
        return False

    def get_display_name(self, db: Session, entity_id: str) -> Optional[str]:
        """Resolve namespace display name from the Namespace table."""
        if not entity_id:
            return None
        try:
            ns_id = int(entity_id)
        except (ValueError, TypeError):
            return None
        namespace = db.query(Namespace).filter(Namespace.id == ns_id).first()
        if namespace:
            return namespace.display_name or namespace.name
        return None

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        if entity_type != "namespace" or not entity_ids:
            return []
        namespace_id_map = {
            namespace_id: entity_id
            for entity_id in entity_ids
            if (namespace_id := _namespace_id(entity_id)) is not None
        }
        members = _load_namespace_members(db, user_id, set(namespace_id_map))
        matched_ns_ids = _match_namespace_members(db, user_id, members, user_context)
        matched = [
            entity_id
            for namespace_id, entity_id in namespace_id_map.items()
            if namespace_id in matched_ns_ids
        ]

        if matched:
            logger.info(
                f"User user_id={user_id} matched namespaces {matched} "
                f"via NamespaceEntityResolver (direct + entity-derived)"
            )

        return matched

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        resource_type: str = ResourceType.KNOWLEDGE_BASE.value,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != "namespace":
            return []

        # Get user's accessible namespaces via both direct and entity-derived memberships
        # without creating circular dependencies.

        # 1) Direct user memberships (entity_type='user')
        direct_ns_rows = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        direct_ns_ids = [r.resource_id for r in direct_ns_rows]

        # 2) Entity-derived memberships
        # Get all registered entity types and check which namespaces have entity members
        from app.services.external_entity_resolver import (
            get_all_entity_types,
            get_entity_resolver,
        )

        all_entity_types = get_all_entity_types()
        entity_ns_ids: set[int] = set()

        for et in all_entity_types:
            if et in ("namespace", "user"):
                continue
            resolver = get_entity_resolver(et)
            if not resolver:
                continue
            # Get all namespaces that have this entity_type as member
            ns_with_entity = (
                db.query(ResourceMember.resource_id, ResourceMember.entity_id)
                .filter(
                    ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                    ResourceMember.entity_type == et,
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .all()
            )
            if not ns_with_entity:
                continue

            entity_ids = list(set(eid for _, eid in ns_with_entity))
            matched = resolver.match_entity_bindings(db, user_id, et, entity_ids)
            if matched:
                eid_set = set(matched)
                for ns_id, eid in ns_with_entity:
                    if eid in eid_set:
                        entity_ns_ids.add(ns_id)

        # Combine both
        all_ns_ids = list(set(direct_ns_ids) | entity_ns_ids)
        if not all_ns_ids:
            return []

        # Build resource_type variants for legacy data support
        resource_type_variants = [resource_type]
        if resource_type == "KnowledgeBase":
            resource_type_variants.append("KNOWLEDGE_BASE")

        # Find all resource_members referencing those namespaces
        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type.in_(resource_type_variants),
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_([str(nid) for nid in all_ns_ids]),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return list(set(r.resource_id for r in results))


namespace_entity_resolver = NamespaceEntityResolver()

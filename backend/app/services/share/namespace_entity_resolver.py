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
        if entity_type != "namespace":
            return []

        if not entity_ids:
            return []

        # Convert entity_ids to int for namespace ID comparison
        namespace_ids = []
        namespace_id_map = {}  # id -> entity_id string
        for eid in entity_ids:
            try:
                ns_id = int(eid)
                namespace_ids.append(ns_id)
                namespace_id_map[ns_id] = eid
            except (ValueError, TypeError):
                continue

        if not namespace_ids:
            return []

        matched_ns_ids: set[int] = set()

        # 1) Check direct user memberships (entity_type='user')
        direct_matches = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.resource_id.in_(namespace_ids),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        for row in direct_matches:
            matched_ns_ids.add(row.resource_id)

        # 2) Check entity-derived memberships via resolver chain
        # Get all non-user entity members for these namespaces
        entity_members = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.resource_id.in_(namespace_ids),
                ResourceMember.entity_type != "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )

        # Group by entity_type: entity_type -> [(ns_id, entity_id)]
        entity_by_type: dict[str, list[tuple[int, str]]] = defaultdict(list)
        for m in entity_members:
            entity_by_type[m.entity_type].append((m.resource_id, m.entity_id))

        # For each entity_type, delegate to its resolver
        for et, entries in entity_by_type.items():
            resolver = get_entity_resolver(et)
            if not resolver:
                continue

            entity_ids_list = [eid for _, eid in entries]
            matched = resolver.match_entity_bindings(db, user_id, et, entity_ids_list)

            if matched:
                # Build reverse map: entity_id -> ns_id
                eid_to_ns_ids: dict[str, list[int]] = defaultdict(list)
                for ns_id, eid in entries:
                    eid_to_ns_ids[eid].append(ns_id)

                for eid in matched:
                    for ns_id in eid_to_ns_ids.get(eid, []):
                        matched_ns_ids.add(ns_id)

        matched = [namespace_id_map[ns_id] for ns_id in matched_ns_ids]

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

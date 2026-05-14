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
"""

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.services.group_member_helper import NAMESPACE_RESOURCE_TYPE
from app.services.share.external_entity_resolver import IExternalEntityResolver

logger = logging.getLogger(__name__)


class NamespaceEntityResolver(IExternalEntityResolver):
    """Resolves namespace entity bindings using ResourceMember membership.

    For a given user, this resolver checks if the user is a member of
    the namespaces specified in entity_ids by querying ResourceMember
    records with resource_type='Namespace' and entity_type='user'.
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
        for eid in entity_ids:
            try:
                namespace_ids.append(int(eid))
            except (ValueError, TypeError):
                continue

        if not namespace_ids:
            return []

        matched_rows = (
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
        matched = [str(r.resource_id) for r in matched_rows]

        if matched:
            logger.info(
                f"User user_id={user_id} matched namespaces {matched} "
                f"via NamespaceEntityResolver"
            )

        return matched

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != "namespace":
            return []

        # Find all namespaces where user is an approved member
        user_namespace_ids = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        ns_ids = [r.resource_id for r in user_namespace_ids]
        if not ns_ids:
            return []

        # Find all KnowledgeBase resource_members referencing those namespaces
        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type.in_(["KnowledgeBase", "KNOWLEDGE_BASE"]),
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_([str(nid) for nid in ns_ids]),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return list(set(r.resource_id for r in results))


namespace_entity_resolver = NamespaceEntityResolver()

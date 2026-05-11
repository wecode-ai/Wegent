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

from app.models.resource_member import MemberStatus, ResourceMember
from app.services.share.external_entity_resolver import IExternalEntityResolver

logger = logging.getLogger(__name__)


class NamespaceEntityResolver(IExternalEntityResolver):
    """Resolves namespace entity bindings using ResourceMember membership.

    For a given user, this resolver checks if the user is a member of
    the namespaces specified in entity_ids by querying ResourceMember
    records with resource_type='Namespace' and entity_type='user'.
    """

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> Optional[str]:
        if entity_type != "namespace":
            return None

        if not entity_ids:
            return None

        # Convert entity_ids to int for namespace ID comparison
        namespace_ids = []
        for eid in entity_ids:
            try:
                namespace_ids.append(int(eid))
            except (ValueError, TypeError):
                continue

        if not namespace_ids:
            return None

        # Check if user is a member of any of the specified namespaces
        membership = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == "Namespace",
                ResourceMember.resource_id.in_(namespace_ids),
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .first()
        )

        if membership:
            logger.info(
                f"User user_id={user_id} matched namespace "
                f"namespace_id={membership.resource_id} via NamespaceEntityResolver"
            )
            return membership.get_effective_role() or "Reporter"

        return None

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
                ResourceMember.resource_type == "Namespace",
                ResourceMember.entity_type == "user",
                ResourceMember.entity_id == str(user_id),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        ns_ids = [r.resource_id for r in user_namespace_ids]
        if not ns_ids:
            return []

        # Find all resource_members referencing those namespaces
        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.entity_type == "namespace",
                ResourceMember.entity_id.in_([str(nid) for nid in ns_ids]),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return list(set(r.resource_id for r in results))


namespace_entity_resolver = NamespaceEntityResolver()

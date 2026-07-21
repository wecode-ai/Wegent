# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
External entity resolver interface for resource permissions.

Defines the IExternalEntityResolver interface that handles entity_type
bindings not natively supported by the core system (e.g., 'namespace').
Implementations are registered via register_entity_resolver().

The open-source core ships with no implementations. Internal deployments
(e.g., wecode) provide concrete resolvers via the registration function.
"""

import logging
from abc import ABC, abstractmethod
from typing import Optional

from sqlalchemy.orm import Session

from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType

logger = logging.getLogger(__name__)

# Module-level resolver registry
_external_entity_resolvers: dict[str, type["IExternalEntityResolver"]] = {}
_resolver_instances: dict[str, "IExternalEntityResolver"] = {}


def register_entity_resolver(
    entity_type: str, resolver_cls: type["IExternalEntityResolver"]
) -> None:
    """Register an external entity resolver for a specific entity type.

    Args:
        entity_type: The entity type to handle (e.g., 'namespace')
        resolver_cls: The resolver class implementing IExternalEntityResolver
    """
    _external_entity_resolvers[entity_type] = resolver_cls
    _resolver_instances.pop(entity_type, None)  # Clear cached instance
    logger.info(
        f"Registered external entity resolver for type='{entity_type}': "
        f"{resolver_cls.__name__}"
    )


def get_entity_resolver(
    entity_type: str, **init_kwargs: object
) -> Optional["IExternalEntityResolver"]:
    """Get a resolver instance for the given entity type.

    Args:
        entity_type: The entity type to get a resolver for
        **init_kwargs: Additional arguments to pass to resolver constructor
            (e.g., entity_type for resolvers that need to know their type)

    Returns:
        An IExternalEntityResolver instance, or None if no resolver is registered
    """
    if entity_type in _resolver_instances:
        return _resolver_instances[entity_type]

    cls = _external_entity_resolvers.get(entity_type)
    if cls:
        instance = cls(**init_kwargs)
        _resolver_instances[entity_type] = instance
        return instance
    return None


def get_all_entity_types() -> list[str]:
    """Get all registered external entity types.

    Returns:
        List of entity type strings
    """
    return list(_external_entity_resolvers.keys())


class IExternalEntityResolver(ABC):
    """Interface for resolving external entity permissions.

    Handles entity_type bindings that are not natively supported by the
    core permission system. The core system calls these resolvers when
    it encounters resource_member records with matching entity types.

    Typical flow:
    1. Permission check finds ResourceMember with entity_type='namespace'
    2. Core calls resolver.match_entity_bindings() to check user membership
    3. If matched, the binding's role is applied
    """

    @abstractmethod
    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        """Determine which entity bindings match the user.

        Args:
            db: Database session
            user_id: User ID to check
            entity_type: Type of entity (e.g., 'namespace')
            entity_ids: List of entity IDs to check against
            user_context: Optional user profile data to avoid re-fetching

        Returns:
            List of entity IDs from entity_ids that the user matches.
            Empty list if no bindings match.
            The actual permission role is stored on the ResourceMember record.
        """
        ...

    @property
    def requires_display_name_snapshot(self) -> bool:
        """Return True if display names should be persisted as snapshots.

        When False, the share service will prefer live resolver lookups over
        persisted entity_display_name snapshots. Override to False for entity
        types that are reliably resolvable from local data (e.g., namespace).
        """
        return True

    def get_display_name(self, db: Session, entity_id: str) -> Optional[str]:
        """Optional: resolve display name for entity-type members.

        Called by share services when rendering member lists to resolve
        human-readable names for entity-type members (e.g., department names).

        Args:
            db: Database session
            entity_id: Entity identifier

        Returns:
            Display name string or None if not resolvable
        """
        return None

    def batch_get_display_names(
        self, db: Session, entity_ids: list[str]
    ) -> dict[str, str]:
        """Batch resolve display names for multiple entity IDs.

        Default implementation falls back to individual get_display_name calls.
        Subclasses should override this when the underlying API supports true
        batch resolution to avoid N+1 queries.

        Args:
            db: Database session
            entity_ids: List of entity identifiers

        Returns:
            Mapping of entity_id -> display name for resolvable IDs
        """
        result: dict[str, str] = {}
        for eid in entity_ids:
            name = self.get_display_name(db, eid)
            if name:
                result[eid] = name
        return result

    def validate_entity_id(self, db: Session, entity_id: str) -> bool:
        """Validate that the given entity ID exists in the external system.

        Default implementation returns True (no validation).
        Subclasses (e.g., ErpEntityResolver) can override to verify
        entity existence via external APIs.

        Args:
            db: Database session
            entity_id: Entity identifier to validate

        Returns:
            True if entity exists, False otherwise
        """
        return True

    def get_user_entities(
        self, db: Session, user_id: int, entity_type: str
    ) -> list[str]:
        """Get all entity IDs that the user is affiliated with.

        Default implementation returns an empty list.
        Subclasses can override when the external API supports
        listing all affiliations for a user (optimization path).

        Args:
            db: Database session
            user_id: User ID
            entity_type: Entity type to resolve

        Returns:
            List of entity IDs the user matches
        """
        return []

    @abstractmethod
    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        resource_type: str = ResourceType.KNOWLEDGE_BASE.value,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        """Get resource IDs accessible to user via entity binding.

        Used for list operations: find all resources where any
        resource_member record matches a user's entity affiliations.

        Args:
            db: Database session
            user_id: User ID
            entity_type: Entity type to resolve
            resource_type: Resource type to filter (default: KnowledgeBase)
            user_context: Optional user profile data

        Returns:
            List of resource IDs accessible via this entity type
        """
        ...


def list_resources_by_entity_match(
    db: Session,
    resource_type: str,
    entity_type: str,
    matched_entity_ids: list[str],
) -> list[int]:
    """Query resource_ids from ResourceMember by entity match.

    This is a shared utility used by all resolver implementations
    to avoid duplicating the same SQL logic.

    Args:
        db: Database session
        resource_type: Resource type filter (e.g., 'Namespace', 'KnowledgeBase')
        entity_type: Entity type filter (e.g., 'org_department')
        matched_entity_ids: List of entity IDs that matched the user

    Returns:
        List of distinct resource_ids
    """
    if not matched_entity_ids:
        return []

    rows = (
        db.query(ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == resource_type,
            ResourceMember.entity_type == entity_type,
            ResourceMember.entity_id.in_(matched_entity_ids),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .distinct()
        .all()
    )
    return [r[0] for r in rows]


def resolve_entity_roles_for_resource(
    db: Session,
    resource_type: str | list[str],
    resource_id: int,
    user_id: int,
    status: str | list[str] | None = None,
    exclude_entity_types: list[str] | None = None,
) -> list[str]:
    """Resolve entity-derived role strings for a user on a specific resource.

    Queries entity-type ResourceMember rows, groups by entity_type, calls
    registered resolvers' match_entity_bindings, and returns all matched
    role strings.  Callers can take the highest role themselves.

    Args:
        db: Database session
        resource_type: Resource type(s) to filter
        resource_id: Resource ID
        user_id: User ID
        status: Status value(s) to filter. Defaults to APPROVED.
        exclude_entity_types: Additional entity types to exclude
            (defaults to ['user', ''])

    Returns:
        List of role strings from matched entity bindings
    """
    from collections import defaultdict

    if status is None:
        status = MemberStatus.APPROVED.value

    resource_types = (
        [resource_type] if isinstance(resource_type, str) else resource_type
    )
    statuses = [status] if isinstance(status, str) else status
    excludes = set(exclude_entity_types or [])
    excludes.update({"user", ""})

    entity_rows = (
        db.query(
            ResourceMember.entity_type,
            ResourceMember.entity_id,
            ResourceMember.role,
        )
        .filter(
            ResourceMember.resource_type.in_(resource_types),
            ResourceMember.resource_id == resource_id,
            ResourceMember.entity_type.notin_(list(excludes)),
            ResourceMember.entity_id.isnot(None),
            ResourceMember.status.in_(statuses),
        )
        .all()
    )

    if not entity_rows:
        return []

    entity_groups: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
    for et, eid, role in entity_rows:
        if et and eid:
            entity_groups[et].append((eid, role))

    matched_roles = []
    for entity_type_str, entries in entity_groups.items():
        resolver = get_entity_resolver(entity_type_str)
        if not resolver:
            continue
        eids = [eid for eid, _ in entries]
        matched = resolver.match_entity_bindings(db, user_id, entity_type_str, eids)
        if not matched:
            continue
        role_by_eid = {eid: role for eid, role in entries}
        for eid in matched:
            role = role_by_eid.get(eid)
            if role:
                matched_roles.append(role)

    return matched_roles

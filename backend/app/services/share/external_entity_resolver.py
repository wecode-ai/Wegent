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

logger = logging.getLogger(__name__)

# Module-level resolver registry
_external_entity_resolvers: dict[str, type["IExternalEntityResolver"]] = {}


def register_entity_resolver(
    entity_type: str, resolver_cls: type["IExternalEntityResolver"]
) -> None:
    """Register an external entity resolver for a specific entity type.

    Args:
        entity_type: The entity type to handle (e.g., 'namespace')
        resolver_cls: The resolver class implementing IExternalEntityResolver
    """
    _external_entity_resolvers[entity_type] = resolver_cls
    logger.info(
        f"Registered external entity resolver for type='{entity_type}': "
        f"{resolver_cls.__name__}"
    )


def get_entity_resolver(entity_type: str) -> Optional["IExternalEntityResolver"]:
    """Get a resolver instance for the given entity type.

    Args:
        entity_type: The entity type to get a resolver for

    Returns:
        An IExternalEntityResolver instance, or None if no resolver is registered
    """
    cls = _external_entity_resolvers.get(entity_type)
    if cls:
        return cls()
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
    ) -> Optional[str]:
        """Determine if a user matches any of the given entity bindings.

        Args:
            db: Database session
            user_id: User ID to check
            entity_type: Type of entity (e.g., 'namespace')
            entity_ids: List of entity IDs to check against
            user_context: Optional user profile data to avoid re-fetching

        Returns:
            Role string (e.g., 'Reporter') if user matches, None otherwise
        """
        ...

    @abstractmethod
    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        """Get resource IDs accessible to user via entity binding.

        Used for list operations: find all resources where any
        resource_member record matches a user's entity affiliations.

        Args:
            db: Database session
            user_id: User ID
            entity_type: Entity type to resolve
            user_context: Optional user profile data

        Returns:
            List of resource IDs accessible via this entity type
        """
        ...

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User mapping interface for DingTalk integration.

Provides an abstract interface for mapping DingTalk users to Wegent users.
The open-source version provides a default (empty) implementation.
Internal deployments can register custom mappers for enterprise user mapping.
"""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

__all__ = [
    "MappedUserInfo",
    "BaseUserMapper",
    "DefaultUserMapper",
    "ERPUserMapper",
    "get_user_mapper",
    "set_user_mapper",
]

logger = logging.getLogger(__name__)


@dataclass
class MappedUserInfo:
    """
    Mapped user information from external user mapping service.

    This contains the essential user information needed to find or create
    a Wegent user from a DingTalk user.
    """

    user_name: str
    email: Optional[str] = None
    display_name: Optional[str] = None


class BaseUserMapper(ABC):
    """
    Abstract base class for user mapping.

    Implementations should map DingTalk user identifiers (staff_id, sender_id)
    to Wegent user information.
    """

    @abstractmethod
    async def map_user(
        self,
        staff_id: str,
        sender_id: Optional[str] = None,
        sender_nick: Optional[str] = None,
    ) -> Optional[MappedUserInfo]:
        """
        Map a DingTalk user to Wegent user information.

        Args:
            staff_id: Employee staff ID
            sender_id: DingTalk user ID (optional)
            sender_nick: User's nickname (optional)

        Returns:
            MappedUserInfo if mapping successful, None otherwise
        """
        pass


class DefaultUserMapper(BaseUserMapper):
    """
    Default (empty) user mapper implementation.

    This is the open-source default that returns None, indicating
    that no external user mapping is available. The DingTalkUserResolver
    will fall back to its default behavior when this mapper returns None.

    Internal deployments can register a custom mapper via set_user_mapper()
    to integrate with enterprise user directories (ERP, LDAP, etc.).
    """

    async def map_user(
        self,
        staff_id: str,  # noqa: ARG002
        sender_id: Optional[str] = None,  # noqa: ARG002
        sender_nick: Optional[str] = None,  # noqa: ARG002
    ) -> Optional[MappedUserInfo]:
        """
        Default implementation returns None.

        Override in internal deployments to provide enterprise user mapping.
        """
        # Default mapper does not perform any mapping
        # Parameters are kept for interface compatibility
        return None


# Global user mapper instance
_user_mapper: Optional[BaseUserMapper] = None


def get_user_mapper() -> BaseUserMapper:
    """
    Get the current user mapper instance.

    Returns:
        The registered user mapper, or DefaultUserMapper if none registered
    """
    global _user_mapper
    if _user_mapper is None:
        _user_mapper = DefaultUserMapper()
    return _user_mapper


def set_user_mapper(mapper: BaseUserMapper) -> None:
    """
    Register a custom user mapper.

    This should be called during application startup by internal deployments
    to register their custom user mapping implementation.

    Args:
        mapper: Custom BaseUserMapper implementation
    """
    global _user_mapper
    _user_mapper = mapper
    logger.info(
        "[UserMapper] Registered user mapper: %s",
        type(mapper).__name__,
    )

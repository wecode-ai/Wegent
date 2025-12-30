# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Whitelist service module.

This module provides a pluggable whitelist service for filtering tasks
based on user whitelist status. By default, a no-op implementation is used
which means no filtering is applied.

Usage:
    # Get the current whitelist service
    from app.services.whitelist import get_whitelist_service
    service = get_whitelist_service()

    # Check if a user is whitelisted
    is_whitelisted = await service.is_user_whitelisted(user_id)

    # Register a custom implementation
    from app.services.whitelist import set_whitelist_service
    set_whitelist_service(MyCustomWhitelistService())
"""

from typing import Optional

from app.services.whitelist.base import WhitelistService
from app.services.whitelist.default import DefaultWhitelistService

# Global whitelist service instance
_whitelist_service: Optional[WhitelistService] = None


def get_whitelist_service() -> WhitelistService:
    """
    Get the current whitelist service instance.

    Returns:
        The current whitelist service. If no custom service has been set,
        returns the default no-op implementation.
    """
    global _whitelist_service
    if _whitelist_service is None:
        _whitelist_service = DefaultWhitelistService()
    return _whitelist_service


def set_whitelist_service(service: WhitelistService) -> None:
    """
    Set a custom whitelist service implementation.

    Args:
        service: The whitelist service implementation to use.
    """
    global _whitelist_service
    _whitelist_service = service


__all__ = [
    "WhitelistService",
    "DefaultWhitelistService",
    "get_whitelist_service",
    "set_whitelist_service",
]

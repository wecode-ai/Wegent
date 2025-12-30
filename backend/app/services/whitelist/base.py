# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Abstract base class for whitelist service.

This module defines the interface for whitelist checking functionality.
Implementations can check users against various whitelist sources
(database, configuration, external API, etc.).
"""

from abc import ABC, abstractmethod


class WhitelistService(ABC):
    """Abstract base class for whitelist service"""

    @abstractmethod
    async def is_user_whitelisted(self, user_id: int) -> bool:
        """
        Check if a user is in the whitelist.

        Args:
            user_id: The user ID to check

        Returns:
            True if user is in whitelist, False otherwise
        """
        pass

    @abstractmethod
    def is_implemented(self) -> bool:
        """
        Check if the whitelist service is implemented.

        Returns:
            True if implemented, False otherwise.
            When False, no filtering will be applied.
        """
        pass

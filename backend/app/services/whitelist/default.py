# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Default whitelist service implementation.

This is a no-op implementation that indicates the whitelist feature
is not enabled. When this service is used, no filtering will be applied.
"""

from app.services.whitelist.base import WhitelistService


class DefaultWhitelistService(WhitelistService):
    """Default whitelist service - not implemented"""

    async def is_user_whitelisted(self, user_id: int) -> bool:
        """Always returns False as whitelist is not implemented"""
        return False

    def is_implemented(self) -> bool:
        """Returns False as this is the default non-implementation"""
        return False

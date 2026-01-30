# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Internal DingTalk user mapper implementation.

This module provides enterprise user mapping using the ERP API to resolve
DingTalk staff_id (工号) to Wegent user information.

This is an internal implementation that should be placed in the internal
code repository. It integrates with the open-source user mapping interface.
"""

import logging
from typing import Optional

from app.core.cache import cache_manager
from app.services.channels.dingtalk.user_mapping import (
    BaseUserMapper,
    MappedUserInfo,
)
from dingtalk.services.dingtalk_service import dingtalk_service

logger = logging.getLogger(__name__)

# Cache key prefix and TTL for staff_id -> user_name mapping
STAFF_USER_CACHE_PREFIX = "dingtalk:staff_user:"
STAFF_USER_CACHE_TTL = 86400  # 24 hours


class ERPUserMapper(BaseUserMapper):
    """
    Enterprise user mapper using ERP API.

    This mapper resolves DingTalk staff_id (工号) to Wegent user information
    by querying the ERP API for employee email, then extracting the username
    from the email prefix. Results are cached in Redis for performance.
    """

    async def map_user(
        self,
        staff_id: str,
        sender_id: Optional[str] = None,
        sender_nick: Optional[str] = None,
    ) -> Optional[MappedUserInfo]:
        """
        Map a DingTalk user to Wegent user information via ERP API.

        Resolution flow:
        1. Check Redis cache for staff_id -> user info mapping
        2. If not cached, query ERP API for employee email
        3. Extract username from email prefix (before @)
        4. Cache the result and return MappedUserInfo

        Args:
            staff_id: Employee staff ID (工号)
            sender_id: DingTalk user ID (not used)
            sender_nick: User's nickname (not used)

        Returns:
            MappedUserInfo if mapping successful, None otherwise
        """
        if not staff_id:
            logger.debug("[ERPUserMapper] staff_id is required but not provided")
            return None

        # Try to get cached mapping
        cache_key = f"{STAFF_USER_CACHE_PREFIX}{staff_id}"
        cached_user_name = await cache_manager.get(cache_key)

        if cached_user_name:
            logger.debug(
                "[ERPUserMapper] Cache hit: staff_id=%s -> user_name=%s",
                staff_id,
                cached_user_name,
            )
            # For cached entries, we only have user_name, not email
            return MappedUserInfo(user_name=cached_user_name)

        # Query ERP API for employee email
        try:
            employee_email = await dingtalk_service.get_employee_email(staff_id)
        except Exception as e:
            logger.error(
                "[ERPUserMapper] Failed to query ERP API: staff_id=%s, error=%s",
                staff_id,
                e,
            )
            return None

        if not employee_email:
            logger.warning(
                "[ERPUserMapper] No email found for staff_id=%s",
                staff_id,
            )
            return None

        # Extract username from email prefix (before @)
        user_name = employee_email.split("@")[0]

        # Cache the mapping
        await cache_manager.set(cache_key, user_name, expire=STAFF_USER_CACHE_TTL)
        logger.info(
            "[ERPUserMapper] Cached mapping: staff_id=%s -> user_name=%s (email=%s)",
            staff_id,
            user_name,
            employee_email,
        )

        return MappedUserInfo(
            user_name=user_name,
            email=employee_email,
        )
